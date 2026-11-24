import json
import os
from pathlib import Path
import sys
import time
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import mini2_control as mini
import test_local_control as fixture


class PlacementTests(unittest.TestCase):
    setUp = fixture.LocalCapacityTests.setUp
    cli = fixture.LocalCapacityTests.cli
    write = fixture.LocalCapacityTests.write

    def configure(self):
        cap = "xcode-ios-device-compile-unsigned"
        (self.root / "resources.tsv").write_text(
            f"heavy-build\tslot\topen\t-\tdynamic-local caps={cap},ios-sign os=darwin arch=arm64\n" +
            mini.ROW.replace("\tnever\t", "\topen\t").rstrip() + f" dynamic-host caps={cap}\n")
        now = time.time()
        self.write("mini2-config.json", dict(mini.DEFAULT, enabled=True))
        self.write("mini2-link.json", dict(at=now, link="UP", maintenance=False))
        self.write("mini2-facts.json", dict(at=now, host=mini.HOST, caps=[cap]))
        self.write("mini2-metrics.json", dict(self.sample, at=now, host=mini.HOST, cores=10,
                                             load5=1.7, totalGiB=32, arch="arm64"))
        self.write("sample.json", dict(self.sample, load5=13.5, at=now))
        for i in (1, 2):
            self.write(f"locks/heavy-lane-{i}.d/lease.json", dict(weights=[1, 2, 2], start=now-600))
        return cap

    def place(self, *options):
        p = self.cli("place", "--json", *options)
        self.assertEqual(p.returncode, 0, p.stderr)
        return json.loads(p.stdout)

    def test_replay_and_constraints(self):
        cap = self.configure()
        before = {p:p.read_bytes() for p in self.root.rglob("*") if p.is_file()}
        replay = self.place("--need", cap)
        self.assertEqual(replay["chosen"], "mini2")
        self.assertAlmostEqual(replay["candidates"][0]["spareCores"], 4.3)
        self.assertEqual(replay["candidates"][1]["reason"], "load")
        self.assertEqual(self.place("--need", "ios-sign")["chosen"], "main")
        self.assertEqual(self.place("--need", cap, "--os", "linux")["chosen"], None)
        self.assertEqual(self.place("--need", cap, "--pin", "main")["chosen"], "main")
        self.assertEqual(self.place("--must-local-reason", "attached phone")["chosen"], "main")
        self.assertEqual(before, {p:p.read_bytes() for p in self.root.rglob("*") if p.is_file()})

    def test_devbox_tiers_and_stale_facts(self):
        import datetime
        self.configure()
        hosts = ["10.1.0.1", "10.1.0.2"]
        with (self.root/"resources.tsv").open("a") as registry:
            for i, host in enumerate(hosts):
                registry.write(f"devbox-host-box{i}\tremote\topen\t-\tworker@{host} caps=node os=linux arch=x86_64" +
                               (" prefer=node" if i else "") + "\n")
                self.write(f"devbox-metrics/{host}.json", dict(at=time.time(),host=host,
                           cores=32-i*8,load5=1,memAvailableGiB=100,freeGiB=1000))
        now = datetime.datetime.now(datetime.timezone.utc).isoformat()
        facts = {host:dict(probedAt=now) for host in hosts}
        self.write("devbox-hosts.json", facts)
        ranked = self.place("--need","node","--os","linux")
        self.assertEqual(ranked["chosen"],"devbox:"+hosts[1], ranked)
        facts.pop(hosts[1])
        self.write("devbox-hosts.json", facts)
        ranked = self.place("--need","node")
        self.assertEqual(ranked["chosen"],"devbox:"+hosts[0], ranked)
        self.assertIn("facts-stale", [r["reason"] for r in ranked["candidates"]])

    def test_claim_retains_queue_until_mini2_opens(self):
        import subprocess
        cap = self.configure()
        link = dict(at=time.time(), link="DOWN", maintenance=False)
        self.write("mini2-link.json", link)
        args = ["--by","test","--project","p","--task","t","--for","fixture","--pid",str(os.getpid())]
        with subprocess.Popen([self.res,"claim-any","--need",cap,"--timeout","0.12",*args],
                              env=self.env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True) as proc:
            limit = time.monotonic()+4
            while not list((self.root/"local-waiters").glob("*.json")) and time.monotonic()<limit:
                time.sleep(.02)
            self.assertTrue(list((self.root/"local-waiters").glob("*.json")))
            self.write("mini2-link.json", dict(link, link="UP"))
            out, err = proc.communicate(timeout=10)
        self.assertEqual(proc.returncode,0,err)
        self.assertIn("machine=mini2 lease=mini2-exec-1",out)
        events = [json.loads(line) for line in (self.root/"host-samples/admission.ndjson").read_text().splitlines()]
        choices = [e for e in events if e.get("type")=="placement"]
        self.assertEqual([e["chosen"] for e in choices],["main","mini2"])
        self.assertEqual(choices[0]["candidates"][1]["reason"],"link-stale-or-down")
        self.assertFalse(list((self.root/"local-waiters").glob("*.json")))

    def test_hint_for_lane_and_build(self):
        cap = self.configure()
        for action in ("wait-build","wait-lane"):
            result = self.cli(action,"--by","hint","--project","p","--task","t","--for","fixture",
                              "--pid",str(os.getpid()),"--need",cap,"--timeout","0.001")
            self.assertNotEqual(result.returncode,0)
            self.assertEqual(result.stderr.count("main mini busy; mini2 can take this now:"),1,result.stderr)

    def test_auto_wrapper_dispatch(self):
        import subprocess
        cap = self.configure()
        env = dict(self.env, HEAVY_BUILD_PLACE="auto", RES_COMMAND=str(self.res),
                   HEAVY_BUILD_BY="wrapper",HEAVY_BUILD_PROJECT="fixture",HEAVY_BUILD_TASK="placement",
                   HEAVY_BUILD_TIMEOUT="0", HEAVY_BUILD_NEED=cap)
        wrapper = self.res.parent.parent / "heavy-build.sh"
        cmd = [str(wrapper),"--","touch",str(self.root/"local-built")]
        result = subprocess.run(cmd,env=env,capture_output=True,text=True,timeout=10)
        self.assertNotEqual(result.returncode,0)  # no remote form, busy main
        self.assertFalse((self.root/"local-built").exists())
        node = self.root/"node"
        node.write_text("#!/bin/sh\nset -eu\n[ \"$2\" = --parent-lease ]\n[ -d \"$RES_DIR/locks/$3.d\" ]\nprintf '%s\\n' \"$@\" > \"$RES_DIR/runner-args\"\n")
        node.chmod(0o755)
        env.update(PATH=str(self.root)+":"+env["PATH"],HEAVY_BUILD_MINI2_REPO=str(self.root),
                   HEAVY_BUILD_MINI2_REF="HEAD",HEAVY_BUILD_MINI2_COMMAND="make fixture",
                   HEAVY_BUILD_MINI2_ALLOWLIST="inputs.json",HEAVY_BUILD_MINI2_ARTIFACT="fixture.a",
                   HEAVY_BUILD_MINI2_OUT=str(self.root/"out"))
        result = subprocess.run(cmd,env=env,capture_output=True,text=True,timeout=10)
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertIn("machine=mini2 lease=mini2-exec-1",result.stdout)
        self.assertIn("--artifact\nfixture.a\n",(self.root/"runner-args").read_text())
        self.assertFalse((self.root/"locks/mini2-exec-1.d").exists())
        self.assertFalse((self.root/"local-built").exists())
        self.write("sample.json",dict(self.sample,at=time.time(),load5=0))
        result = subprocess.run(cmd,env=env,capture_output=True,text=True,timeout=10)
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertTrue((self.root/"local-built").exists())
        self.assertFalse((self.root/"locks/heavy-build.d").exists())

    def test_registry_capabilities_in_memory(self):
        import runpy
        migrate = runpy.run_path(str(self.source/"place-registry.py"))["migrated"]
        original = b"heavy-build\tslot\topen\t-\tdynamic-local caps=custom\r\nother row\r\n"
        migrated = migrate(original)
        self.assertIn(b"device:iphone8",migrated)
        self.assertIn(b"custom",migrated)
        self.assertTrue(migrated.endswith(b"\r\nother row\r\n"))
        self.assertEqual(migrated,migrate(migrated))

    def test_independent_controller_failure(self):
        cap = self.configure()
        with (self.root/"resources.tsv").open("a") as f:
            f.write("devbox-host-fault\tremote\topen\t-\tworker@10.1.0.2 caps=node\n")
        (self.root/"box-health.json").write_text("invalid")
        result = self.place("--need",cap)
        self.assertEqual(result["chosen"],"mini2")
        unavailable = self.place("--need","node")
        self.assertIsNone(unavailable["chosen"])
        self.assertIn(("devbox:10.1.0.2","invalid-pool-state"), [(r["machine"],r["reason"]) for r in unavailable["candidates"]])

    def test_main_headroom_preference(self):
        cap = self.configure()
        for load, chosen in [(3, "mini2"), (0, "main")]:
            self.write("sample.json", dict(self.sample, at=time.time(), load5=load))
            self.assertEqual(self.place("--need", cap)["chosen"], chosen)


if __name__ == "__main__": unittest.main()
