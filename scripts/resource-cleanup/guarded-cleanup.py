#!/usr/bin/env python3
"""Plan by default. Apply only with MINI_CLEANUP_MODE=apply and explicit --apply.

All signals use exact revalidated PIDs; no pkill, process groups, devices or files.
"""
import argparse
import datetime as dt
import fcntl
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import time

import inventory as inv


def subtree(root, snap):
    rows = {p["pid"]: p for p in snap["processes"]}
    return [p for p in rows.values() if root in inv.chain(p["pid"], rows)]


def released(identity, claims, roster):
    if identity not in claims.get("announced_identities", []):
        return False
    for name in roster:
        r = claims.get("replies", {}).get(name, {})
        if r.get("state") != "answered" or identity in r.get("claimed_identities", []) or identity not in r.get("released_identities", []):
            return False
    return bool(roster)


def coordination_valid(claims, policy, now=None):
    now = time.time() if now is None else now
    announced, deadline = claims.get("announced_epoch", 0), claims.get("deadline_epoch", 0)
    return 0 <= now - announced <= policy["thresholds"]["coordination_seconds"] + 300 and announced < deadline <= announced + policy["thresholds"]["coordination_seconds"]


def plan(snap, claims, policy, now=None):
    now = time.time() if now is None else now
    reasons, actions = [], []
    if not snap.get("complete"):
        reasons.append("inventory_incomplete")
    if snap.get("policy_hash") != inv.hashlib.sha256(json.dumps(policy, sort_keys=True).encode()).hexdigest():
        reasons.append("policy_changed")
    age = now - snap.get("captured_epoch", 0)
    if age < 0 or age > policy["thresholds"]["max_inventory_age_seconds"]:
        reasons.append("inventory_stale")
    # Replies must belong to this run and original announcement, not yesterday.
    announced = claims.get("announced_epoch", 0)
    deadline = claims.get("deadline_epoch", 0)
    if not coordination_valid(claims, policy, now):
        reasons.append("coordination_stale_or_invalid")
    if not snap.get("orchestrators"):
        reasons.append("no_orchestrator_roster")
    if reasons:
        return {"actions": [], "vetoes": reasons}
    covered = set()
    candidates = sorted(snap["candidates"], key=lambda p: len(p["parent_chain"]))
    for p in candidates:
        if p["pid"] in covered or p["proposed_action"] == "report_only":
            continue
        tree = subtree(p["pid"], snap)
        veto = None
        if p["proposed_action"] == "restart_chrome_after_release":
            # Only the main GUI application, not a helper, Chromium or test browser.
            binary = policy["chrome"]["binary"]
            if not p["command"].startswith(binary) or p["ppid"] in {x["pid"] for x in snap["processes"] if x["category"] == "gui_chrome"}:
                veto = "not_main_gui_chrome"
        for q in tree:
            if q["protected_reasons"]:
                veto = "protected_tree_member:%s" % q["pid"]
            if not released(q["identity"], claims, snap["orchestrators"]):
                veto = "not_explicitly_released:%s" % q["pid"]
            if p["proposed_action"] == "restart_chrome_after_release":
                if q["category"] != "gui_chrome" or re.search(policy["chrome"]["exclude_regex"], q["command"]):
                    veto = "non_gui_or_headless_member:%s" % q["pid"]
            elif q["category"] not in policy["killable_categories"]:
                veto = "unknown_tree_member:%s" % q["pid"]
            elif not q.get("owner_task_quiet") or q.get("owner", {}).get("status") not in inv.TERMINAL or q.get("observed_idle_seconds", 0) < policy["thresholds"]["idle_seconds"]:
                veto = "terminal_owner_and_continuous_idle_required:%s" % q["pid"]
        if veto:
            reasons.append("%s:%s" % (p["identity"], veto))
            # A veto of a parent is a veto of its tree, never permission to
            # reconsider one of its children as an independent cleanup target.
            covered.update(q["pid"] for q in tree)
            continue
        action = {"root_pid": p["pid"], "root_identity": p["identity"], "action": p["proposed_action"],
                  "idle_seconds": policy["thresholds"]["idle_seconds"],
                  "members": [{**{k: q[k] for k in ("pid", "identity", "command_hash", "started", "ppid", "cwd", "category")},
                               "owner_project": q.get("owner", {}).get("project"), "owner_task": q.get("owner", {}).get("task")} for q in tree]}
        actions.append(action)
        covered.update(q["pid"] for q in tree)
    return {"actions": actions, "vetoes": reasons}


def current_members(action, snap):
    original = {m["pid"]: m for m in action["members"]}
    current = {p["pid"]: p for p in snap["processes"]}
    surviving = []
    for pid, m in original.items():
        if pid not in current or current[pid]["identity"] != m["identity"]:
            continue  # already exited / PID reused: never signal the replacement
        if current[pid]["cwd"] != m["cwd"] or current[pid]["protected_reasons"]:
            raise RuntimeError("tree became protected or changed cwd: %s" % pid)
        if action.get("action") != "restart_chrome_after_release":
            p = current[pid]
            if not p.get("owner_task_quiet") or p.get("owner", {}).get("status") not in inv.TERMINAL or p.get("observed_idle_seconds", 0) < action.get("idle_seconds", 7200):
                raise RuntimeError("owner/task activity changed: %s" % pid)
            if "owner_project" in m and (m["owner_project"], m["owner_task"]) != (p.get("owner", {}).get("project"), p.get("owner", {}).get("task")):
                raise RuntimeError("process owner changed: %s" % pid)
        surviving.append(current[pid])
    # After TERM, descendants may reparent. Original identities remain the only
    # permitted set; newly spawned descendants veto further signals.
    for m in surviving:
        for q in subtree(m["pid"], snap):
            if q["pid"] not in original or q["identity"] != original[q["pid"]]["identity"]:
                raise RuntimeError("new descendant; needs new coordination")
    return surviving


def signal_member(member, sig):
    # One last lightweight PID/start/hash check immediately before the signal.
    rows, errors = inv.processes()
    if errors:
        raise RuntimeError("cannot revalidate PID immediately before signal")
    p = rows.get(member["pid"])
    if p is None or p["identity"] != member["identity"]:
        return False
    try:
        os.kill(p["pid"], sig)
        return True
    except ProcessLookupError:
        return False


def chrome_up(policy):
    rows, errors = inv.processes()
    if errors:
        return False
    binary = policy["chrome"]["binary"]
    return any(p["uid"] == os.getuid() and p["_command"].startswith(binary) and not re.search(policy["chrome"]["exclude_regex"], p["_command"]) for p in rows.values())


def restore_chrome(policy, logdir):
    """Direct binary via nohup, fresh attempt logs, one retry, no profile reads."""
    binary = policy["chrome"]["binary"]
    results = []
    for attempt in range(1, policy["chrome"]["restart_attempts"] + 1):
        logfile = logdir / ("chrome-relaunch-%s-%d-%d.log" % (dt.datetime.now().strftime("%Y%m%dT%H%M%S"), time.time_ns(), attempt))
        try:
            with logfile.open("xb") as out:
                subprocess.Popen(["/usr/bin/nohup", binary] + policy["chrome"]["args"],
                                 stdout=out, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
                                 start_new_session=True)
        except OSError as e:
            results.append({"attempt": attempt, "error": str(e), "log": str(logfile)})
            continue  # launch failures also get exactly one retry
        deadline = time.monotonic() + policy["thresholds"]["chrome_start_wait_seconds"]
        host_seen = False
        while time.monotonic() < deadline:
            # Read only this new stdout log; never extension storage or profiles.
            data = logfile.read_text(errors="replace")[-262144:]
            host_seen = bool(re.search(policy["chrome"]["native_host_log_regex"], data))
            if chrome_up(policy) and host_seen:
                return {"status": "verified", "attempts": attempt, "log": str(logfile)}
            time.sleep(3)
        results.append({"attempt": attempt, "main_process_up": chrome_up(policy),
                        "native_host_log_seen": host_seen, "log": str(logfile)})
        # If Chrome is already running, invoking the binary again asks that
        # instance to restore; never kill an uncoordinated replacement instance.
    return {"status": "BLOCKED_browser_connection_unverified", "attempts": results}


def execute_action(action, claims, policy, histories, logdir, events, claims_path=None):
    chrome = action["action"] == "restart_chrome_after_release"
    if chrome and not os.access(policy["chrome"]["binary"], os.X_OK):
        raise RuntimeError("Chrome binary unavailable; refusing termination")
    restoration_needed = False
    def fresh(sample=None):
        if json.loads((inv.BASE / "protect.json").read_text()) != policy:
            raise RuntimeError("policy changed during execution")
        return inv.collect(policy, histories, sample_seconds=sample)

    def releases():
        return inv.read_metadata(claims_path, "claims") if claims_path else claims
    try:
        snapshot = fresh()
        if not snapshot["complete"]:
            raise RuntimeError("fresh inventory incomplete")
        replanned = plan(snapshot, releases(), policy)
        match = next((a for a in replanned["actions"] if a["root_identity"] == action["root_identity"]), None)
        if match is None or {m["identity"] for m in match["members"]} != {m["identity"] for m in action["members"]}:
            raise RuntimeError("tree/eligibility changed since plan")
        members = current_members(action, snapshot)
        # Root first: stop its creation of children, then only the original tree.
        members.sort(key=lambda p: len(p["parent_chain"]))
        for p in members:
            # Re-read lease/task/claim protections before EACH signal.
            check = fresh(0.1)
            live_claims = releases()
            if not check["complete"] or not coordination_valid(live_claims, policy) or not released(p["identity"], live_claims, check["orchestrators"]):
                raise RuntimeError("protection/roster unavailable or new claim required")
            valid = next((q for q in current_members(action, check) if q["identity"] == p["identity"]), None)
            if valid:
                restoration_needed = restoration_needed or chrome
                events.append({"identity": p["identity"], "root_identity": action["root_identity"], "attempting_signal": "SIGTERM", "chrome_restoration_required": restoration_needed})
                sent = signal_member(valid, signal.SIGTERM)
                events.append({"identity": p["identity"], "signal": "SIGTERM", "sent": sent})
        deadline = time.monotonic() + policy["thresholds"]["term_wait_seconds"]
        while time.monotonic() < deadline:
            rows, err = inv.processes()
            if err:
                raise RuntimeError("cannot inspect TERM survivors")
            if not any(rows.get(m["pid"], {}).get("identity") == m["identity"] for m in action["members"]):
                break
            time.sleep(2)
        snapshot = fresh()
        if not snapshot["complete"]:
            raise RuntimeError("cannot authorize SIGKILL with incomplete inventory")
        for p in current_members(action, snapshot):
            check = fresh(0.1)
            live_claims = releases()
            if not check["complete"] or not coordination_valid(live_claims, policy) or not released(p["identity"], live_claims, check["orchestrators"]):
                raise RuntimeError("new protection/roster vetoes SIGKILL")
            valid = next((q for q in current_members(action, check) if q["identity"] == p["identity"]), None)
            if valid:
                sent = signal_member(valid, signal.SIGKILL)
                events.append({"identity": p["identity"], "signal": "SIGKILL", "sent": sent})
        exit_deadline = time.monotonic() + 5
        while True:
            rows, err = inv.processes()
            survivors = [m["identity"] for m in action["members"] if rows.get(m["pid"], {}).get("identity") == m["identity"]]
            if err or not survivors or time.monotonic() >= exit_deadline:
                break
            time.sleep(0.5)
        events.append({"original_survivors": survivors, "verification_errors": err})
        if err or survivors:
            raise RuntimeError("original process exits remain unverified")
    finally:
        # Includes interrupts/errors AFTER the first termination attempt.
        if chrome and restoration_needed:
            events.append({"root_identity": action["root_identity"], "chrome_restore": restore_chrome(policy, logdir)})


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--inventory", required=True)
    ap.add_argument("--claims", required=True)
    ap.add_argument("--history", action="append", default=[])
    ap.add_argument("--resource-log", default=str(inv.SHARED / "resource-log.jsonl"))
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--log-dir", default=str(inv.SHARED / "resource-cleanup"))
    args = ap.parse_args()
    policy = json.loads((inv.BASE / "protect.json").read_text())
    snap = inv.read_metadata(args.inventory, "inventory")
    claims = inv.read_metadata(args.claims, "claims")
    decision = plan(snap, claims, policy)
    if not args.apply:
        print(json.dumps(decision, indent=2, ensure_ascii=False))
        return 0
    if os.environ.get("MINI_CLEANUP_MODE") != "apply":
        print("BLOCKED: --apply requires MINI_CLEANUP_MODE=apply", file=sys.stderr)
        return 2
    histories = [inv.read_metadata(x, "inventory") for x in args.history] + inv.resource_history(args.resource_log) + [snap]
    logdir = Path(args.log_dir).resolve()
    logdir.mkdir(parents=True, exist_ok=True)
    execution_lock = (logdir / "execution.lock").open("a")
    try:
        fcntl.flock(execution_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        execution_lock.close()
        print("BLOCKED: another executor is running", file=sys.stderr)
        return 2
    for previous in list(logdir.glob("actions-*.json")) + list(logdir.glob("disk-actions-*.json")):
        record = inv.read_audit(previous)
        if inv.unfinished_recovery(record):
            execution_lock.close()
            print("BLOCKED: prior execution/Chrome recovery requires review", file=sys.stderr)
            return 2
    audit = logdir / ("actions-%s-%s.json" % (dt.datetime.now().strftime("%Y%m%dT%H%M%S"), os.getpid()))
    class Journal(list):
        def append(self, item):
            super().append(item)
            checkpoint()
    events = Journal()
    result = {"status": "running", "plan": decision, "events": events}
    def checkpoint():
        with audit.open("w") as out:
            json.dump(result, out, indent=2, ensure_ascii=False)
            out.flush()
            os.fsync(out.fileno())
    with audit.open("x") as out:
        json.dump(result, out, indent=2, ensure_ascii=False)
    rc = 0
    try:
        for action in decision["actions"]:
            execute_action(action, claims, policy, histories, logdir, events, args.claims)
            if action["action"] == "restart_chrome_after_release":
                result["browser_connection"] = "pending"
                result["status"] = "BLOCKED_browser_reconnect_pending"
                rc = 2
                break  # Coordinator must verify the browser tool before more cleanup.
        if rc == 0:
            result["status"] = "completed"
        if decision["vetoes"] and not decision["actions"]:
            result["status"] = "BLOCKED_no_authorized_actions"
            rc = 2
    except (Exception, KeyboardInterrupt) as e:
        result["status"] = "BLOCKED"
        result["error"] = str(e)
        rc = 2
    finally:
        result["finished_at"] = dt.datetime.now().astimezone().isoformat()
        checkpoint()
        execution_lock.close()
        print(json.dumps(result, indent=2, ensure_ascii=False))
    if any(e.get("chrome_restore", {}).get("status", "verified") != "verified" for e in events):
        rc = 2
    return rc


if __name__ == "__main__":
    sys.exit(main())
