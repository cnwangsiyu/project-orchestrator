"""Blocking-review regressions; RES_FIX_SOURCE selects an archived baseline."""
import argparse
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
import shutil
from unittest.mock import patch

SOURCE=Path(os.environ.get("RES_FIX_SOURCE",Path(__file__).resolve().parents[2]))
sys.path.insert(0,str(SOURCE/"res"))
import local_control as local
import mini2_control as mini


def migration(kind):
    spec=importlib.util.spec_from_file_location(kind+"_migration",SOURCE/(kind+"-host-migrate.py"))
    value=importlib.util.module_from_spec(spec); spec.loader.exec_module(value)
    return value


class DynamicFixTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name)
        self.original=("heavy-build\tslot\topen\t-\tFull build\n"+
                       "".join(f"heavy-lane-{i}\tslot\topen\t-\tLocal lane\n" for i in range(1,4))+
                       mini.ROW.replace("\tnever\t","\topen\t").rstrip()+" caps=cmake-native slots=1\n").encode()
        (self.root/"resources.tsv").write_bytes(self.original)
        (self.root/"machine.conf").write_text("# original fixture\n")
        self.config={**mini.DEFAULT,"enabled":True,"load5Limit":"derived","minAvailableGiB":"derived"}
        mini.atomic(self.root/"mini2-config.json",self.config)
        mini.atomic(self.root/"mini2-link.json",dict(at=time.time(),link="UP",maintenance=False))
        mini.atomic(self.root/"mini2-facts.json",dict(at=time.time(),host=mini.HOST,caps=["cmake-native"]))
        self.sample=dict(at=time.time(),host=os.uname().nodename,cores=14,totalGiB=64,load5=0,
                         availableGiB=64,freeGiB=1000,pressure=1,swapGiB=0,compressorGiB=0)
        mini.atomic(self.root/"sample.json",self.sample)
        mini.atomic(self.root/"mini2-metrics.json",{**self.sample,"host":mini.HOST,"cores":10,"totalGiB":32,"availableGiB":32,"arch":"arm64"})
        self.env={**os.environ,"RES_DIR":str(self.root),"RES_TEST_LOCAL_SAMPLE":str(self.root/"sample.json")}

    def activate(self,kind):
        module=migration(kind); file=self.root/"resources.tsv"
        file.write_bytes(module.migrate(file.read_bytes()))

    def args(self,by):
        checkout=self.root/by; checkout.mkdir(exist_ok=True)
        return ["--by",by,"--project",by,"--task","fixture","--for","fixture","--pid",str(os.getpid()),"--checkout",str(checkout)]

    def cli(self,*args):
        return subprocess.run([str(SOURCE/"res/res"),*args],env=self.env,capture_output=True,text=True,timeout=10)

    def claim(self,by,action="take-build"):
        result=self.cli(action,*self.args(by),"--wrapper")
        self.assertEqual(result.returncode,0,result.stderr)
        values=dict(line.split("=",1) for line in result.stdout.splitlines() if "=" in line)
        id=values.get("build-id",values.get("lane"))
        file=self.root/"locks"/(id+".d")/"lease.json"
        return file,mini.read(file)

    def run_migration(self,kind,root=None,action="--apply",module=None,process_table=""):
        module=module or migration(kind); root=root or self.root
        check_output=mini.subprocess.check_output
        def processes(command,*args,**kwargs):
            if command==["/bin/ps","-axww","-o","pid=,args="]: return process_table
            return check_output(command,*args,**kwargs)
        table=patch.object(mini.subprocess,"check_output",side_effect=processes) if process_table is not None else contextlib.nullcontext()
        with table,patch.object(sys,"argv",[str(SOURCE/(kind+"-host-migrate.py")),"--registry",str(root/"resources.tsv"),*([action] if action else [])]),contextlib.redirect_stdout(io.StringIO()):
            module.main()

    def test_unbound_memory_credit_cannot_break_the_reserve_floor(self):
        self.activate("local")
        leases=[self.claim(name)[1] for name in ("first","second")]
        usages={lease["runId"]:dict(at=time.time(),memoryGiB=8,cpuLoad=0,generation=lease["generation"],workloadPid=123,workloadBirth=456) for lease in leases}
        mini.atomic(self.root/"sample.json",{**self.sample,"at":time.time(),"availableGiB":24,"leaseUsage":usages})
        result=self.cli("take-build",*self.args("third"),"--wrapper")
        self.assertNotEqual(result.returncode,0,"unrelated memory cannot erase two declared 8 GiB peaks")
        self.assertIn("memory",result.stderr)
        capacity=json.loads(self.cli("pool-capacity","local").stdout)[os.uname().nodename]
        self.assertEqual(capacity["reserved"],[8,16,32])
        self.assertGreaterEqual(24-capacity["reserved"][1],capacity["memoryFloorGiB"])

    def test_usage_is_bound_to_a_new_workload_generation_not_the_holder_tree(self):
        lease=dict(pid=100,pid_start="holder",runId="run",generation="generation",dispatch="bound",
                   start=1,creditAfter=50,workload=dict(pid=102,birth=60))
        rows="100 1 0 0\n101 100 0 100\n102 100 0 100\n103 102 0 100\n104 102 0 100\n105 100 0 100\n"
        births={100:1,101:20,102:60,103:70,104:30,105:80}
        with patch.object(local,"claims",return_value=[(None,lease)]),patch.object(local,"process_clock",return_value=100),patch.object(local.subprocess,"check_output",return_value=rows),patch.object(local,"process_start",return_value="holder"),patch.object(local,"process_birth",side_effect=births.get,create=True),patch.object(local,"physical_footprint",return_value=4*2**30) as footprint:
            value=local.usage(self.root,dict(at=100))["run"]
            self.assertEqual(value["memoryGiB"],8,"exclude holder, old descendants, reparented old children and unrelated new siblings")
            self.assertEqual({call.args[0] for call in footprint.call_args_list},{102,103})
            lease["dispatch"]="unbound"
            self.assertEqual(local.usage(self.root,dict(at=100)),{})
            lease["dispatch"]="bound"; births[102]=90
            self.assertEqual(local.usage(self.root,dict(at=100)),{},"PID reuse cannot transfer workload credit")

    def test_partial_credit_leaves_the_remaining_declared_peak_reserved(self):
        self.activate("local")
        leases=[]
        for name in ("first","second"):
            file,lease=self.claim(name)
            lease.update(dispatch="bound",workload=dict(pid=123,birth=456))
            mini.atomic(file,lease); leases.append(lease)
        usages={lease["runId"]:dict(at=time.time(),memoryGiB=amount,cpuLoad=0,generation=lease["generation"],workloadPid=123,workloadBirth=456) for lease,amount in zip(leases,(4,2))}
        mini.atomic(self.root/"sample.json",{**self.sample,"at":time.time(),"availableGiB":25,"leaseUsage":usages})
        capacity=json.loads(self.cli("pool-capacity","local").stdout)[os.uname().nodename]
        self.assertEqual(capacity["reserved"][1]+6,16)
        result=self.cli("take-build",*self.args("third"),"--wrapper")
        self.assertNotEqual(result.returncode,0)
        self.assertIn("memory",result.stderr)

    def test_descendant_reuse_with_shared_parent_keeps_the_reserve_floor(self):
        self.activate("local")
        leases=[]
        for name,pid in (("first",102),("second",105)):
            file,lease=self.claim(name)
            lease.update(dispatch="bound",creditAfter=50,workload=dict(pid=pid,birth=60))
            mini.atomic(file,lease); leases.append(lease)
        rows=f"{os.getpid()} 1 0 0\n102 {os.getpid()} 0 0\n103 102 0 0\n105 {os.getpid()} 0 0\n"
        births={102:60,103:70,105:60}
        def snapshot(*args,**kwargs):
            births[103]=110  # The snapshotted child exits; an unrelated process reuses its PID.
            return rows
        sample={**self.sample,"at":time.time(),"availableGiB":24}
        with patch.object(local,"process_clock",return_value=100),patch.object(local.subprocess,"check_output",side_effect=snapshot),patch.object(local,"process_birth",side_effect=births.get),patch.object(local,"physical_footprint",side_effect=lambda pid:8*2**30 if pid==103 else 0) as footprint:
            sample["leaseUsage"]=local.usage(self.root,sample)
        self.assertNotIn(103,{call.args[0] for call in footprint.call_args_list})
        mini.atomic(self.root/"sample.json",sample)
        capacity=json.loads(self.cli("pool-capacity","local").stdout)[os.uname().nodename]
        self.assertEqual(capacity["reserved"][1],16)
        self.assertGreaterEqual(24-capacity["reserved"][1],capacity["memoryFloorGiB"])
        result=self.cli("take-build",*self.args("third"),"--wrapper")
        self.assertNotEqual(result.returncode,0,"replacement memory cannot fund a third declared peak")
        self.assertIn("memory",result.stderr)

    def test_descendant_generation_must_prove_every_ancestry_edge(self):
        lease=dict(pid=100,pid_start="holder",runId="run",generation="generation",dispatch="bound",
                   start=1,creditAfter=50,workload=dict(pid=102,birth=60))
        rows="100 1 0 0\n102 100 0 0\n103 102 0 0\n104 103 0 0\n"
        for changed in (None,110):
            for during_sample in (False,True):
                with self.subTest(changed=changed,during_sample=during_sample):
                    births={102:60,103:70,104:80}
                    def snapshot(*args,**kwargs):
                        if not during_sample: births[103]=changed
                        return rows
                    def footprint(pid):
                        if during_sample: births[103]=changed
                        return 4*2**30 if pid==104 else 0
                    with patch.object(local,"claims",return_value=[(None,lease)]),patch.object(local,"process_clock",return_value=100),patch.object(local.subprocess,"check_output",side_effect=snapshot),patch.object(local,"process_start",return_value="holder"),patch.object(local,"process_birth",side_effect=births.get),patch.object(local,"physical_footprint",side_effect=footprint):
                        self.assertEqual(local.usage(self.root,dict(at=100))["run"]["memoryGiB"],0)
        with patch.object(local,"process_clock",return_value=None),patch.object(local,"claims",return_value=[(None,lease)]),patch.object(local.subprocess,"check_output",return_value=rows),patch.object(local,"process_start",return_value="holder"),patch.object(local,"process_birth",return_value=60),patch.object(local,"physical_footprint",return_value=4*2**30):
            self.assertEqual(local.usage(self.root,dict(at=100)),{},"unavailable snapshot time gives no credit")

    def test_legacy_named_waiters_survive_interpreter_and_env_flags(self):
        wrappers=("bash", "bash -e", "/bin/bash -eu", "sh -eux", "/bin/zsh -f",
                  "bash -o pipefail -e", "env bash -e", "/usr/bin/env -i FIXTURE=1 /bin/sh -eu",
                  "env -u FIXTURE /bin/zsh -e", "env --chdir=/tmp /bin/bash --noprofile -eu",
                  "env -S 'bash -eu'", "/usr/bin/python3 -B -u")
        for kind,script,tail in (("local","res","wait heavy-lane-1"),("local","local_control.py","wait-lane"),
                                 ("mini2","res","wait mini2-exec-1"),("mini2","mini2_control.py","wait mini2-exec-1")):
            for wrapper in wrappers:
                with self.subTest(kind=kind,wrapper=wrapper,script=script):
                    root=self.root/f"waiter-{kind}-{script}-{wrappers.index(wrapper)}"; root.mkdir()
                    (root/"resources.tsv").write_bytes(self.original)
                    (root/"machine.conf").write_text("# owner settings\n")
                    mini.atomic(root/"mini2-config.json",self.config)
                    table=f"999991 {wrapper} /legacy/{script} {tail} --pid 999992\n"
                    with patch.object(mini.subprocess,"check_output",return_value=table):
                        with self.assertRaisesRegex(ValueError,"999991.*restart"):
                            self.run_migration(kind,root,process_table=None)
                    self.assertEqual((root/"resources.tsv").read_bytes(),self.original)
                    self.assertFalse(list(root.glob("resources.tsv.pre-*-dynamic*")))

    def test_unclassifiable_allocator_shaped_commands_fail_closed(self):
        commands=("bash -c '/legacy/res wait heavy-lane-1'", "env --unknown /legacy/res wait mini2-exec-1",
                  "opaque-wrapper /legacy/local_control.py wait-lane", "bash -e /legacy/res wait heavy-lane-1 '",
                  "zsh -c '/legacy/mini2_control.py wait mini2-exec-1'", "bash --unknown /legacy/res status",
                  "bash -Z /legacy/res status", "bash -eu /legacy/res unknown heavy-lane-1", "/legacy/res wait",
                  "bash -c 'res unknown heavy-lane-1'", "bash -ec 'res $ACTION heavy-lane-1'")
        for kind in ("local","mini2"):
            for command in commands:
                with self.subTest(kind=kind,command=command),patch.object(mini.subprocess,"check_output",return_value="999991 "+command+"\n"):
                    with self.assertRaisesRegex(ValueError,"999991.*restart"): self.run_migration(kind,action="",process_table=None)
        for command in ("bash -eu /legacy/res status local", "env -i /legacy/res pool-capacity mini2",
                        "/bin/sh -e /legacy/res return heavy-lane-1", "echo unrelated",
                        "node worker --brief 'local_control.py ~98 and mini2_control.py ~76'",
                        "node worker --brief local_control.py ~98 and mini2_control.py ~76"):
            with patch.object(mini.subprocess,"check_output",return_value="999991 "+command+"\n"):
                self.assertEqual(mini.allocator_processes("local"),[])
                self.assertEqual(mini.allocator_processes("mini2"),[])

    def test_interrupted_presence_publication_never_changes_untouched_config(self):
        module=migration("local")
        config=self.root/"machine.conf"; original_config=module.configure(b"# owner settings\n")
        config.write_bytes(original_config)
        marker=self.root/"resources.tsv.pre-local-dynamic.machine-existed"
        opened=Path.open
        def interrupt(file,*args,**kwargs):
            if file.name.startswith(marker.name) and args and args[0]=="xb":
                with opened(file,*args,**kwargs): pass
                raise OSError("interrupted presence publication")
            return opened(file,*args,**kwargs)
        with patch.object(Path,"open",interrupt):
            with self.assertRaisesRegex(OSError,"interrupted"): self.run_migration("local",module=module)
        self.assertEqual(config.read_bytes(),original_config)
        try: self.run_migration("local",action="--rollback")
        except (ValueError,OSError): pass
        self.assertTrue(config.exists(),"rollback must not delete untouched owner settings")
        self.assertEqual(config.read_bytes(),original_config)
        self.assertEqual((self.root/"resources.tsv").read_bytes(),self.original)
        self.assertFalse(marker.exists(),"an interrupted write must not publish an empty marker")

    def test_rollback_validates_the_entire_backup_set_before_writing(self):
        module=migration("local"); config=self.root/"machine.conf"
        original_config=module.configure(b"# owner settings\n"); config.write_bytes(original_config)
        registry=self.root/"resources.tsv"; registry.write_bytes(module.migrate(self.original))
        backup=self.root/"resources.tsv.pre-local-dynamic"; backup.write_bytes(self.original)
        config_backup=backup.with_name(backup.name+".machine"); config_backup.write_bytes(original_config)
        marker=backup.with_name(backup.name+".machine-existed")
        for value in (b"",b"2",b"1\n",b"true",b"\0",b"0"):
            with self.subTest(marker=value):
                registry.write_bytes(module.migrate(self.original)); config.write_bytes(original_config)
                marker.write_bytes(value)
                before=(registry.read_bytes(),config.read_bytes())
                with patch.object(module.m,"atomic") as atomic:
                    with self.assertRaises(ValueError): self.run_migration("local",action="--rollback",module=module)
                    atomic.assert_not_called()
                self.assertTrue(config.exists())
                self.assertEqual((registry.read_bytes(),config.read_bytes()),before)
        marker.write_bytes(b"1"); config_backup.unlink()
        with patch.object(module.m,"atomic") as atomic:
            with self.assertRaises((ValueError,OSError)): self.run_migration("local",action="--rollback",module=module)
            atomic.assert_not_called()

    def test_backup_publication_interruptions_are_atomic_for_both_migrations(self):
        for kind in ("local","mini2"):
            for boundary in (1,2,3) if kind=="local" else (1,2):
                for after in (False,True):
                    with self.subTest(kind=kind,boundary=boundary,after=after):
                        root=self.root/f"backup-{kind}-{boundary}-{after}"; root.mkdir()
                        registry=root/"resources.tsv"; registry.write_bytes(self.original)
                        module=migration(kind); owner=module.m if kind=="local" else module
                        config=root/("machine.conf" if kind=="local" else "mini2-config.json")
                        original_config=module.configure(b"# owner settings\n") if kind=="local" else json.dumps(self.config).encode()
                        config.write_bytes(original_config)
                        replace=os.replace; count=0
                        def interrupt(source,dest):
                            nonlocal count
                            if ".pre-" in Path(dest).name:
                                count+=1
                                if count==boundary and not after: raise OSError("interrupted backup rename")
                                replace(source,dest)
                                if count==boundary and after: raise OSError("interrupted backup rename")
                            else: replace(source,dest)
                        with patch.object(owner.os,"replace",side_effect=interrupt):
                            with self.assertRaises(OSError): self.run_migration(kind,root,module=module)
                        self.assertEqual(registry.read_bytes(),self.original)
                        self.assertEqual(config.read_bytes(),original_config)
                        try: self.run_migration(kind,root,"--rollback")
                        except (ValueError,OSError): pass
                        self.assertEqual(registry.read_bytes(),self.original)
                        self.assertEqual(config.read_bytes(),original_config)
                        self.assertFalse([p for p in root.glob("*.mini2-*") if p.suffix!=".guard"])

    def test_local_migration_refuses_legacy_waiters_and_mid_transactions(self):
        for location in ("build-waiters/waiter.review/info","lane-waiters/waiter.review/info",".build-admission.lock"):
            with self.subTest(location=location):
                (self.root/"resources.tsv").write_bytes(self.original)
                (self.root/"machine.conf").write_text("# original fixture\n")
                for backup in self.root.glob("resources.tsv.pre-local-dynamic*"): backup.unlink()
                file=self.root/location; file.parent.mkdir(parents=True,exist_ok=True)
                file.write_text(str(os.getpid()) if file.name.endswith(".lock") else f"holder\treview\npid\t{os.getpid()}\nhost\t{os.uname().nodename}\n")
                try:
                    with self.assertRaisesRegex(ValueError,"restart") as error: self.run_migration("local")
                    self.assertIn(str(os.getpid()),str(error.exception))
                    self.assertEqual((self.root/"resources.tsv").read_bytes(),self.original)
                    self.assertFalse((self.root/"resources.tsv.pre-local-dynamic").exists())
                finally: file.unlink()

    def test_mini2_migration_refuses_existing_legacy_waiters(self):
        mini.atomic(self.root/"mini2-waiters/review.json",dict(pid=os.getpid(),controller=os.getpid(),host=os.uname().nodename,cost=[1,1,8],need="",bypasses=0))
        with self.assertRaisesRegex(ValueError,"restart") as error: self.run_migration("mini2")
        self.assertIn(str(os.getpid()),str(error.exception))
        self.assertEqual((self.root/"resources.tsv").read_bytes(),self.original)

    def test_allocator_selection_and_transaction_share_the_migration_guard(self):
        self.activate("local")
        process=None
        try:
            with mini.guard(self.root,"local-capacity.guard"):
                process=subprocess.Popen([str(SOURCE/"res/res"),"wait-build",*self.args("waiting"),"--wrapper","--timeout","1"],env=self.env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
                deadline=time.time()+5
                while not list((self.root/"local-waiters").glob("*.json")) and time.time()<deadline: time.sleep(0.02)
                self.assertTrue(list((self.root/"local-waiters").glob("*.json")))
                result=subprocess.run([sys.executable,"-B",str(SOURCE/"local-host-migrate.py"),"--registry",str(self.root/"resources.tsv"),"--apply"],capture_output=True,text=True,timeout=5)
                self.assertNotEqual(result.returncode,0)
                self.assertIn("restart",result.stderr)
                self.assertIn(str(process.pid),result.stderr)
        finally:
            if process:
                process.terminate(); process.communicate(timeout=10)

    def test_an_entrant_cannot_select_legacy_mode_across_a_migration(self):
        self.env.update(RES_TEST_METRICS="1",RES_TEST_LOAD1M="0",RES_TEST_MEMORYSTATUS_LEVEL="100",RES_TEST_MEMSIZE=str(64*2**30),
                        RES_TEST_SWAPUSAGE="total = 0.00M used = 0.00M free = 0.00M",RES_TEST_VM_STAT="Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 1000000.\nPages inactive: 1000000.\nPages speculative: 0.\nPages occupied by compressor: 0.\nPages stored in compressor: 0.\n")
        process=None
        try:
            with mini.guard(self.root,".local-allocator-switch.guard"):
                process=subprocess.Popen([str(SOURCE/"res/res"),"wait-build",*self.args("entrant"),"--timeout","0"],env=self.env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
                time.sleep(0.5)
                self.activate("local")
                for ordinal in (4,5,6):
                    id="heavy-build-"+str(ordinal)
                    lease=dict(by=id,project=id,pid=os.getpid(),pid_start=mini.process_start(os.getpid()),host=os.uname().nodename,dispatch="unbound",controlled=True,
                               generation=id,runId=id,ownerId=id,weights=[4,8,16],baseline=self.sample,build=True,checkout=str(self.root/id),lane=None)
                    mini.atomic(self.root/"locks"/(id+".d")/"lease.json",lease)
            stdout,stderr=process.communicate(timeout=10)
            self.assertNotEqual(process.returncode,0,"a pre-switch legacy entrant cannot add a fourth full build")
            self.assertIn("load",stderr)
            self.assertFalse((self.root/"locks/heavy-build.d").exists())
        finally:
            if process and process.poll() is None: process.terminate(); process.communicate(timeout=10)

    def test_a_migrated_row_never_falls_back_if_the_controller_is_missing(self):
        self.activate("local")
        copy=self.root/"code/res"; copy.parent.mkdir()
        shutil.copy2(SOURCE/"res/res",copy)
        result=subprocess.run([str(copy),"wait-build",*self.args("missing"),"--timeout","0"],env=self.env,capture_output=True,text=True,timeout=10)
        self.assertNotEqual(result.returncode,0)
        self.assertIn("controller unavailable",result.stderr)
        self.assertFalse(list((self.root/"locks").glob("*.d")))

    def test_named_mini2_claim_cannot_reuse_a_pending_generation(self):
        self.activate("mini2")
        args=argparse.Namespace(by="fixture",project="fixture",task="fixture",purpose="fixture",pid=os.getpid(),profile="light",disk_gib=8,timeout=0,qualification="",need="cmake-native",resource="mini2")
        with contextlib.redirect_stdout(io.StringIO()): mini.acquire(self.root,args)
        hold=self.root/"locks"/(mini.SLOT+".d"); lease=mini.read(hold/"lease.json")
        dead=subprocess.Popen(["/usr/bin/true"]); dead.wait()
        mini.atomic(hold/"lease.json",{**lease,"pid":dead.pid,"dispatch":"bound"})
        with mini.guard(self.root): mini.reap_dead(self.root)
        pending=self.root/"mini2-pending"/mini.SLOT/"hold/lease.json"
        before=pending.read_bytes(); args.resource=mini.SLOT
        with contextlib.redirect_stdout(io.StringIO()),self.assertRaisesRegex(ValueError,"pending|held"):
            mini.acquire(self.root,args)
        self.assertFalse(hold.exists()); self.assertEqual(pending.read_bytes(),before)

    def test_standalone_lane_persists_checkout_and_reclaims_verified_dead_work(self):
        self.activate("local")
        file,lease=self.claim("lane","wait-lane")
        self.assertEqual(self.cli("bind",file.parent.name[:-2],"--by","lane").returncode,0)
        dead=subprocess.Popen(["/usr/bin/true"]); dead.wait()
        mini.atomic(file,{**mini.read(file),"pid":dead.pid})
        info=file.parent/"info"
        info.write_text(info.read_text().replace("pid\t"+str(os.getpid())+"\n","pid\t"+str(dead.pid)+"\n"))
        self.assertEqual(mini.read(file)["checkout"],str((self.root/"lane").resolve()))
        source=(SOURCE/"res/res").read_text().split("<<'BUILD_PROCESS_PY'",1)[1].split("\n",1)[1].split("\nBUILD_PROCESS_PY",1)[0]
        child=subprocess.Popen([sys.executable,"-c","import time; time.sleep(10)"],cwd=self.root/"lane")
        try:
            with patch.dict(os.environ,{"RES_BUILD_PROCESS_SOURCE":source}): local.reap(self.root)
            self.assertTrue(file.exists()); self.assertTrue(mini.read(file)["pending"])
        finally: child.terminate(); child.wait(timeout=5)
        with patch.dict(os.environ,{"RES_BUILD_PROCESS_SOURCE":source}): local.reap(self.root)
        self.assertFalse(file.parent.exists(),"a proven dead standalone lane must release its reservation")

    def test_one_workload_generation_cannot_credit_two_claims(self):
        self.activate("local")
        first,_=self.claim("first"); second,_=self.claim("second")
        child=subprocess.Popen([sys.executable,"-c","import time; time.sleep(10)"])
        try:
            result=self.cli("bind",first.parent.name[:-2],"--by","first","--workload-pid",str(child.pid))
            self.assertEqual(result.returncode,0,result.stderr)
            result=self.cli("bind",second.parent.name[:-2],"--by","second","--workload-pid",str(child.pid))
            self.assertNotEqual(result.returncode,0); self.assertIn("overlaps",result.stderr)
        finally: child.terminate(); child.wait(timeout=5)

    def test_wrapper_binds_a_new_kernel_generation_before_dispatch(self):
        self.activate("local")
        env={**self.env,"RES_COMMAND":str(SOURCE/"res/res"),"HEAVY_BUILD_BY":"wrapped","HEAVY_BUILD_PROJECT":"wrapped","HEAVY_BUILD_TASK":"fixture","HEAVY_BUILD_PROFILE":"light","HEAVY_BUILD_TIMEOUT":"0"}
        process=subprocess.Popen(["/bin/bash",str(SOURCE/"heavy-build.sh"),"--",sys.executable,"-c","import time; time.sleep(2)"],env=env,cwd=self.root,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
        try:
            deadline=time.time()+5; lease={}
            while time.time()<deadline:
                files=list((self.root/"locks").glob("heavy-build*.d/lease.json"))
                lease=mini.read(files[0],{}) if files else {}
                if lease.get("dispatch")=="bound": break
                time.sleep(0.02)
            self.assertEqual(lease.get("dispatch"),"bound")
            self.assertGreater(lease["workload"]["birth"],lease["creditAfter"])
            self.assertNotEqual(lease["workload"]["pid"],lease["pid"])
            stdout,stderr=process.communicate(timeout=10)
            self.assertEqual(process.returncode,0,stdout+stderr)
            self.assertFalse(list((self.root/"locks").glob("*.d")))
        finally:
            if process.poll() is None: process.terminate(); process.communicate(timeout=10)

    def test_heavy_check_keeps_legacy_fields_and_adds_the_dynamic_gate(self):
        self.activate("local")
        for by in ("first","second","third"): self.claim(by)
        self.env.update(RES_TEST_METRICS="1",RES_TEST_LOAD1M="0",RES_TEST_MEMORYSTATUS_LEVEL="100",RES_TEST_MEMSIZE=str(64*2**30),
                        RES_TEST_SWAPUSAGE="total = 0.00M used = 0.00M free = 0.00M",RES_TEST_VM_STAT="Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 1000000.\nPages inactive: 1000000.\nPages speculative: 0.\nPages occupied by compressor: 0.\nPages stored in compressor: 0.\n")
        result=self.cli("heavy-check","--pid",str(os.getpid()))
        self.assertEqual(result.returncode,5,result.stderr+result.stdout)
        self.assertIn("gate=OK",result.stdout)
        self.assertIn("load1m=0.00",result.stdout)
        self.assertIn("dynamic_gate=CLOSED",result.stdout)
        self.assertIn("dynamic_reason=load",result.stdout)

    def test_rollbacks_retry_at_every_write_boundary_and_preserve_other_rows(self):
        for kind,present in (("mini2",True),("local",True),("local",False)):
            for boundary in (1,2):
                for after in (False,True):
                    with self.subTest(kind=kind,present=present,boundary=boundary,after=after):
                        root=self.root/(kind+str(present)+str(boundary)+str(after)); root.mkdir()
                        module=migration(kind)
                        registry=root/"resources.tsv"
                        original=self.original+b"unrelated\tslot\topen\t-\tPreserve me\n"
                        other="local" if kind=="mini2" else "mini2"
                        original=migration(other).migrate(original)
                        registry.write_bytes(module.migrate(original)); registry.chmod(0o640)
                        backup=root/("resources.tsv.pre-"+kind+"-dynamic"); backup.write_bytes(original)
                        config=root/("mini2-config.json" if kind=="mini2" else "machine.conf")
                        original_config=json.dumps({**self.config,"load5Limit":6,"minAvailableGiB":16}).encode() if kind=="mini2" else b"# original fixture\n" if present else b""
                        suffix=".config" if kind=="mini2" else ".machine"
                        backup.with_name(backup.name+suffix).write_bytes(original_config)
                        if kind=="local": backup.with_name(backup.name+".machine-existed").write_bytes(b"1" if present else b"0")
                        owner=module if kind=="mini2" else module.m
                        proposed=module.derived_config(original_config) if kind=="mini2" else module.configure(original_config)
                        config.write_bytes(proposed); config.chmod(0o600)
                        atomic=owner.atomic; unlink=Path.unlink; count=0; writes=[]
                        def change(operation,*args,**kwargs):
                            nonlocal count
                            count+=1
                            writes.append(args[0])
                            if count==boundary and not after: raise OSError("injected rollback boundary")
                            result=operation(*args,**kwargs)
                            if count==boundary and after: raise OSError("injected rollback boundary")
                            return result
                        def remove(file,*args,**kwargs):
                            return change(unlink,file,*args,**kwargs) if file==config else unlink(file,*args,**kwargs)
                        with patch.object(owner,"atomic",side_effect=lambda *args,**kwargs:change(atomic,*args,**kwargs)),patch.object(Path,"unlink",remove):
                            with self.assertRaises(OSError): self.run_migration(kind,root,"--rollback",module)
                        self.run_migration(kind,root,"--rollback")
                        self.run_migration(kind,root,"--rollback")
                        self.assertEqual(registry.read_bytes(),original)
                        self.assertEqual(registry.stat().st_mode & 0o777,0o640)
                        self.assertEqual(config.exists(),present)
                        if present: self.assertEqual(config.read_bytes(),original_config)
                        self.assertEqual(backup.read_bytes(),original)
                        self.assertEqual(writes[0],config,"restore thresholds before enabling legacy admission")

    def test_all_resolvers_emit_strict_json_with_nonfinite_numbers_and_timestamps(self):
        self.activate("mini2"); self.activate("local")
        def strict(output):
            return json.loads(output,parse_constant=lambda value: (_ for _ in ()).throw(ValueError("invalid JSON constant "+value)))
        for value in (float("nan"),float("inf"),-float("inf"),1e100,-1,"invalid",None,True):
            with self.subTest(value=value):
                mini.atomic(self.root/"mini2-metrics.json",{**self.sample,"host":mini.HOST,"arch":"arm64","cores":value,"totalGiB":value})
                mini.atomic(self.root/"mini2-facts.json",dict(at=value,host=mini.HOST,caps=["cmake-native"]))
                mini.atomic(self.root/"local-metrics.json",{**self.sample,"cores":value,"totalGiB":value,"at":value})
                for id in (mini.SLOT,"heavy-lane-1"):
                    result=self.cli("slot-host",id); self.assertEqual(result.returncode,0,result.stderr)
                    row=strict(result.stdout); self.assertIsNone(row["factsAt"])
                    if value!=1e100:
                        self.assertIsNone(row["cores"]); self.assertIsNone(row["memGiB"])
                result=self.cli("devbox-registry"); self.assertEqual(result.returncode,0,result.stderr)
                self.assertIsInstance(strict(result.stdout),list)
                for pool in ("mini2","local"):
                    result=self.cli("pool-capacity",pool); self.assertEqual(result.returncode,0,result.stderr)
                    self.assertIsInstance(strict(result.stdout),dict)

    def test_capacity_closes_cleanly_for_each_invalid_or_missing_numeric_metric(self):
        self.activate("mini2"); self.activate("local")
        for field in ("at","cores","totalGiB","load5","availableGiB","freeGiB","pressure","swapGiB","compressorGiB"):
            for invalid in (None,"invalid",True,float("nan"),float("inf"),-float("inf"),10**400):
                with self.subTest(field=field,invalid=type(invalid).__name__):
                    sample={**self.sample,"at":time.time(),field:invalid}
                    mini.atomic(self.root/"sample.json",sample)
                    mini.atomic(self.root/"mini2-metrics.json",{**sample,"host":mini.HOST,"arch":"arm64"})
                    for pool in ("local","mini2"):
                        result=self.cli("pool-capacity",pool); self.assertEqual(result.returncode,0,result.stderr)
                        value=json.loads(result.stdout,parse_constant=lambda value: (_ for _ in ()).throw(ValueError(value)))
                        entry=value[os.uname().nodename if pool=="local" else mini.HOST]
                        self.assertEqual(entry["claims"],0)
            sample={**self.sample,"at":time.time()}; sample.pop(field)
            mini.atomic(self.root/"sample.json",sample)
            result=self.cli("pool-capacity","local"); self.assertEqual(result.returncode,0,result.stderr)
            self.assertEqual(json.loads(result.stdout)[os.uname().nodename]["claims"],0)


if __name__=="__main__": unittest.main()
