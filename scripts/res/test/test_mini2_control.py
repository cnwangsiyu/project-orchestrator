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

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import mini2_control as m
import mini2_monitor as monitor

class Mini2Tests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name); self.now=time.time()
        self.cfg={**m.DEFAULT,"enabled":True}
        m.atomic(self.root/"mini2-config.json",self.cfg)
        (self.root/"resources.tsv").write_text(m.ROW.replace("\tnever\t","\topen\t").rstrip()+" caps=cmake-native\n")
        m.atomic(self.root/"mini2-link.json",dict(at=self.now,link="UP",maintenance=False))
        m.atomic(self.root/"mini2-metrics.json",dict(at=self.now,host=m.HOST,load5=6,availableGiB=16,freeGiB=28,pressure=1,swapGiB=0,compressorGiB=0))
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

if __name__ == "__main__": unittest.main()
