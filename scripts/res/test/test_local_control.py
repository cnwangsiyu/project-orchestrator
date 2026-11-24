import concurrent.futures
import json
import os
from pathlib import Path
import subprocess
import shutil
import sys
sys.dont_write_bytecode = True
import tempfile
import time
import unittest


class LocalCapacityTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name)
        self.res=Path(__file__).resolve().parents[1]/"res"
        self.source=self.res.parent.parent
        self.original=("heavy-build\tslot\topen\t-\tFull build\n"+"".join(f"heavy-lane-{i}\tslot\topen\t-\tLocal lane\n" for i in range(1,4))).encode()
        (self.root/"resources.tsv").write_bytes(self.original.replace(b"Full build",b"Full build dynamic-local"))
        (self.root/"machine.conf").write_text("# fixture\n")
        self.sample=dict(at=time.time(),host=os.uname().nodename,cores=14,totalGiB=64,load5=0,
                         availableGiB=64,pressure=1,freeGiB=1000,swapGiB=0,compressorGiB=0)
        self.write("sample.json",self.sample)
        self.env={**os.environ,"RES_DIR":str(self.root),"RULES_SHARED":str(self.root),
                  "PYTHONDONTWRITEBYTECODE":"1","RES_TEST_LOCAL_SAMPLE":str(self.root/"sample.json")}

    def write(self,name,value):
        (self.root/name).parent.mkdir(parents=True,exist_ok=True)
        (self.root/name).write_text(json.dumps(value))

    def cli(self,*args,env=None):
        return subprocess.run([str(self.res),*args],env={**self.env,**(env or {})},capture_output=True,text=True,timeout=10)

    def args(self,by,profile=None):
        checkout=self.root/by; checkout.mkdir(exist_ok=True); (checkout/".git").mkdir(exist_ok=True)
        values=["--by",by,"--project",by,"--task","local","--for","fixture","--pid",str(os.getpid()),"--checkout",str(checkout)]
        if profile: values += ["--profile",profile]
        return values

    def take(self,by,profile=None,*extra):
        result=self.cli("take-build",*self.args(by,profile),*extra)
        self.assertEqual(result.returncode,0,result.stderr)
        values=dict(line.split("=",1) for line in result.stdout.splitlines() if "=" in line)
        return values

    def release(self,by):
        result=self.cli("return-build","--by",by,"--pid",str(os.getpid()))
        self.assertEqual(result.returncode,0,result.stderr)

    def capacity(self,pool="local"):
        result=self.cli("pool-capacity",pool)
        self.assertEqual(result.returncode,0,result.stderr)
        return json.loads(result.stdout)[os.uname().nodename]

    def test_concurrent_heavy_and_light_claims_exceed_numbered_lanes(self):
        requests=[self.args("job-"+str(i)) for i in range(6)]
        with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
            results=list(pool.map(lambda args:self.cli("wait-build",*args,"--timeout","0.05"),requests))
        self.sample["at"]=time.time(); self.write("sample.json",self.sample)
        successful=[i for i,result in enumerate(results) if result.returncode==0]
        self.assertEqual(len(successful),3)
        value=self.capacity(); self.assertEqual(value["memoryFloorGiB"],7.68)
        self.assertEqual(value["loadLimit"],14); self.assertEqual(value["reserved"],[12,24,48])
        fourth=self.take("fourth","light")
        self.assertEqual(fourth["build-lane"],"heavy-lane-4")
        self.assertEqual(self.cli("slot-host","heavy-lane-4").returncode,0)
        fifth=self.take("fifth","light")
        self.assertEqual(fifth["build-lane"],"heavy-lane-5")
        self.assertEqual(self.capacity("local-light")["claims"],0)
        for i in successful: self.release("job-"+str(i))
        self.release("fourth"); self.release("fifth")
        self.assertFalse(list((self.root/"locks").glob("*.d")))

    def test_real_memory_boundary_pressure_and_stale_close(self):
        for changes,reason in (({"availableGiB":15.67},"memory"),({"pressure":2},"pressure"),
                               ({"pressure":4},"pressure"),({"at":time.time()-5},"stale"),
                               ({"host":"foreign"},"foreign"),({"freeGiB":35.99},"disk"),
                               ({"availableGiB":float("nan")},"invalid-metrics")):
            self.write("sample.json",{**self.sample,**changes})
            result=self.cli("take-build",*self.args("closed"))
            self.assertNotEqual(result.returncode,0)
            self.assertIn(reason,result.stderr)
        self.write("sample.json",{**self.sample,"availableGiB":15.68,"freeGiB":36})
        self.take("boundary"); self.release("boundary")

    def test_kind_defaults_derive_from_hardware(self):
        for profile,expected in (("heavy",3),("medium",7),("light",14)):
            result=self.cli("pool-capacity","local","--profile",profile)
            self.assertEqual(result.returncode,0,result.stderr)
            self.assertEqual(json.loads(result.stdout)[os.uname().nodename]["claims"],expected)
        self.write("sample.json",{**self.sample,"cores":8,"totalGiB":32,"availableGiB":32})
        value=self.capacity(); self.assertEqual(value["claims"],4)
        self.assertEqual(value["memoryFloorGiB"],4)
        self.assertEqual(value["loadLimit"],8)

    def test_global_status_shows_dynamic_capacity(self):
        result=self.cli("status")
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertIn("Local capacity:",result.stdout)
        self.assertIn('"memoryFloorGiB": 7.68',result.stdout)
        self.assertNotIn("Build capacity: heavy-build 0/2",result.stdout)

    def test_invalid_config_never_uses_last_good_for_admission(self):
        (self.root/"machine.conf").write_text("LOCAL_MIN_AVAILABLE_GIB=40\n")
        self.write("sample.json",{**self.sample,"availableGiB":47.99})
        result=self.cli("take-build",*self.args("reserve"))
        self.assertNotEqual(result.returncode,0); self.assertIn("memory",result.stderr)
        (self.root/"machine.conf").write_text("LOCAL_MIN_AVAILABLE_GIB=NaN\n")
        result=self.cli("take-build",*self.args("invalid"))
        self.assertNotEqual(result.returncode,0)
        self.assertEqual(self.capacity()["claims"],0)

    def test_publication_failure_has_no_partial_pair_or_reservation(self):
        result=self.cli("take-build",*self.args("fail"),env={"RES_TEST_LOCAL_FAIL_AFTER_HOLD":"1"})
        self.assertNotEqual(result.returncode,0); self.assertIn("injected",result.stderr)
        self.assertFalse(list((self.root/"locks").glob("*.d")))
        self.assertFalse(list((self.root/"local-waiters").glob("*.json")))
        self.assertEqual(self.capacity()["reserved"],[0,0,0])

    def test_bounded_bypass_and_fitting_head(self):
        self.write("local-waiters/0000-head.json",dict(pid=os.getpid(),controller=os.getpid(),cost=[8,16,16],bypasses=0))
        self.write("sample.json",{**self.sample,"load5":9})
        for count in range(1,4):
            self.take("small-"+str(count),"light"); self.release("small-"+str(count))
            self.assertEqual(json.loads((self.root/"local-waiters/0000-head.json").read_text())["bypasses"],count)
        result=self.cli("take-build",*self.args("fourth","light"))
        self.assertNotEqual(result.returncode,0); self.assertIn("fifo",result.stderr)
        self.write("sample.json",self.sample)
        result=self.cli("take-build",*self.args("fitting","light"))
        self.assertNotEqual(result.returncode,0); self.assertIn("fifo",result.stderr)

    def test_checkout_collision_and_legacy_holder_compatibility(self):
        self.take("same")
        args=self.args("other"); args[-1]=str(self.root/"same")
        result=self.cli("take-build",*args)
        self.assertNotEqual(result.returncode,0); self.assertIn("checkout-held",result.stderr)
        self.release("same")
        old=self.root/"locks/heavy-build.d"; old.mkdir()
        (old/"info").write_text(f"by\tlegacy\npid\t{os.getpid()}\nhost\t{os.uname().nodename}\n")
        result=self.cli("take-build",*self.args("new"))
        self.assertNotEqual(result.returncode,0); self.assertIn("legacy-or-incomplete-hold",result.stderr)
        result=self.cli("wait-lane",*self.args("new-light","light"),"--lane","heavy-lane-90")
        self.assertNotEqual(result.returncode,0); self.assertIn("legacy-or-incomplete-hold",result.stderr)
        self.assertEqual(self.capacity("local-light")["claims"],0)
        result=self.cli("return-build","--by","legacy")
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertFalse(old.exists())
        self.take("after-legacy-return","light"); self.release("after-legacy-return")

    def test_dead_unbound_reclaim_and_bound_work_keeps_its_reservation(self):
        dead=subprocess.Popen(["/usr/bin/true"]); dead.wait()
        values=self.take("dead","light","--wrapper")
        file=self.root/"locks"/(values["build-id"]+".d")/"lease.json"
        lease=json.loads(file.read_text()); self.write(str(file.relative_to(self.root)),{**lease,"pid":dead.pid})
        metadata=file.parent/"info"
        metadata.write_text(metadata.read_text().replace("pid\t"+str(os.getpid())+"\n","pid\t"+str(dead.pid)+"\n"))
        self.take("successor","light"); self.release("successor")
        self.assertFalse(file.exists())
        values=self.take("busy","heavy","--wrapper")
        self.assertEqual(self.cli("bind",values["build-id"],"--by","busy").returncode,0)
        file=self.root/"locks"/(values["build-id"]+".d")/"lease.json"
        lease=json.loads(file.read_text()); self.write(str(file.relative_to(self.root)),{**lease,"pid":dead.pid})
        metadata=file.parent/"info"
        metadata.write_text(metadata.read_text().replace("pid\t"+str(os.getpid())+"\n","pid\t"+str(dead.pid)+"\n"))
        child=subprocess.Popen([sys.executable,"-B","-c","import time; time.sleep(10)"],cwd=self.root/"busy")
        try:
            self.take("parallel","light")
            self.assertTrue(file.exists())
            self.assertTrue(json.loads(file.read_text())["pending"])
            self.assertEqual(self.capacity()["reserved"],[5,10,18])
            self.release("parallel")
        finally: child.terminate(); child.wait(timeout=5)
        self.take("after-cleanup","light"); self.release("after-cleanup")
        self.assertFalse(file.exists())

    def test_materialized_claim_retains_its_full_declared_reservation(self):
        values=self.take("visible","heavy","--wrapper")
        self.assertEqual(self.cli("bind",values["build-id"],"--by","visible").returncode,0)
        self.write("sample.json",{**self.sample,"load5":4,"availableGiB":56})
        self.assertEqual(self.capacity()["reserved"],[4,8,16])
        self.release("visible")

    def test_interrupted_wait_has_no_holds_or_queue_leak(self):
        self.write("sample.json",{**self.sample,"pressure":2})
        child=subprocess.Popen([str(self.res),"wait-build",*self.args("waiting"),"--timeout","1"],env=self.env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
        try:
            deadline=time.time()+5
            while not list((self.root/"local-waiters").glob("*.json")) and time.time()<deadline: time.sleep(0.02)
            child.terminate(); child.communicate(timeout=5)
            self.assertFalse(list((self.root/"locks").glob("*.d")))
            self.assertFalse(list((self.root/"local-waiters").glob("*.json")))
        finally:
            if child.poll() is None: child.kill(); child.communicate(timeout=5)

    def test_two_migrations_can_roll_back_in_either_order(self):
        mini="mini2-exec-1\tremote\topen\t-\tSecond Mac mini bytedance@Bytedances-Mac-mini.local caps=cmake-native\n"
        (self.root/"resources.tsv").write_bytes(self.original+mini.encode())
        config=dict(enabled=True,maintenance=False,load5Limit=6,minAvailableGiB=16,minFreeGiB=20,owner="fixture",generation=0)
        self.write("mini2-config.json",config)
        for first in ("mini2","local"):
            # Each order starts from the same exact original data and uses
            # separate named backups, without removing any other's artifacts.
            backups={kind:self.root/(kind+"-"+first+".backup") for kind in ("mini2","local")}
            def migration(kind,action):
                return subprocess.run([sys.executable,"-B",str(Path(__file__).with_name("migration_fixture.py")),str(self.source/(kind+"-host-migrate.py")),"--registry",str(self.root/"resources.tsv"),"--backup",str(backups[kind]),action],capture_output=True,text=True)
            for kind in ("mini2","local"):
                result=migration(kind,"--apply"); self.assertEqual(result.returncode,0,result.stderr)
            self.take("during-"+first,"light")
            result=migration(first,"--rollback"); self.assertEqual(result.returncode,0,result.stderr)
            other="local" if first=="mini2" else "mini2"
            content=(self.root/"resources.tsv").read_text()
            self.assertIn("dynamic-local" if other=="local" else "dynamic-host",content)
            self.release("during-"+first)
            result=migration(other,"--rollback"); self.assertEqual(result.returncode,0,result.stderr)
            self.assertEqual((self.root/"resources.tsv").read_bytes(),self.original+mini.encode())
            self.assertEqual(json.loads((self.root/"mini2-config.json").read_text()),config)
            self.assertEqual((self.root/"machine.conf").read_text(),"# fixture\n")

    def test_wrapper_accepts_fourth_lane_and_returns_its_exact_pair(self):
        for index in range(3): self.take("hold-"+str(index),"light")
        wrapper=self.source/"heavy-build.sh"
        env={**self.env,"RES_COMMAND":str(self.res),"HEAVY_BUILD_BY":"wrapped","HEAVY_BUILD_PROJECT":"wrapped","HEAVY_BUILD_TASK":"local","HEAVY_BUILD_PROFILE":"light","HEAVY_BUILD_TIMEOUT":"0"}
        result=subprocess.run(["/bin/bash",str(wrapper),"--","/usr/bin/true"],env=env,capture_output=True,text=True,timeout=10)
        self.assertEqual(result.returncode,0,result.stderr+result.stdout)
        self.assertIn("build-lane=heavy-lane-4",result.stdout)
        self.assertFalse((self.root/"locks/heavy-lane-4.d").exists())
        for index in range(3): self.release("hold-"+str(index))

    def test_code_backup_bundles_helpers_for_runnable_rollback(self):
        backup=self.root/"code-backup"; backup.mkdir()
        for name in ("res","host_samples.py","dynamic_capacity.py","mini2_control.py","mini2_link.py","mini2_monitor.py","local_control.py"):
            shutil.copy2(self.res.parent/name,backup/name)
        result=subprocess.run([str(backup/"res"),"pool-capacity","local"],env=self.env,capture_output=True,text=True,timeout=10)
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertEqual(json.loads(result.stdout)[os.uname().nodename]["claims"],3)
        result=subprocess.run([str(backup/"res"),"devbox-registry"],env=self.env,capture_output=True,text=True,timeout=10)
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertIsInstance(json.loads(result.stdout),list)


if __name__=="__main__": unittest.main()
