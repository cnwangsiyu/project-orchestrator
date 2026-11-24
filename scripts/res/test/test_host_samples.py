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


from host_samples import shared


class SamplerTests(unittest.TestCase):
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
