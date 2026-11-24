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

    def test_main_headroom_preference(self):
        cap = self.configure()
        for load, chosen in [(3, "mini2"), (0, "main")]:
            self.write("sample.json", dict(self.sample, at=time.time(), load5=load))
            self.assertEqual(self.place("--need", cap)["chosen"], chosen)


if __name__ == "__main__": unittest.main()
