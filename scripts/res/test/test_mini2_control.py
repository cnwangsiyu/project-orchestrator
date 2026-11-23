import argparse
import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import plistlib
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import mini2_control as m
import mini2_monitor as monitor

class Mini2Tests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name); self.now=time.time()
        self.cfg={**m.DEFAULT,"enabled":True,"load5Limit":6,"minAvailableGiB":16}
        m.atomic(self.root/"mini2-config.json",self.cfg)
        (self.root/"resources.tsv").write_text(m.ROW.replace("\tnever\t","\topen\t").rstrip()+" caps=cmake-native\n")
        m.atomic(self.root/"mini2-link.json",dict(at=self.now,link="UP",maintenance=False))
        m.atomic(self.root/"mini2-metrics.json",dict(at=self.now,host=m.HOST,cores=10,totalGiB=32,load5=6,availableGiB=16,freeGiB=28,pressure=1,swapGiB=0,compressorGiB=0))
        m.atomic(self.root/"mini2-facts.json",dict(at=self.now,host=m.HOST,caps=["cmake-native"]))

    def test_admission_boundaries(self):
        self.assertEqual(m.admission(self.root,self.cfg,self.now,disk=8,need=["cmake-native"]),"open")
        self.assertEqual(m.admission(self.root,{**self.cfg,"enabled":False},self.now),"disabled")
        self.assertEqual(m.admission(self.root,{**self.cfg,"maintenance":True},self.now,qualification=True),"maintenance")
        self.assertEqual(m.admission(self.root,self.cfg,self.now,disk=8.01),"disk")
        self.assertEqual(m.admission(self.root,self.cfg,self.now,need=["ios-sim"]),"capability")
        for at in (self.now+1,self.now-300):
            sample=m.read(self.root/"mini2-metrics.json"); sample["at"]=at
            m.atomic(self.root/"mini2-metrics.json",sample)
            self.assertEqual(m.admission(self.root,self.cfg,self.now),"metrics-stale-or-foreign")

    def test_metric_failures_and_pending(self):
        original=m.read(self.root/"mini2-metrics.json")
        for key,value,reason in [("load5",6.01,"load5"),("availableGiB",15.99,"memory"),("pressure",4,"pressure"),("load5",float("nan"),"invalid-metrics")]:
            m.atomic(self.root/"mini2-metrics.json",{**original,key:value})
            self.assertEqual(m.admission(self.root,self.cfg,self.now),reason)
        m.atomic(self.root/"mini2-metrics.json",original)
        m.atomic(self.root/"mini2-cleanup-pending.json",{})
        self.assertEqual(m.admission(self.root,self.cfg,self.now),"cleanup-pending")

    def test_alarm_hysteresis_maintenance_and_generation(self):
        for i,state in enumerate(("DOWN","DOWN","DOWN","UP","UP","UP")):
            result=m.observe(self.root,dict(link=state,reason="fixture"),self.now+i*300)
        self.assertEqual([x["tag"] for x in result["outbox"]],["mini2-down","mini2-up"])
        self.assertFalse(result["maintenance"])
        m.atomic(self.root/"mini2-config.json",{**self.cfg,"maintenance":True,"generation":1})
        before=(self.root/"mini2-link.json").read_bytes()
        result=m.observe(self.root,dict(link="UP"),self.now,generation=0)
        self.assertEqual(result["reason"],"config-changed")
        self.assertEqual(before,(self.root/"mini2-link.json").read_bytes())
        with patch.object(monitor,"observation") as probe:
            monitor.once(self.root)
            probe.assert_called_once_with("maintenance")

    def test_failed_alert_delivery_is_retried(self):
        for i in range(2): m.observe(self.root,dict(link="DOWN",reason="fixture"),self.now+i*300)
        with patch.object(subprocess,"run",side_effect=subprocess.TimeoutExpired("node",15)):
            monitor.deliver(self.root)
        state=m.read(self.root/"mini2-link.json")
        self.assertEqual(state["alert"],"FAILED"); self.assertEqual(len(state["outbox"]),1)
        with patch.object(subprocess,"run",return_value=subprocess.CompletedProcess([],0,b'{"delivered":true}')):
            monitor.deliver(self.root)
        self.assertEqual(m.read(self.root/"mini2-link.json")["outbox"],[])

    def test_extra_probes_cannot_shorten_five_minute_failure_window(self):
        for offset in (0,1,30,299):
            state=m.observe(self.root,dict(link="DOWN",reason="fixture"),self.now+offset)
            self.assertEqual(state["failures"],1); self.assertFalse(state.get("outbox"))
        state=m.observe(self.root,dict(link="DOWN",reason="fixture"),self.now+300)
        self.assertEqual(state["failures"],2); self.assertEqual(len(state["outbox"]),1)

    def test_config_invalid_never_falls_back_open(self):
        for value in ("1",1,None):
            m.atomic(self.root/"mini2-config.json",{**self.cfg,"enabled":value})
            with self.assertRaises(ValueError): m.config(self.root)
        self.assertEqual(m.status(self.root)["reason"],"invalid-config-or-state")

    def take_args(self,**kwargs):
        return argparse.Namespace(by="fixture",project="fixture",task="fixture",purpose="check",pid=os.getpid(),
                                  profile="light",disk_gib=8,timeout=0,qualification="",need="cmake-native",**kwargs)

    def test_same_slot_held_and_receipt_required(self):
        with contextlib.redirect_stdout(io.StringIO()): m.acquire(self.root,self.take_args())
        with self.assertRaises(ValueError): m.acquire(self.root,self.take_args())
        lease=m.read(self.root/"locks"/(m.SLOT+".d")/"lease.json")
        self.assertEqual(lease["remote_cleanup_required"],"1")
        env={**os.environ,"RES_DIR":str(self.root)}
        res=Path(__file__).resolve().parents[1]/"res"
        result=subprocess.run([str(res),"return",m.SLOT,"--by","fixture"],env=env,capture_output=True)
        self.assertNotEqual(result.returncode,0)
        self.assertTrue((self.root/"locks"/(m.SLOT+".d")).exists())
        clean=self.root/"clean.json"; m.atomic(clean,dict(clean=True,generation=lease["generation"]))
        result=subprocess.run([str(res),"return",m.SLOT,"--by","fixture","--receipt",str(clean)],env=env,capture_output=True)
        self.assertEqual(result.returncode,0,result.stderr)

    def test_dead_release_requires_receipt_and_dead_local_holder(self):
        res = Path(__file__).resolve().parents[1] / "res"
        hold = self.root / "locks" / (m.SLOT + ".d")
        with contextlib.redirect_stdout(io.StringIO()):
            m.acquire(self.root, self.take_args())
        lease = m.read(hold / "lease.json")
        receipt = self.root / "clean.json"
        m.atomic(receipt, dict(generation=lease["generation"], clean=True))
        def release(pid):
            return subprocess.run([str(res), "release-dead", m.SLOT, "--by", "fixture",
                                   "--pid", str(pid), "--receipt", str(receipt)],
                                  env={**os.environ, "RES_DIR": str(self.root)}, capture_output=True)
        self.assertNotEqual(release(os.getpid()).returncode, 0)
        dead = subprocess.Popen(["/usr/bin/true"])
        dead.wait()
        self.assertNotEqual(release(dead.pid).returncode, 0)
        m.atomic(hold / "lease.json", {**lease, "pid": dead.pid})
        self.assertEqual(release(dead.pid).returncode, 0)
        self.assertFalse(hold.exists())

    def app_receipt(self, platform, name="summary", host=m.HOST, unsigned=True):
        relative = f"{name}/Fixture.app/Info.plist"
        file = self.root / "artifacts" / relative
        file.parent.mkdir(parents=True, exist_ok=True)
        summary = self.root / f"{name}.json"
        data = plistlib.dumps({"CFBundleSupportedPlatforms": [platform]})
        file.write_bytes(data)
        item = dict(path=relative, sha256=hashlib.sha256(data).hexdigest())
        if unsigned is not None:
            item["unsignedApp"] = unsigned
        m.atomic(summary, dict(clean=True, host=host, receipt={"exit": 0}, artifacts=[item]))
        return summary, file

    def test_simulator_capability_requires_verified_simulator_product(self):
        summary, _ = self.app_receipt("iPhoneOS", unsigned=None)
        with self.assertRaises(ValueError): m.verify_simulator_build(summary)
        summary, file = self.app_receipt("iPhoneSimulator", unsigned=None)
        m.verify_simulator_build(summary)
        file.write_bytes(b"changed")
        with self.assertRaises(ValueError): m.verify_simulator_build(summary)

    def test_device_capability_requires_verified_unsigned_device_product(self):
        summary, file = self.app_receipt("iPhoneOS")
        m.verify_device_build(summary)
        for entry in ("_CodeSignature", "embedded.mobileprovision"):
            with self.subTest(entry=entry):
                signing_file = file.parent / entry
                signing_file.touch()
                with self.assertRaises(ValueError): m.verify_device_build(summary)
                signing_file.unlink()
        file.write_bytes(b"changed")
        with self.assertRaises(ValueError): m.verify_device_build(summary)

        for platform, host, unsigned in (("iPhoneSimulator", m.HOST, True),
                                         ("iPhoneOS", "other-host", True),
                                         ("iPhoneOS", m.HOST, False),
                                         ("iPhoneOS", m.HOST, None)):
            with self.subTest(platform=platform, host=host, unsigned=unsigned):
                summary, _ = self.app_receipt(platform, host=host, unsigned=unsigned)
                with self.assertRaises(ValueError): m.verify_device_build(summary)

    def test_configure_device_capability_requires_device_receipt(self):
        simulator, _ = self.app_receipt("iPhoneSimulator", "simulator", unsigned=None)
        device, _ = self.app_receipt("iPhoneOS", "device")
        registry = self.root / "resources.tsv"
        other_row = "other\tremote\topen\t-\tOther host caps=other\r\n"
        with registry.open("a", newline="") as stream:
            stream.write(other_row)
        args = [sys.executable, "-B", str(Path(m.__file__)), "configure", "--enable",
                "--receipt", str(simulator), "--ios-receipt", str(simulator)]

        def configure(*flags):
            return subprocess.run([*args, *flags], env={**os.environ, "RES_DIR": str(self.root)},
                                  capture_output=True, text=True)

        result = configure()
        self.assertEqual(result.returncode, 0, result.stderr)
        before = registry.read_bytes()
        self.assertNotIn(m.DEVICE_CAP.encode(), before)
        self.assertNotEqual(configure("--ios-device-receipt", str(simulator)).returncode, 0)
        self.assertEqual(registry.read_bytes(), before)
        hold = self.root / "locks" / (m.SLOT + ".d")
        hold.mkdir(parents=True)
        self.assertNotEqual(configure("--ios-device-receipt", str(device)).returncode, 0)
        self.assertEqual(registry.read_bytes(), before)
        hold.rmdir()
        result = configure("--ios-device-receipt", str(device))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(registry.read_bytes().splitlines(keepends=True),
                         [before.splitlines()[0] + ("," + m.DEVICE_CAP + "\n").encode(),
                          other_row.encode()])

    def test_qualification_is_task_and_holder_scoped(self):
        q=self.root/"qualification.json"; m.atomic(q,dict(task="mini2-enable",by="fixture",at=self.now,enabled=True)); q.chmod(0o600)
        args=self.take_args(); args.qualification=str(q)
        with self.assertRaises(ValueError): m.acquire(self.root,args)
        args.task="mini2-enable"
        m.atomic(self.root/"mini2-config.json",{**self.cfg,"enabled":False})
        (self.root/"resources.tsv").write_text(m.ROW)
        with contextlib.redirect_stdout(io.StringIO()): m.acquire(self.root,args)
        self.assertFalse(m.config(self.root)["enabled"])
        self.assertIn("\tnever\t",(self.root/"resources.tsv").read_text())

    def test_cli_named_and_pool_disabled(self):
        m.atomic(self.root/"mini2-config.json",{**self.cfg,"enabled":False})
        env={**os.environ,"RES_DIR":str(self.root)}; res=Path(__file__).resolve().parents[1]/"res"
        for action,id in (("take",m.SLOT),("wait",m.SLOT),("wait-pool","mini2")):
            result=subprocess.run([str(res),action,id,"--by","fixture","--project","fixture","--task","fixture","--for","test","--pid",str(os.getpid()),"--profile","light"],env=env,capture_output=True)
            self.assertNotEqual(result.returncode,0)
        self.assertFalse((self.root/"locks"/(m.SLOT+".d")).exists())

class DynamicMini2Tests(unittest.TestCase):
    def setUp(self):
        Mini2Tests.setUp(self)
        registry=self.root/"resources.tsv"
        registry.write_text(registry.read_text().rstrip()+" dynamic-host\n")
        self.sample=dict(at=self.now,host=m.HOST,arch="arm64",cores=10,totalGiB=32,
                         load5=0,availableGiB=32,freeGiB=200,pressure=1,swapGiB=0,compressorGiB=0)
        m.atomic(self.root/"mini2-metrics.json",self.sample)
        self.res=Path(m.__file__).parent/"res"

    def args(self,**updates):
        args=Mini2Tests.take_args(self)
        args.resource="mini2"
        for name,value in updates.items(): setattr(args,name,value)
        return args

    def take(self,**updates):
        output=io.StringIO()
        with contextlib.redirect_stdout(output): m.acquire(self.root,self.args(**updates))
        return json.loads(output.getvalue())

    def cli(self,*args):
        return subprocess.run([str(self.res),*args],env={**os.environ,"RES_DIR":str(self.root)},capture_output=True,text=True)

    def release(self,value):
        file=self.root/(value["slot"]+"-clean.json")
        m.atomic(file,dict(clean=True,generation=value["lease"]["generation"]))
        result=self.cli("return",value["slot"],"--by","fixture","--receipt",str(file))
        self.assertEqual(result.returncode,0,result.stderr)

    def test_concurrent_claims_fit_exact_core_boundary(self):
        command=["wait-pool","mini2","--by","fixture","--project","fixture","--task","fixture",
                 "--for","concurrent","--pid",str(os.getpid()),"--need","cmake-native","--timeout","0.1"]
        with ThreadPoolExecutor(max_workers=8) as pool:
            results=list(pool.map(lambda _:self.cli(*command),range(8)))
        acquired=[json.loads(result.stdout) for result in results if result.returncode==0]
        self.assertEqual(len(acquired),6)
        self.assertEqual(len({value["slot"] for value in acquired}),6)
        self.assertEqual(m.reserved(self.root),(6,6,48))
        value=json.loads(self.cli("pool-capacity","mini2","--json").stdout)[m.HOST]
        self.assertEqual(value["reason"],"load")
        self.assertEqual(value["held"],6); self.assertIsNone(value["slots"])
        for value in acquired:
            resolved=json.loads(self.cli("slot-host",value["slot"]).stdout)
            self.assertEqual(resolved["host"],m.HOST)
            self.release(value)
        self.assertEqual(m.reserved(self.root),(0,0,0))

    def test_owner_derived_defaults_and_measurement_convergence(self):
        m.atomic(self.root/"mini2-config.json",{**self.cfg,"load5Limit":"derived","minAvailableGiB":"derived"})
        values=[self.take() for _ in range(10)]
        self.assertEqual(m.thresholds(m.config(self.root),self.sample),(10,4))
        with self.assertRaisesRegex(ValueError,"load"): self.take()
        for value in values: self.release(value)
        value=self.take(cores=4,mem_gib=8)
        hold=self.root/"locks"/(value["slot"]+".d")
        run="00000000-0000-0000-0000-000000000001"
        m.atomic(hold/"lease.json",{**value["lease"],"runId":run,"dispatch":"bound"})
        observed={**self.sample,"load5":4,"availableGiB":24,"leaseUsage":{run:dict(at=time.time(),cpuLoad=4,memoryGiB=8)}}
        self.assertEqual(m.reserved(self.root,observed,time.time()),(0,0,8))
        stale={**observed,"leaseUsage":{run:dict(at=time.time()-15,cpuLoad=4,memoryGiB=8)}}
        self.assertEqual(m.reserved(self.root,stale,time.time()),(4,8,8))
        unrelated={**self.sample,"leaseUsage":observed["leaseUsage"]}
        self.assertEqual(m.reserved(self.root,unrelated,time.time()),(4,8,8))
        file=self.root/"converged-clean.json"
        m.atomic(file,dict(clean=True,generation=value["lease"]["generation"],runId=run))
        self.assertEqual(self.cli("return",value["slot"],"--by","fixture","--receipt",str(file)).returncode,0)

    def test_memory_and_disk_weight_boundaries(self):
        m.atomic(self.root/"mini2-metrics.json",{**self.sample,"availableGiB":18,"freeGiB":36})
        first=self.take(mem_gib=2,disk_gib=16)
        with self.assertRaisesRegex(ValueError,"memory|disk"): self.take()
        self.release(first)
        for changes,reason in (({"availableGiB":17.99},"memory"),({"freeGiB":35.99},"disk"),({"load5":4.01},"load")):
            m.atomic(self.root/"mini2-metrics.json",{**self.sample,**changes})
            with self.assertRaisesRegex(ValueError,reason): self.take(cores=2,mem_gib=2,disk_gib=16)

    def test_failed_claim_leaves_no_reservation(self):
        original=m.atomic
        def fail(file,value):
            if file.name=="lease.json": raise OSError("fixture failed write")
            original(file,value)
        with patch.object(m,"atomic",side_effect=fail),self.assertRaises(OSError): self.take()
        self.assertFalse(m.lease_holds(self.root)); self.assertEqual(m.reserved(self.root),(0,0,0))
        self.assertFalse(list((self.root/"mini2-waiters").glob("*.json")))

    def test_committed_claim_cannot_remain_a_fifo_head(self):
        root=self.root
        tickets=[]
        class Publication(io.StringIO):
            def write(self,value):
                if value.strip(): tickets.append(list((root/"mini2-waiters").glob("*.json")))
                return super().write(value)
        with contextlib.redirect_stdout(Publication()): m.acquire(self.root,self.args())
        self.assertEqual(tickets,[[]])

    def test_dead_unbound_reclaim_and_pending_lease_preserves_remaining_capacity(self):
        dead=subprocess.Popen(["/usr/bin/true"]); dead.wait()
        first=self.take(); hold=self.root/"locks"/(first["slot"]+".d")
        m.atomic(hold/"lease.json",{**first["lease"],"pid":dead.pid})
        second=self.take()
        self.assertEqual(first["slot"],second["slot"])
        self.assertEqual(m.reserved(self.root),(1,1,8))
        m.atomic(hold/"lease.json",{**second["lease"],"pid":dead.pid,"dispatch":"bound"})
        with m.guard(self.root): m.reap_dead(self.root)
        third=self.take()
        self.assertEqual(third["slot"],"mini2-exec-2")
        self.assertEqual(m.reserved(self.root),(2,2,16))
        pending=json.loads(self.cli("holder",second["slot"]).stdout)
        self.assertEqual(pending["generation"],second["lease"]["generation"])
        self.assertEqual(json.loads(self.cli("slot-host",second["slot"]).stdout)["category"],"LIGHT")
        self.release(second); self.release(third)

    def test_stale_foreign_unknown_and_pressure_close(self):
        for changes,reason in (({"at":self.now-300},"metrics-stale"),({"host":"other"},"metrics-stale"),
                               ({"cores":None},"hardware-mismatch"),({"swapGiB":float("nan")},"invalid-metrics"),
                               ({"compressorGiB":-1},"invalid-metrics"),({"pressure":2},"pressure")):
            m.atomic(self.root/"mini2-metrics.json",{**self.sample,**changes})
            with self.assertRaisesRegex(ValueError,reason): self.take()
        with self.assertRaises(ValueError): self.take(cores=float("nan"))

    def test_bypass_count_persists_and_stops_at_three(self):
        queue=self.root/"mini2-waiters"; queue.mkdir()
        head=queue/"0000-head.json"
        m.atomic(head,dict(pid=os.getpid(),controller=os.getpid(),host=os.uname().nodename,
                           at=self.now,cost=[4,8,16],need="cmake-native",bypasses=0))
        m.atomic(self.root/"mini2-metrics.json",{**self.sample,"load5":3})
        for count in range(1,4):
            value=self.take(); self.release(value)
            self.assertEqual(m.read(head)["bypasses"],count)
        with self.assertRaisesRegex(ValueError,"fifo"): self.take()
        m.atomic(self.root/"mini2-metrics.json",self.sample)
        with self.assertRaisesRegex(ValueError,"fifo"): self.take()

    def test_legacy_holder_and_named_id_remain_compatible(self):
        first=self.take(resource=m.SLOT)
        with self.assertRaisesRegex(ValueError,"held"): self.take(resource=m.SLOT)
        hold=self.root/"locks"/(m.SLOT+".d")
        legacy={name:value for name,value in first["lease"].items() if name not in ("weights","dispatch","dynamic","slot")}
        m.atomic(hold/"lease.json",legacy)
        with self.assertRaisesRegex(ValueError,"legacy-or-incomplete-hold"): self.take()
        self.release(first)

    def test_migration_exact_rollback_and_dynamic_id_drain(self):
        registry=self.root/"resources.tsv"
        original=(m.ROW.replace("\tnever\t","\topen\t").rstrip()+" caps=cmake-native slots=1\r\nother\tremote\topen\t-\tOther\r\n").encode()
        registry.write_bytes(original); registry.chmod(0o640)
        script=Path(m.__file__).parent.parent/"mini2-host-migrate.py"
        def migration(*flags):
            return subprocess.run([sys.executable,"-B",str(Path(__file__).with_name("migration_fixture.py")),str(script),"--registry",str(registry),*flags],capture_output=True,text=True)
        self.assertEqual(migration().returncode,0); self.assertEqual(registry.read_bytes(),original)
        self.assertEqual(migration("--apply").returncode,0)
        self.assertEqual(registry.stat().st_mode & 0o777,0o640)
        self.assertEqual((self.root/"resources.tsv.pre-mini2-dynamic").read_bytes(),original)
        self.assertEqual(m.config(self.root)["load5Limit"],"derived")
        self.assertEqual(m.config(self.root)["minAvailableGiB"],"derived")
        self.assertNotEqual(migration("--apply").returncode,0)
        first=self.take(); second=self.take()
        self.assertEqual(migration("--rollback").returncode,0)
        self.assertEqual(registry.read_bytes(),original)
        self.assertEqual(m.config(self.root)["load5Limit"],6)
        self.assertEqual(m.config(self.root)["minAvailableGiB"],16)
        self.assertEqual(self.cli("slot-host",second["slot"]).returncode,0)
        with self.assertRaisesRegex(ValueError,"dynamic-leases-draining"): self.take()
        self.release(first); self.release(second)
        self.assertNotEqual(self.cli("slot-host",second["slot"]).returncode,0)
        registry.write_bytes(original+b"# changed\n")
        self.assertEqual(migration("--rollback").returncode,0)
        self.assertEqual(registry.read_bytes(),original+b"# changed\n")


if __name__ == "__main__": unittest.main()
