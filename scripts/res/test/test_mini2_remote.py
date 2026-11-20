import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import uuid

spec=importlib.util.spec_from_file_location("mini2_remote",Path(__file__).resolve().parents[2]/"lib/mini2_remote.py")
m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)

class RemoteTests(unittest.TestCase):
    @unittest.skipUnless(sys.platform == "darwin", "Darwin kernel identity acceptance")
    def test_kernel_original_parent_survives_reparenting(self):
        module=str(Path(__file__).resolve().parents[2]/"lib/mini2_remote.py")
        script='''import importlib.util,json,os,sys,time
spec=importlib.util.spec_from_file_location("remote",sys.argv[1]); m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
print(json.dumps(m.identity(os.getpid())),flush=True)
pid=os.fork()
if pid:
 print(pid,flush=True); os._exit(0)
os.setsid(); os.close(1); os.close(2); time.sleep(5); os._exit(0)
'''
        parent=subprocess.Popen([sys.executable,"-c",script,module],stdout=subprocess.PIPE,text=True)
        child=None
        try:
            original=json.loads(parent.stdout.readline())
            child=int(parent.stdout.readline())
            parent.wait(timeout=3)
            row=m.identity(child)
            self.assertIsNotNone(row)
            self.assertEqual(row["originalParentVersion"],original["version"])
            self.assertEqual(row["ppid"],1)
            self.assertEqual(set(m.attributed({child:row},{original["version"]:True})),{child})
        finally:
            if child:
                row=m.identity(child)
                if row: m.signal_owned(row,signal.SIGTERM)
            if parent.poll() is None: parent.terminate(); parent.wait(timeout=3)
            parent.stdout.close()

    def test_interactive_and_indexing_processes_are_ignored_but_escaped_child_is_owned(self):
        ownership={1:False,10:True}
        # Chrome and Spotlight can start during the run; a detached browser
        # helper can also start afterwards with an already-exited parent.
        rows={20:dict(pid=20,version=20,originalParentVersion=1,ppid=1,label="Chrome during"),
              21:dict(pid=21,version=21,originalParentVersion=10,ppid=1),
              22:dict(pid=22,version=22,originalParentVersion=999,ppid=1,label="Chrome after"),
              23:dict(pid=23,version=23,originalParentVersion=1,ppid=1,label="Spotlight during")}
        self.assertEqual(set(m.attributed(rows,ownership)),{21})
        self.assertFalse(ownership[20]); self.assertTrue(ownership[21]); self.assertNotIn(22,ownership)

    def test_cleanup_settles_exiting_children_but_retains_survivors(self):
        row=dict(pid=42,ppid=1,pgid=42,uid=1,start=[10,22])
        with patch.object(m,"processes",side_effect=[{42:row},{},{}]),patch.object(m.time,"sleep"):
            self.assertEqual(m.settle({}),{})
        with patch.object(m,"processes",return_value={42:row}):
            self.assertEqual(m.settle({},timeout=0),{42:row})

    def test_pid_identity_and_reuse(self):
        row=dict(pid=42,ppid=1,pgid=42,uid=1,start=[10,22])
        with patch.object(m,"identity",return_value={**row,"start":[10,23]}),patch.object(m.os,"kill") as kill:
            with self.assertRaises(RuntimeError): m.signal_owned(row,signal.SIGTERM)
            kill.assert_not_called()
        self.assertEqual(m.born({42:row},{42:{**row,"start":[11,1]}}),{42:{**row,"start":[11,1]}})
        with patch.object(m,"identity",side_effect=RuntimeError("unreadable")),patch.object(m.os,"kill") as kill:
            with self.assertRaises(RuntimeError): m.signal_owned(row,signal.SIGTERM)
            kill.assert_not_called()

    def test_partial_upload_cleanup_and_no_replay(self):
        with tempfile.TemporaryDirectory() as temp,patch.object(m,"ROOT",Path(temp)/"runner"),patch.object(m,"disk_gate"):
            data=dict(runId=str(uuid.uuid4()),diskGiB=1,uploads={"source.bundle":"fixture"})
            with contextlib.redirect_stdout(io.StringIO()): m.prepare(data)
            with self.assertRaises(FileExistsError): m.prepare(data)
            run=m.location(data["runId"]); (run/"source.bundle").write_text("partial")
            with patch.object(subprocess,"run",return_value=subprocess.CompletedProcess([],1,"","")),contextlib.redirect_stdout(io.StringIO()): m.clean(data)
            self.assertFalse((run/"source.bundle").exists())
            self.assertTrue(json.loads((run/"clean.json").read_text())["neverLaunched"])

    def test_cleanup_fails_closed_on_open_files_or_missing_receipt(self):
        with tempfile.TemporaryDirectory() as temp,patch.object(m,"ROOT",Path(temp)/"runner"),patch.object(m,"disk_gate"):
            data=dict(runId=str(uuid.uuid4()),diskGiB=1,uploads={})
            with contextlib.redirect_stdout(io.StringIO()): m.prepare(data)
            run=m.location(data["runId"])
            with patch.object(subprocess,"run",return_value=subprocess.CompletedProcess([],0,"p42\n","")):
                with self.assertRaises(RuntimeError): m.clean(data)
            (run/"launched").touch()
            with self.assertRaises(FileNotFoundError): m.clean(data)
            self.assertTrue(run.exists())

    def test_artifact_symlinks_are_not_followed(self):
        with tempfile.TemporaryDirectory() as temp,patch.object(m,"ROOT",Path(temp)/"runner"):
            run=m.location(str(uuid.uuid4())); run.mkdir(); (run/"work").mkdir()
            m.atomic(run/"receipt.json",{})
            outside=Path(temp)/"outside"; outside.write_text("fixture")
            (run/"work"/"artifact").symlink_to(outside)
            with self.assertRaises(RuntimeError): m.collect(dict(runId=run.name,artifacts=["artifact"]))
            self.assertEqual(outside.read_text(),"fixture")

if __name__ == "__main__": unittest.main()
