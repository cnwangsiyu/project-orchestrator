import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import threading
import unittest

DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(DIR))
spec = importlib.util.spec_from_file_location("sampler", DIR/"host-sampler.py")
sampler = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sampler)


from host_samples import basis, shared


class SamplerTests(unittest.TestCase):
    def test_window_limits_and_fallback(self):
        import random
        from dynamic_capacity import headroom
        rng = random.Random(42)
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            now=1800
            (root/"machine.conf").write_text("# defaults\n")
            row=dict(schema=1,host="box",ok=True,at=now,cores=14,totalGiB=64,memAvailableGiB=48,
                     freeGiB=128,load1=1,load5=13.2,load15=1,sampleSource="shared")
            file=root/"host-samples/history/box/1970-01-01.ndjson"
            file.parent.mkdir(parents=True)
            def write(ages):
                file.write_text("".join(json.dumps(dict(row,at=now-age,load5=14 if age else 13.2,
                                                         memAvailableGiB=32 if age else 48))+"\n" for age in ages))
            for ages in ([0,300],[0,299,100],[0,0,300]):
                write(ages)
                self.assertEqual(basis(root,"box",row,(4,8,0),now)[:2],(17.2,40))
            write([0,150,300])
            for _ in range(200):
                cpu,mem=(rng.randrange(1,32) for _ in range(2))
                disk=rng.randrange(0,32)
                cost=[rng.uniform(.25,5),rng.uniform(.25,8),rng.randrange(0,30)]
                limit=rng.randrange(10,32)
                leases=[dict(weights=[cpu,mem,disk],start=now-600)]
                charged,available,stats=basis(root,"box",row,(cpu,mem,disk),now,leases)
                self.assertTrue(stats["applied"])
                opened=headroom(charged,available,128,(0,0,disk),cost,limit,8,64)=="open"
                self.assertEqual(opened, all((cpu+cost[0]<=limit,14+cost[0]<=limit,
                                     32-cost[1]>=8,64-mem-cost[1]>=8,128-disk-cost[2]>=64)))
            (root/"machine.conf").write_text("ADMISSION_WINDOW_SECONDS=0\n")
            self.assertEqual(basis(root,"box",row,(4,8,0),now)[:2],(17.2,40))

    def test_window_keeps_young_claims_and_untracked_load_additive(self):
        import random
        from dynamic_capacity import headroom, reservation_totals, reservation_ages
        from host_records import decision, evidence
        rng=random.Random(73)
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory); now=1800
            (root/"machine.conf").write_text("# defaults\n")
            row=dict(schema=1,host="box",ok=True,at=now,cores=14,totalGiB=64,
                     memAvailableGiB=60,freeGiB=128,load1=8,load5=8,load15=8,sampleSource="shared")
            file=root/"host-samples/history/box/1970-01-01.ndjson"
            file.parent.mkdir(parents=True)
            def write(load=8,available=60,ages=(0,150,300)):
                file.write_text("".join(json.dumps(dict(row,at=now-age,load5=load,
                                                        memAvailableGiB=available))+"\n" for age in ages))
            write()
            for start in (now-60,None,"unknown",True,0,-1,now+1,float("nan"),float("inf")):
                leases=[dict(weights=[4,16,0],start=start)]
                charged,available,stats=basis(root,"box",row,(4,16,0),now,leases)
                self.assertEqual((charged,available),(12,44))
                self.assertEqual((stats["youngCores"],stats["oldCores"],stats["youngGiB"],stats["oldGiB"]),(4,0,16,0))
                self.assertEqual(headroom(charged,available,128,(0,0,0),(2,1,0),14,8,64),"open")
                self.assertEqual(headroom(charged,available,128,(0,0,0),(2.01,1,0),14,8,64),"load")
            self.assertEqual(basis(root,"box",row,(4,16,0),now)[:2],(12,44))
            for _ in range(200):
                leases=[dict(weights=[rng.randrange(1,9),rng.randrange(1,17),rng.randrange(0,4)],
                             start=rng.choice([None,now-599,now-600,str(now-900)]))
                        for _ in range(rng.randrange(0,5))]
                totals=reservation_totals(leases)
                ages=reservation_ages(leases,now,600)
                peak=rng.randrange(8,33); low=rng.randrange(0,61)
                write(peak,low)
                charged,available,stats=basis(root,"box",row,totals,now,leases)
                expected_charge=max(peak,ages["oldCores"])+ages["youngCores"]
                expected_memory=min(low-ages["youngGiB"],64-totals[1])
                self.assertTrue(stats["applied"])
                self.assertGreaterEqual(charged,expected_charge)
                self.assertEqual(charged,expected_charge)
                self.assertGreaterEqual(charged,peak+ages["youngCores"])
                self.assertGreaterEqual(charged,totals[0])
                self.assertEqual(available,expected_memory)
                cost=[rng.randrange(1,9),rng.randrange(1,9),rng.randrange(0,4)]
                limit=rng.randrange(8,33)
                self.assertEqual(headroom(charged,available,128,(0,0,totals[2]),cost,limit,8,64)=="open",
                                 all((expected_charge+cost[0]<=limit,expected_memory-cost[1]>=8,
                                      128-totals[2]-cost[2]>=64)))
                old=[dict(lease,start=now-600) for lease in leases]
                self.assertEqual(basis(root,"box",row,totals,now,old)[:2],
                                 (max(peak,totals[0]),min(low,64-totals[1])))
            # The age split is evidence even when the window cannot be used.
            leases=[dict(weights=[4,16,0],start=now-60)]
            write(ages=(0,150))
            charged,available,stats=basis(root,"box",row,(4,16,0),now,leases)
            self.assertFalse(stats["applied"])
            self.assertEqual((charged,available),(12,44))
            write()
            (root/"machine.conf").write_text("ADMISSION_WINDOW_SECONDS=0\n")
            self.assertEqual(basis(root,"box",row,(4,16,0),now,leases)[:2],(12,44))
            (root/"machine.conf").write_text("# defaults\n")
            charged,available,stats=basis(root,"box",row,(4,16,0),now,leases)
            decision(root,"box","fixture","young","heavy",[2,1,0],"open",True,
                     evidence(row,(4,16,0),[14,8,64],stats,charged,available))
            record=json.loads((root/"host-samples/admission.ndjson").read_text())
            self.assertEqual({k:record["window"][k] for k in ("youngCores","oldCores","youngGiB","oldGiB")},
                             dict(youngCores=4,oldCores=0,youngGiB=16,oldGiB=0))

    def test_claim_measurements_rotation_report_and_failed_write(self):
        import time
        import datetime
        from host_records import completion, decision, evidence, report
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            now=time.time()
            sample=dict(schema=1,host="box",ok=True,cores=8,totalGiB=32,freeGiB=99,load1=1,load15=1)
            for seconds,load,mem in [(90,1,28),(30,5,22),(5,4,18)]:
                at=now-seconds
                day=datetime.datetime.fromtimestamp(at,datetime.timezone.utc).date()
                file=root/"host-samples/history/box"/(str(day)+".ndjson")
                file.parent.mkdir(parents=True,exist_ok=True)
                with file.open("a") as stream:
                    stream.write(json.dumps(dict(sample,at=at,load5=load,memAvailableGiB=mem))+"\n")
            data=root/"host-samples"
            old=data/"admission.2000-01-01.ndjson"
            old.touch()
            decision(root,"box","project","bad\nfield","heavy",[4,8,1],"load",False,evidence({}))
            self.assertFalse(old.exists())
            self.assertEqual(json.loads((data/"admission.ndjson").read_text())["task"],"[masked]")
            completion(root,"box","slot",dict(start=now-60,project="project",task="test",profile="heavy",weights=[4,8,1]),False)
            group=report(root,1)["groups"][0]
            self.assertEqual((group["claims"],group["measured"],group["refusals"]), (1,1,{"load":1}))
            self.assertEqual(group["percentiles"]["deltaCores"]["p50"],4)
            self.assertEqual(group["percentiles"]["deltaGiB"]["p90"],10)
            bad=root/"bad"
            bad.mkdir()
            (bad/"host-samples").touch()
            decision(bad,"box","p","t","light",[1,2,3],"open",True,evidence({}))

    def test_selection(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            now = 1000
            row = dict(schema=1,host="box",ok=True,at=900,cores=8,totalGiB=16,memAvailableGiB=8,
                       freeGiB=128,load1=1,load5=1,load15=1)
            def publish(**fields):
                sampler.atomic(root/"host-samples/latest.json",dict(schema=1,hosts={"box":dict(row,**fields)}))
            publish()
            self.assertFalse(shared(root,"box",now))
            (root/"machine.conf").write_text("# defaults\n")
            self.assertEqual(shared(root,"box",now)["sampleSource"],"shared")
            for fields in (dict(at=1001),dict(at=820),dict(schema=True),dict(host="foreign"),dict(ok=False),
                           dict(cores=True),dict(load5=-1),dict(io_some_avg60=101),dict(memAvailableGiB=17)):
                publish(**fields)
                self.assertFalse(shared(root,"box",now),fields)
            publish()
            for setting in ("SAMPLE_TTL=100","SHARED_SAMPLES=0"):
                (root/"machine.conf").write_text(setting+"\n")
                self.assertFalse(shared(root,"box",now))

    def test_history_failure_backoff_and_pruning(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root/"resources.tsv").write_text("")
            data = root/"host-samples"
            old = data/"history"/"retired"/"2000-01-01.ndjson"
            old.parent.mkdir(parents=True)
            old.touch()
            stop = threading.Event()
            sampler.cycle(root,data,stop,lambda *_: {"load5":2})
            def fail(*args):
                raise sampler.subprocess.TimeoutExpired("probe",8)
            sampler.cycle(root,data,stop,fail)
            sampler.cycle(root,data,stop,lambda *_: self.fail("backoff"))
            row = next(iter(json.loads((data/"latest.json").read_text())["hosts"].values()))
            self.assertEqual((row["errorClass"],row["lastGood"]["load5"]), ("timeout",2))
            self.assertFalse(old.exists())
            self.assertEqual(len(next((data/"history").glob("*/*.ndjson")).read_text().splitlines()),2)


if __name__ == "__main__":
    unittest.main()
