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


class SamplerTests(unittest.TestCase):
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
