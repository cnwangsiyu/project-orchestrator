#!/usr/bin/env python3
"""Destructive boundaries tested entirely with fixtures/mocks; never real signals."""
import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import inventory as inv

spec = importlib.util.spec_from_file_location("guarded", inv.BASE / "guarded-cleanup.py")
g = importlib.util.module_from_spec(spec)
spec.loader.exec_module(g)
launch_spec = importlib.util.spec_from_file_location("launcher", inv.BASE / "launch-nightly.py")
launcher = importlib.util.module_from_spec(launch_spec)
launch_spec.loader.exec_module(launcher)
POLICY = json.loads((inv.BASE / "protect.json").read_text())


def proc(pid=100, ppid=1, category="node_test_leftover", action="terminate_after_release"):
    return {"pid": pid, "ppid": ppid, "identity": str(pid) + ":START:HASH", "started": "START",
            "command_hash": "HASH", "command": "node /tmp/old-test.js", "cwd": "/tmp/old-task",
            "category": category, "protected_reasons": [], "proposed_action": action,
            "cpu_percent": 0., "sample_cpu_percent": 0., "cpu_seconds": 0.,
            "elapsed_seconds": 10000., "rss_kib": 1024, "uid": inv.os.getuid(),
            "state": "S", "parent_chain": [{"pid": pid, "ppid": ppid}],
            "owner": {"project": "test", "task": "T1", "status": "done"},
            "owner_task_quiet": True, "observed_idle_seconds": 7200}


def snapshot(rows=None):
    return {"complete": True, "captured_epoch": time.time(), "processes": rows or [proc()],
            "candidates": rows or [proc()], "orchestrators": ["A", "B"],
            "policy_hash": inv.hashlib.sha256(json.dumps(POLICY, sort_keys=True).encode()).hexdigest()}


def claims(snap):
    ids = [p["identity"] for p in snap["processes"]]
    now = time.time()
    return {"announced_epoch": now - 30, "deadline_epoch": now + 1170,
            "announced_identities": ids, "replies": {n: {"state": "answered",
            "released_identities": ids, "claimed_identities": []} for n in snap["orchestrators"]}}


class ProtectionTests(unittest.TestCase):
    def test_shell_dry_never_launches_session_or_writes_health(self):
        with tempfile.TemporaryDirectory(dir=inv.BASE) as tmp:
            folder = Path(tmp)
            (folder / "mini-nightly-cleanup.sh").write_text((inv.BASE / "mini-nightly-cleanup.sh").read_text())
            stub = folder / "inventory.sh"
            stub.write_text('#!/bin/bash\nprintf "{}\\n"\n')
            stub.chmod(0o755)
            p = inv.subprocess.run(["/bin/bash", str(folder / "mini-nightly-cleanup.sh")], capture_output=True, text=True, env={**inv.os.environ, "HOME": tmp, "MINI_CLEANUP_MODE": "dry"})
            self.assertEqual(p.returncode, 0)
            self.assertIn("DRY: would coordinate", p.stderr)
            self.assertFalse((folder / ".claude").exists())

    def test_launcher_same_day_idempotence_and_no_old_worker_stop(self):
        with tempfile.TemporaryDirectory(dir=inv.BASE) as tmp, patch.object(launcher.Path, "home", return_value=Path(tmp)), patch.dict(launcher.os.environ, {"MINI_CLEANUP_MODE": "apply"}), patch.object(launcher, "agents", return_value=[{"name": "mini-nightly-cleanup-2020-01-01", "id": "abcdef12"}, {"name": "mini-nightly-cleanup-2020-01-01-other", "id": "abcdef13"}, {"name": "Webview 问题跟进主对话", "id": "abcdef14"}]), patch.object(launcher.subprocess, "run", return_value=SimpleNamespace(returncode=0)) as run:
            with self.assertRaises(RuntimeError):
                launcher.main()
            run.assert_not_called()
            with patch.object(launcher, "agents", return_value=[]):
                self.assertEqual(launcher.main(), 0)
            self.assertEqual(launcher.main(), 0)
            self.assertEqual(run.call_count, 1)
            self.assertIn("--remote-control", run.call_args_list[0].args[0])
            self.assertIn("bypassPermissions", run.call_args_list[0].args[0])

    def test_ps_columns_and_start_identity(self):
        line = "101 1 501 01:30:00 123.4 4096 S 01:12:00 Fri Nov 13 01:00:00 2026 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --restore-last-session\n"
        with patch.object(inv, "run", return_value=(line, None)):
            rows, errors = inv.processes()
        self.assertEqual(errors, [])
        self.assertEqual(rows[101]["started"], "Fri Nov 13 01:00:00 2026")
        self.assertEqual(rows[101]["elapsed_seconds"], 5400)
        self.assertTrue(rows[101]["_command"].endswith("--restore-last-session"))

    def test_secret_argument_redaction(self):
        x = inv.redact("node --api-key secret --token=secret https://name:password@x/a?token=secret Bearer secret")
        self.assertNotIn("secret", x)
        self.assertNotIn("password", x)

    def test_arbitrary_prompt_arguments_never_reported(self):
        self.assertEqual(inv.display_command("node -e 'const PRIVATE_API_KEY = secret'"), "node")
        self.assertEqual(inv.display_command("claude --bg some arbitrary private prompt"), "claude")
        self.assertTrue(inv.display_command(POLICY["chrome"]["binary"] + " --headless=new").endswith("--headless"))
        self.assertEqual(inv.display_command("TOKEN=private node script.js"), "unknown")

    def test_categories_chrome_and_headless(self):
        binary = POLICY["chrome"]["binary"]
        self.assertEqual(inv.category(binary), "gui_chrome")
        self.assertEqual(inv.category(binary + " --headless"), "headless_browser")
        self.assertEqual(inv.category("/tmp/playwright/chromium --remote-debugging-pipe"), "headless_browser")
        self.assertEqual(inv.category("/Applications/Xcode.app/Contents/Developer/Toolchains/x/usr/bin/clang a.cpp"), "xcode_build_tool")
        self.assertEqual(inv.category("/Applications/Xcode.app/Contents/MacOS/Xcode"), "gui_app")

    def test_path_boundary(self):
        self.assertTrue(inv.command_in("node /tmp/task/a/test.js", "/tmp/task/a"))
        self.assertFalse(inv.command_in("node /tmp/task/abc/test.js", "/tmp/task/a"))

    def test_collect_protects_agent_task_lease_service_but_not_all_pid1_children(self):
        rows = {}
        fixtures = [(1, 0, "/sbin/launchd"), (10, 1, "claude --bg"),
                    (20, 10, "node old.js"), (100, 1, "node old.js"),
                    (200, 1, "node /tmp/live/test.js"),
                    (250, 1, "node service.js"), (300, 1, "pymobiledevice3 remote start-tunnel")]
        for pid, ppid, cmd in fixtures:
            p = proc(pid, ppid)
            p["_command"] = cmd
            rows[pid] = p
        cwds = {pid: "/tmp/free" for pid in rows}
        cwds[10] = "/tmp/agent-task"
        with patch.object(inv, "task_owners", return_value=({}, [])), patch.object(inv, "processes", side_effect=lambda: (copy.deepcopy(rows), [])), patch.object(inv, "cwd_map", return_value=(cwds, [])), patch.object(inv, "managed_pids", return_value=({250}, [])), patch.object(inv, "session_dirs", return_value=(["/tmp/live"], [], [])), patch.object(inv, "leases", return_value=([{"kind": "device"}], [])), patch.object(inv, "roster", return_value=(["A", "B"], [])), patch.object(inv, "health", return_value={}), patch.object(inv.time, "sleep"):
            s = inv.collect(POLICY)
        result = {p["pid"]: p for p in s["processes"]}
        self.assertEqual(result[100]["proposed_action"], "report_only")  # PPID=1 alone is no longer enough.
        for pid in (1, 10, 20, 200, 250, 300):
            self.assertEqual(result[pid]["proposed_action"], "report_only")
            self.assertTrue(result[pid]["protected_reasons"])

    def test_dry_mode_cannot_apply(self):
        with tempfile.TemporaryDirectory(dir=inv.BASE) as tmp:
            s = snapshot()
            ip, cp = Path(tmp) / "inventory.json", Path(tmp) / "claims.json"
            ip.write_text(json.dumps(s))
            cp.write_text(json.dumps(claims(s)))
            with patch.object(g.sys, "argv", ["guarded-cleanup.py", "--inventory", str(ip), "--claims", str(cp), "--apply"]), patch.dict(g.os.environ, {"MINI_CLEANUP_MODE": "dry"}), patch.object(g, "execute_action") as execute:
                self.assertEqual(g.main(), 2)
                execute.assert_not_called()

    def test_no_idle_or_high_cpu_from_age_alone(self):
        p = proc()
        p["cpu_percent"] = p["sample_cpu_percent"] = 200
        evidence = inv.history_evidence(p, [], 10000, POLICY["thresholds"])
        self.assertEqual(evidence["observed_high_cpu_seconds"], 0)
        self.assertEqual(evidence["observed_idle_seconds"], 0)

    def test_terminal_owner_and_quiet_evidence_required(self):
        for field, value in [("owner", {}), ("owner_task_quiet", False), ("observed_idle_seconds", 7199), ("owner", {"status": "running"})]:
            s = snapshot()
            s["processes"][0][field] = value
            self.assertEqual(g.plan(s, claims(s), POLICY)["actions"], [])

    def test_owner_activity_or_unknown_activity_veto(self):
        owner = {"project": "test", "task": "T1", "status": "done", "changedAt": 1000, "activityAt": None}
        self.assertTrue(inv.owner_quiet(owner, 10000, 7200, 1000))
        self.assertFalse(inv.owner_quiet(owner, 10000, 7200, None))
        self.assertFalse(inv.owner_quiet(owner, 10000, 7200, 9999))
        owner["activityAt"] = 9999000
        self.assertFalse(inv.owner_quiet(owner, 10000, 7200, 1000))

    def test_collect_terminal_quiet_owner_positive_and_recent_activity_veto(self):
        now = time.time()
        p = proc()
        p["_command"] = "node old.test.js"
        owned = {"100": {"project": "test", "task": "T1", "status": "done", "changedAt": (now - 9000) * 1000,
                          "taskDir": "/tmp/orchestrator/test/tasks/T1", "evidence": "path"}}
        histories = [{"complete": True, "captured_epoch": now - t, "processes": [copy.deepcopy(p)]} for t in range(9000, 0, -300)]
        with patch.object(inv, "task_owners", return_value=(owned, [])), patch.object(inv, "task_activity", return_value=now - 9000) as activity, patch.object(inv, "processes", side_effect=lambda: ({100: copy.deepcopy(p)}, [])), patch.object(inv, "cwd_map", return_value=({100: "/tmp/free"}, [])), patch.object(inv, "managed_pids", return_value=(set(), [])), patch.object(inv, "session_dirs", return_value=([], [], [])), patch.object(inv, "leases", return_value=([], [])), patch.object(inv, "roster", return_value=(["A", "B"], [])), patch.object(inv, "health", return_value={}), patch.object(inv.time, "sleep"):
            result = inv.collect(POLICY, histories)
            self.assertEqual(result["processes"][0]["proposed_action"], "terminate_after_release")
            activity.return_value = now
            self.assertEqual(inv.collect(POLICY, histories)["processes"][0]["proposed_action"], "report_only")
            activity.return_value = now - 9000
            owned["100"]["evidence"] = "inferred-worktree-id"
            self.assertEqual(inv.collect(POLICY, histories)["processes"][0]["proposed_action"], "report_only")

    def test_continuous_history_and_gap_veto(self):
        p = proc()
        histories = [{"complete": True, "captured_epoch": t, "processes": [copy.deepcopy(p)]} for t in range(1000, 8200, 300)]
        self.assertEqual(inv.history_evidence(p, histories, 8200, POLICY["thresholds"])["observed_idle_seconds"], 7200)
        self.assertEqual(inv.history_evidence(p, histories[:1], 8200, POLICY["thresholds"])["observed_idle_seconds"], 0)

    def test_incomplete_or_missing_process_sample_breaks_continuity(self):
        p = proc()
        histories = [{"complete": True, "captured_epoch": t, "processes": [copy.deepcopy(p)]} for t in range(1000, 8200, 300)]
        histories[-2]["complete"] = False
        self.assertLess(inv.history_evidence(p, histories, 8200, POLICY["thresholds"])["observed_idle_seconds"], 7200)
        histories[-2]["complete"] = True
        histories[-2]["processes"] = []
        self.assertLess(inv.history_evidence(p, histories, 8200, POLICY["thresholds"])["observed_idle_seconds"], 7200)

    def test_resource_jsonl_adapter_keeps_identity_and_failure_barrier(self):
        with tempfile.TemporaryDirectory(dir=inv.BASE) as tmp:
            file = Path(tmp) / "resource-log.jsonl"
            row = {"schema": 1, "host": inv.os.uname().nodename, "t": 1000000, "processComplete": True, "attributionComplete": True,
                   "processes": [{"id": "100:START:HASH", "cpuSeconds": 10, "cpuPct": 0}]}
            failed = {**row, "t": 1300000, "processComplete": False}
            file.write_text(json.dumps(row) + "\n" + json.dumps(failed) + "\n")
            history = inv.resource_history(file, now=2000)
            self.assertEqual(history[0]["processes"][0]["identity"], "100:START:HASH")
            self.assertFalse(history[1]["complete"])

    def test_every_recipient_release_required(self):
        s = snapshot()
        c = claims(s)
        self.assertEqual(len(g.plan(s, c, POLICY)["actions"]), 1)
        c["replies"]["B"]["state"] = "timeout"
        self.assertEqual(g.plan(s, c, POLICY)["actions"], [])
        c["replies"]["B"]["state"] = "answered"
        c["replies"]["A"]["claimed_identities"] = [s["processes"][0]["identity"]]
        self.assertEqual(g.plan(s, c, POLICY)["actions"], [])

    def test_new_recipient_and_unannounced_identity_veto(self):
        s = snapshot()
        c = claims(s)
        s["orchestrators"].append("C")
        self.assertEqual(g.plan(s, c, POLICY)["actions"], [])
        s["orchestrators"].pop()
        c["announced_identities"] = []
        self.assertEqual(g.plan(s, c, POLICY)["actions"], [])

    def test_incomplete_stale_changed_policy(self):
        for change in ({"complete": False}, {"captured_epoch": 1}, {"policy_hash": "other"}):
            s = snapshot()
            c = claims(s)
            s.update(change)
            self.assertEqual(g.plan(s, c, POLICY)["actions"], [])

    def test_protected_child_veto_and_pid_reuse(self):
        root, child = proc(), proc(101, 100)
        child["protected_reasons"] = ["live_task_directory"]
        s = snapshot([root, child])
        self.assertEqual(g.plan(s, claims(s), POLICY)["actions"], [])
        action = {"root_pid": 100, "members": [root]}
        s = snapshot()
        s["processes"][0]["identity"] = "100:OTHER:HASH"
        self.assertEqual(g.current_members(action, s), [])

    def test_new_child_veto_after_term(self):
        action = {"root_pid": 100, "members": [proc()]}
        with self.assertRaises(RuntimeError):
            g.current_members(action, snapshot([proc(), proc(101, 100)]))

    def test_reopened_owner_recent_activity_or_changed_owner_vetoes_survivors(self):
        s = snapshot()
        action = g.plan(s, claims(s), POLICY)["actions"][0]
        for field, value in [("owner_task_quiet", False), ("owner", {"status": "running"}), ("owner", {"project": "other", "task": "T2", "status": "done"})]:
            changed = snapshot()
            changed["processes"][0][field] = value
            with self.assertRaises(RuntimeError):
                g.current_members(action, changed)

    def test_pid_revalidation_never_signals_replacement(self):
        replacement = proc()
        replacement["identity"] = "100:NEW:HASH"
        with patch.object(inv, "processes", return_value=({100: replacement}, [])), patch.object(g.os, "kill") as kill:
            self.assertFalse(g.signal_member(proc(), g.signal.SIGTERM))
            kill.assert_not_called()

    def test_headless_descendant_vetoes_gui_restart(self):
        root = proc(category="gui_chrome", action="restart_chrome_after_release")
        root["command"] = POLICY["chrome"]["binary"]
        child = proc(101, 100, category="headless_browser")
        s = snapshot([root, child])
        self.assertEqual(g.plan(s, claims(s), POLICY)["actions"], [])

    def test_chrome_restart_in_finally_after_partial_failure(self):
        root = proc(category="gui_chrome", action="restart_chrome_after_release")
        root["command"] = POLICY["chrome"]["binary"]
        s = snapshot([root])
        c = claims(s)
        a = g.plan(s, c, POLICY)["actions"][0]
        events = []
        with patch.object(g.os, "access", return_value=True), patch.object(inv, "collect", side_effect=[s, s]), patch.object(g, "signal_member", return_value=True), patch.object(inv, "processes", return_value=({}, ["inspection denied"])), patch.object(g, "restore_chrome", return_value={"status": "verified"}) as restore:
            with self.assertRaises(RuntimeError):
                g.execute_action(a, c, POLICY, [], inv.BASE, events)
            restore.assert_called_once()
        self.assertTrue(any("chrome_restore" in e for e in events))

    def test_chrome_restore_direct_binary_host_log(self):
        def popen(argv, **kwargs):
            self.assertEqual(argv[:2], ["/usr/bin/nohup", POLICY["chrome"]["binary"]])
            self.assertIn("--restore-last-session", argv)
            kwargs["stdout"].write(b"Claude Chrome Native Host status: ready\n")
            kwargs["stdout"].flush()
        with tempfile.TemporaryDirectory(dir=inv.BASE) as tmp, patch.object(g.subprocess, "Popen", side_effect=popen), patch.object(g, "chrome_up", return_value=True):
            self.assertEqual(g.restore_chrome(POLICY, Path(tmp))["status"], "verified")

    def test_chrome_host_missing_retries_once(self):
        with tempfile.TemporaryDirectory(dir=inv.BASE) as tmp, patch.object(g.subprocess, "Popen") as launch, patch.object(g, "chrome_up", return_value=True), patch.object(g.time, "monotonic", side_effect=[0, 100, 200, 300]):
            result = g.restore_chrome(POLICY, Path(tmp))
        self.assertEqual(launch.call_count, 2)
        self.assertTrue(result["status"].startswith("BLOCKED"))

    def test_chrome_startup_is_not_browser_reconnect_and_missing_restore_blocks(self):
        record = {"status": "completed", "browser_connection": "pending", "events": [
            {"root_identity": "chrome", "chrome_restoration_required": True},
            {"root_identity": "chrome", "chrome_restore": {"status": "verified"}}]}
        self.assertTrue(inv.unfinished_recovery(record))
        record["browser_connection"] = "verified"
        self.assertFalse(inv.unfinished_recovery(record))
        record["events"].pop()
        self.assertTrue(inv.unfinished_recovery(record))

    def test_chrome_binary_launch_failure_retries_once(self):
        with tempfile.TemporaryDirectory(dir=inv.BASE) as tmp, patch.object(g.subprocess, "Popen", side_effect=OSError("launch failed")) as launch:
            result = g.restore_chrome(POLICY, Path(tmp))
        self.assertEqual(launch.call_count, 2)
        self.assertTrue(result["status"].startswith("BLOCKED"))


if __name__ == "__main__":
    unittest.main()
