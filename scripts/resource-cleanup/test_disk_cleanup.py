#!/usr/bin/env python3
"""Only task-local synthetic trees; no real system cleanup."""
import copy
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import inventory as inv

spec = importlib.util.spec_from_file_location("disk", inv.BASE / "disk-cleanup.py")
d = importlib.util.module_from_spec(spec)
spec.loader.exec_module(d)


class DiskTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=inv.BASE)
        self.base = Path(self.temp.name).resolve()
        self.root = self.base / "build"
        self.root.mkdir()
        entry = {"path": str(self.root), "kind": "build_clone", "created_by": "orchestrator", "nonce": "fixture", "project": "p", "task": "T1"}
        (self.root / ".resource-build-artifact.json").write_text(json.dumps(entry))
        (self.root / "output.o").write_text("generated fixture")
        for p in list(self.root.iterdir()) + [self.root]:
            os.utime(p, (1000, 1000))
        s = self.root.stat()
        self.identity = "artifact:%s:%s:fixture" % (s.st_dev, s.st_ino)
        self.registry = {"allowed_roots": [str(self.base)], "artifacts": [entry]}
        self.snap = {"complete": True, "captured_epoch": 10000, "health": {"disk_free_bytes": 10 ** 12 - 1}, "processes": [], "live_task_dirs": [], "orchestrators": ["A", "B"], "held_resources": []}
        self.claims = {"announced_epoch": 9990, "deadline_epoch": 11000, "announced_identities": [self.identity], "replies": {n: {"state": "answered", "released_identities": [self.identity], "claimed_identities": []} for n in ("A", "B")}}
        self.tasks = [{"project": "p", "task": "T1", "status": "done", "changedAt": 1000000, "activityAt": None, "taskDir": "/tmp/orchestrator/p/tasks/T1"}]
        self.activity = patch.object(inv, "task_activity", return_value=1000)
        self.activity.start()

    def tearDown(self):
        self.activity.stop()
        self.temp.cleanup()

    def plan(self):
        return d.plan(self.snap, self.claims, self.registry, self.tasks, now=10000)

    def test_low_disk_exact_boundary_and_unknown(self):
        self.assertEqual(len(self.plan()["actions"]), 1)
        for value in (10 ** 12, 10 ** 12 + 1, None):
            self.snap["health"]["disk_free_bytes"] = value
            self.assertEqual(self.plan()["actions"], [])

    def test_all_releases_and_new_roster_required(self):
        self.claims["replies"]["B"]["state"] = "timeout"
        self.assertEqual(self.plan()["actions"], [])
        self.assertEqual(self.plan()["candidates"][0]["identity"], self.identity)
        self.claims["replies"]["B"]["state"] = "answered"
        self.snap["orchestrators"].append("C")
        self.assertEqual(self.plan()["actions"], [])

    def test_terminal_owner_recent_task_artifact_and_incomplete_veto(self):
        self.tasks[0]["status"] = "running"
        self.assertEqual(self.plan()["actions"], [])
        self.tasks[0]["status"] = "done"
        self.tasks[0]["activityAt"] = 9999000
        self.assertEqual(self.plan()["actions"], [])
        self.tasks[0]["activityAt"] = None
        with patch.object(inv, "task_activity", return_value=None):
            self.assertEqual(self.plan()["actions"], [])
        os.utime(self.root / "output.o", (9999, 9999))
        self.assertEqual(self.plan()["actions"], [])
        self.snap["complete"] = False
        self.assertEqual(self.plan()["vetoes"], ["inventory_incomplete"])

    def test_unregistered_user_tree_or_marker_mismatch_veto(self):
        self.registry["allowed_roots"] = []
        self.assertEqual(self.plan()["actions"], [])
        self.registry["allowed_roots"] = [str(self.base)]
        self.registry["artifacts"][0]["created_by"] = "user"
        self.assertEqual(self.plan()["actions"], [])
        self.registry["artifacts"][0]["created_by"] = "orchestrator"
        self.registry["artifacts"][0]["nonce"] = "wrong"
        self.assertEqual(self.plan()["actions"], [])

    def test_source_credentials_and_symlinks_refused_without_reading(self):
        for name in (".git", "auth.json", ".env", "signing.p12"):
            f = self.root / name
            f.write_text("fixture")
            with self.assertRaises(ValueError):
                d.scan_tree(self.root)
            f.unlink()
        link = self.root / "outside"
        link.symlink_to(self.base)
        with self.assertRaises(ValueError):
            d.scan_tree(self.root)

    def test_live_task_process_and_held_device_veto(self):
        self.snap["processes"] = [{"cwd": str(self.root), "owner": {}}]
        self.assertEqual(self.plan()["actions"], [])
        self.snap["processes"] = [{"cwd": "/tmp/elsewhere", "owner": {"project": "p", "task": "T1"}}]
        self.assertEqual(self.plan()["actions"], [])
        self.snap["processes"] = []
        self.snap["held_resources"] = [{"kind": "device"}]
        self.assertEqual(self.plan()["actions"], [])

    def test_descriptor_delete_only_local_fixture_and_changed_tree_refused(self):
        action = self.plan()["actions"][0]
        d.remove_artifact(action)
        self.assertFalse(self.root.exists())
        self.root.mkdir()
        (self.root / "new-user-file").write_text("fixture")
        with self.assertRaises(RuntimeError):
            d.remove_artifact(action)
        self.assertTrue((self.root / "new-user-file").exists())

    def test_metadata_names_refuse_credentials_before_open(self):
        with patch.object(Path, "read_text") as read:
            with self.assertRaises(ValueError):
                inv.read_metadata(self.base / "auth.json", "inventory")
            read.assert_not_called()

    def test_task_archive_and_shared_cache_paths_refused(self):
        original = self.registry["artifacts"][0]["path"]
        for suffix in ("orchestrator/p/tasks/T1", ".gradle/generated", "Library/Caches/generated"):
            folder = self.base / suffix
            folder.mkdir(parents=True)
            self.registry["artifacts"][0]["path"] = str(folder)
            decision = self.plan()
            self.assertEqual(decision["actions"], [])
            self.assertIn("never a disposable", decision["vetoes"][0]["reason"])
        self.registry["artifacts"][0]["path"] = original


if __name__ == "__main__":
    unittest.main()
