#!/usr/bin/env python3
"""macOS process metadata only; never inspect environments or credential files."""
import argparse
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import sys
import time

BASE = Path(__file__).resolve().parent
HOME = Path.home()
SHARED = HOME / ".claude/orchestrator/_shared"
TERMINAL = {"done", "finished", "completed", "merged", "abandoned", "cancelled", "canceled"}


def unfinished_recovery(record):
    if record.get("status") == "running":
        return True
    events = record.get("events", [])
    required = {e.get("root_identity", "legacy_unknown") for e in events if e.get("chrome_restoration_required")}
    restored = {e.get("root_identity") for e in events if e.get("chrome_restore", {}).get("status") == "verified"}
    if any(e.get("chrome_restore", {}).get("status", "verified") != "verified" for e in events):
        return True
    return bool(required) and (not required.issubset(restored) or record.get("browser_connection") != "verified")


def read_audit(file):
    p = Path(file)
    if p.is_symlink() or not re.fullmatch(r"(?:actions-\d{8}T\d{6}-\d+|disk-actions-\d+-\d+)\.json", p.name):
        raise ValueError("non-job/symlink action audit refused")
    if p.stat().st_size > 50 * 2 ** 20:
        raise ValueError("action audit too large")
    return json.loads(p.read_text())


def read_metadata(file, kind):
    """Exact artifact names; never accept credential/session storage as input."""
    p = Path(file)
    patterns = {"inventory": r"inventory(?:[-_.].*)?\.json", "claims": r"claims(?:[-_.].*)?\.json",
                "policy": r"protect\.json", "registry": r"build-artifacts\.json"}
    if not re.fullmatch(patterns[kind], p.name) or p.is_symlink() or any(re.fullmatch(r"(?i)(?:\.aws|\.codex|cookies?|credentials?|keychains?|auth)", part) for part in p.parts):
        raise ValueError("non-job/credential-like metadata path refused")
    if p.stat().st_size > 50 * 2 ** 20:
        raise ValueError("metadata too large")
    return json.loads(p.read_text())


def task_owners(rows, cwd):
    """Use the sampler's attribution contract, never a second ownership heuristic."""
    payload = [{"pid": p["pid"], "ppid": p["ppid"], "cwd": cwd.get(p["pid"]),
                "_command": p["_command"]} for p in rows.values()]
    try:
        result = subprocess.run(["node", str(BASE.parent / "resource-state.mjs"), "--attribute"],
                                input=json.dumps(payload), capture_output=True, text=True, timeout=10)
        if result.returncode:
            raise ValueError("ownership reader failed (output omitted)")
        data = json.loads(result.stdout)
        if not data.get("complete"):
            raise ValueError("ownership registry incomplete")
        return data["owners"], []
    except (OSError, ValueError, subprocess.TimeoutExpired) as e:
        return {}, ["ownership: " + str(e)]


def task_activity(task_dir, limit=2000):
    """Only stat task artifacts, bounded and fail-closed; no file contents."""
    if not task_dir or not re.search(r"/(?:orchestrator)/[^/]+/tasks/[^/]+$", task_dir):
        return None
    latest, count, pending = 0, 0, [Path(task_dir)]
    try:
        while pending:
            folder = pending.pop()
            if folder.is_symlink():
                return None
            latest = max(latest, folder.stat().st_mtime)
            for item in folder.iterdir():
                count += 1
                if count > limit or item.is_symlink():
                    return None
                if re.fullmatch(r"(?i)(?:auth(?:\..*)?|cookies?.*|credentials?.*|\.netrc|\.env(?:\..*)?|.*keychain.*|.*\.(?:pem|p12|pfx|key))", item.name):
                    return None
                latest = max(latest, item.stat().st_mtime)
                if item.is_dir():
                    pending.append(item)
        return latest
    except OSError:
        return None


def owner_quiet(owner, now, threshold, activity):
    if owner.get("status") not in TERMINAL or not owner.get("project") or not owner.get("task"):
        return False
    changed = owner.get("changedAt")
    return (isinstance(changed, (int, float)) and now - changed / 1000 >= threshold
            and activity is not None and now - activity >= threshold
            and (owner.get("activityAt") is None or now - owner["activityAt"] / 1000 >= threshold))


def resource_history(file, now=None):
    """Read only resource telemetry, not sessions or credentials; retain last 3h."""
    now = time.time() if now is None else now
    histories = []
    file = Path(file)
    if not re.fullmatch(r"resource-log\.jsonl", file.name) or any(re.fullmatch(r"(?i)(?:\.aws|\.codex|cookies?|credentials?|keychains?|auth)", part) for part in file.parts):
        raise ValueError("only resource-log.jsonl telemetry accepted")
    for candidate in [file] + [Path(str(file) + "." + str(i)) for i in range(1, 7)]:
        if not candidate.exists():
            continue
        if candidate.is_symlink():
            raise ValueError("symlink resource telemetry refused")
        with candidate.open() as stream:
            for line in stream:
                if len(line) > 2 ** 21:
                    raise ValueError("oversized resource record")
                data = json.loads(line)
                epoch = data.get("t", 0) / 1000
                if data.get("schema") != 1 or data.get("host") != os.uname().nodename or not now - 10800 <= epoch < now:
                    continue
                histories.append({"captured_epoch": epoch,
                    "complete": data.get("processComplete") is True and data.get("attributionComplete") is True,
                    "processes": [{"identity": p["id"], "cpu_seconds": p["cpuSeconds"], "cpu_percent": p["cpuPct"]}
                                  for p in data.get("processes", [])]})
    return histories


def run(argv, timeout=15):
    try:
        p = subprocess.run(argv, capture_output=True, text=True, timeout=timeout,
                           env={**os.environ, "LC_ALL": "C"})
        return p.stdout, None if p.returncode == 0 else (p.stderr.strip() or "exit %s" % p.returncode)
    except (OSError, subprocess.TimeoutExpired) as e:
        return "", str(e)


def redact(s):
    # Process arguments may contain secrets. They are used in memory for matching,
    # but common secret flags, bearer values and URL queries never enter reports.
    s = re.sub(r"(?i)(--?(?:[\w-]*(?:token|secret|password|passwd|api-key|authorization|cookie)[\w-]*))(?:=|\s+)\S+", r"\1 [REDACTED]", s)
    s = re.sub(r"(?i)\bBearer\s+\S+", "Bearer [REDACTED]", s)
    s = re.sub(r"(https?://)[^/\s@]+@", r"\1[REDACTED]@", s)
    s = re.sub(r"(https?://[^\s?#]+)[?#]\S+", r"\1?[REDACTED]", s)
    return s[:1200]


def display_command(cmd):
    # Arguments can contain arbitrary prompts/inline credentials. Output the
    # executable and a tiny whitelist of boolean browser flags, never argument
    # bodies. Full strings exist only in memory for classification/path hashes.
    chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    exe = chrome if cmd.startswith(chrome) else cmd.split(None, 1)[0] if cmd.strip() else "unknown"
    if "=" in exe or not re.fullmatch(r"[A-Za-z0-9/._+ -]+", exe):
        exe = "unknown"
    flags = [flag for flag in ("--headless", "--restore-last-session", "--remote-debugging-pipe") if flag in cmd]
    return redact(exe + (" " + " ".join(flags) if flags else ""))


def seconds(s):
    days = 0
    if "-" in s:
        a, s = s.split("-", 1)
        days = int(a)
    parts = [float(x) for x in s.split(":")]
    return days * 86400 + sum(x * (60 ** i) for i, x in enumerate(reversed(parts)))


def processes():
    out, err = run(["/bin/ps", "-axo", "pid=,ppid=,uid=,etime=,pcpu=,rss=,state=,time=,lstart=,command="])
    rows, errors = {}, []
    if err:
        return rows, ["ps: " + err]
    for line in out.splitlines():
        try:
            a = line.split(None, 13)
            cmd = a[13]
            p = {"pid": int(a[0]), "ppid": int(a[1]), "uid": int(a[2]),
                 "elapsed_seconds": seconds(a[3]), "cpu_percent": float(a[4]),
                 "rss_kib": int(a[5]), "state": a[6], "cpu_seconds": seconds(a[7]),
                 "started": " ".join(a[8:13]), "_command": cmd}
            p["command_hash"] = hashlib.sha256(cmd.encode()).hexdigest()
            p["identity"] = "%s:%s:%s" % (p["pid"], p["started"], p["command_hash"][:16])
            rows[p["pid"]] = p
        except (ValueError, IndexError):
            errors.append("unparseable ps row (content omitted)")
    if not rows:
        errors.append("empty process listing")
    return rows, errors


def cwd_map():
    # cwd metadata only; do not enumerate open files, Chrome profiles or environments.
    out, err = run(["/usr/sbin/lsof", "-nP", "-a", "-u", str(os.getuid()), "-d", "cwd", "-Fpfn"], 30)
    result, pid = {}, None
    for line in out.splitlines():
        if line.startswith("p") and line[1:].isdigit():
            pid = int(line[1:])
        elif line.startswith("n") and pid is not None and line[1:].startswith("/"):
            result[pid] = line[1:]
    return result, (["lsof cwd: " + err] if err else [])


def managed_pids():
    # `list` contains PID/status/label only; never `print` environment/config.
    out, err = run(["/bin/launchctl", "list"])
    pids = set()
    for line in out.splitlines():
        a = line.split()
        if len(a) == 3 and a[0].isdigit() and not a[2].startswith("application.com.google.Chrome."):
            pids.add(int(a[0]))
    return pids, (["launchctl list: " + err] if err else [])


def roster():
    try:
        names = [x.strip() for x in (SHARED / "orchestrators.txt").read_text().splitlines()
                 if x.strip() and not x.lstrip().startswith("#")]
        return sorted(set(x for x in names if x != "Orchestrator 主对话")), []
    except OSError as e:
        return [], ["orchestrator roster: " + str(e)]


def session_dirs():
    out, err = run(["claude", "agents", "--json"], 20)
    if err:
        return [], [], ["live session metadata: " + err]
    try:
        agents = json.loads(out)
        if not isinstance(agents, list):
            raise ValueError("expected array")
        paths, sessions = [], []
        for a in agents:
            if not isinstance(a, dict) or not isinstance(a.get("cwd"), str):
                raise ValueError("missing session cwd")
            # Idle/blocked sessions may have outstanding commands; protect them too.
            paths.append(a["cwd"])
            sessions.append({k: a.get(k) for k in ("id", "name", "cwd", "state")})
        return paths, sessions, []
    except (ValueError, TypeError) as e:
        return [], [], ["invalid live session metadata: " + str(e)]


def leases():
    # Same state as `res status`, without res's usbmux/devicectl/ADB probes,
    # temporary files or deletion. Read only resources.tsv and locks/*/info.
    errors, held = [], []
    try:
        resources = {}
        for line in (SHARED / "resources.tsv").read_text().splitlines():
            if not line.strip() or line.startswith("#"):
                continue
            a = line.split("\t")
            if len(a) < 4:
                raise ValueError("invalid registry row")
            resources[a[0]] = a[1]
        lockdir = SHARED / "locks"
        for lock in lockdir.iterdir():
            if not lock.name.endswith(".d"):
                continue
            data = dict(line.split("\t", 1) for line in (lock / "info").read_text().splitlines() if "\t" in line)
            rid = lock.name[:-2]
            held.append({"id": rid, "kind": resources.get(rid, "unknown"),
                         "holder": data.get("by", "unknown"), "project": data.get("project", ""),
                         "task": data.get("task", ""), "until": data.get("until", ""),
                         "pid": int(data["pid"]) if re.fullmatch(r"[1-9]\d*", data.get("pid", "")) else None,
                         "host": data.get("host") or None,
                         "start_epoch": int(data["start"]) if re.fullmatch(r"[1-9]\d*", data.get("start", "")) else None})
    except (OSError, ValueError) as e:
        errors.append("lease metadata: " + str(e))
    return held, errors


def lock_holders(rows, held, now=None):
    """Every res lock protects its local holder; ambiguous identities veto cleanup."""
    now = time.time() if now is None else now
    protected, errors = set(), []
    host = os.uname().nodename
    for lock in held:
        pid, lock_host, start = lock.get("pid"), lock.get("host"), lock.get("start_epoch")
        if not isinstance(pid, int) or pid <= 0 or not isinstance(lock_host, str) or not lock_host or not isinstance(start, (int, float)) or not 0 < start <= now + 1:
            errors.append("resource-lock holder metadata ambiguous: " + str(lock.get("id", "unknown")))
            continue
        if lock_host != host:
            continue  # A verified remote host's PID is not a local PID.
        p = rows.get(pid)
        if p is None:
            continue  # Dead local holder has no tree; this never reclaims its lock.
        protected.add(pid)
        try:
            started = time.mktime(time.strptime(p["started"], "%a %b %d %H:%M:%S %Y"))
            if started > start + 1:
                raise ValueError("PID reused")
        except (KeyError, ValueError, OverflowError):
            errors.append("resource-lock holder start identity ambiguous: " + str(lock.get("id", "unknown")))
    return protected, errors


def category(cmd):
    lower = cmd.lower()
    if re.search(r"pymobiledevice3.*(?:tunnel|start-tunnel|remote tunneld)", lower):
        return "device_tunnel"
    if re.search(r"(?:coresimulator|simulator\.app|simulatord|simulatortrampoline)", lower):
        return "core_simulator" if "coresimulator" in lower else "simulator"
    if re.search(r"(?:gradledaemon|kotlin.*daemon|gradle.*daemon)", lower):
        return "gradle_kotlin_daemon"
    if re.search(r"(?:chrome|chromium|firefox|webkit|headless_shell|playwright)", lower) and re.search(r"(?:--headless|headless_shell|chrome-headless-shell|playwright|--remote-debugging-pipe)", lower):
        return "headless_browser"
    if "/applications/google chrome.app/contents/" in lower:
        return "gui_chrome"
    if re.search(r"(?:^|[/\s])(?:xcodebuild|clang(?:\+\+)?|swift-frontend|ibtool)(?:\s|$)", lower):
        return "xcode_build_tool"
    if re.search(r"(?:^|[/\s])(?:node|vitest|jest|tsx)(?:\s|$)", lower):
        return "node_test_leftover"
    if re.search(r"\.app/Contents/", cmd):
        return "gui_app"
    return "other"


def chain(pid, rows):
    result, seen = [], set()
    while pid in rows and pid not in seen:
        seen.add(pid)
        p = rows[pid]
        result.append(pid)
        pid = p["ppid"]
    return result


def within(path, root):
    try:
        return os.path.commonpath([os.path.realpath(path), os.path.realpath(root)]) == os.path.realpath(root)
    except ValueError:
        return False


def command_in(cmd, root):
    # Match full path tokens; path-boundary check avoids /task/a matching /task/abc.
    try:
        tokens = shlex.split(cmd)
    except ValueError:
        tokens = cmd.split()
    return any(within(t.split("=", 1)[-1], root) for t in tokens if t.split("=", 1)[-1].startswith("/")) or bool(re.search(re.escape(root) + r"(?:/|[\s\"']|$)", cmd))


def history_evidence(p, histories, now, cfg):
    # A process's uptime is never its idle time or its duration of high CPU.
    points = []
    for h in histories:
        if h.get("captured_epoch", 0) < now:
            q = next((q for q in h.get("processes", []) if q.get("identity") == p["identity"]), None) if h.get("complete") else None
            points.append((h["captured_epoch"], q))
    points.append((now, p))
    points.sort(key=lambda x: x[0])
    idle_start = high_start = now
    nxt_t, nxt = points[-1]
    idle_ok = p["cpu_percent"] <= cfg["idle_max_cpu_percent"] and p.get("sample_cpu_percent", 999) <= cfg["idle_max_cpu_percent"]
    high_ok = p["cpu_percent"] >= cfg["gui_high_cpu_percent"] and p.get("sample_cpu_percent", 0) >= cfg["gui_high_cpu_percent"]
    for t, q in reversed(points[:-1]):
        gap = nxt_t - t
        if q is None or gap <= 0 or gap > cfg["max_history_gap_seconds"]:
            break
        delta = (nxt["cpu_seconds"] - q.get("cpu_seconds", -1)) * 100 / gap
        idle_ok = idle_ok and 0 <= delta <= cfg["idle_max_cpu_percent"] and q.get("cpu_percent", 999) <= cfg["idle_max_cpu_percent"]
        high_ok = high_ok and delta >= cfg["gui_high_cpu_percent"] and q.get("cpu_percent", 0) >= cfg["gui_high_cpu_percent"]
        if idle_ok:
            idle_start = t
        if high_ok:
            high_start = t
        nxt_t, nxt = t, q
    return {"observed_idle_seconds": max(0, now - idle_start), "observed_high_cpu_seconds": max(0, now - high_start)}


def health():
    vm, ve = run(["/usr/bin/vm_stat"])
    mp, me = run(["/usr/bin/memory_pressure", "-Q"])
    load, le = run(["/usr/sbin/sysctl", "-n", "vm.loadavg"])
    swap, se = run(["/usr/sbin/sysctl", "-n", "vm.swapusage"])
    disk = shutil.disk_usage(HOME)  # Data volume containing user work, not the sealed OS volume.
    pagesize = re.search(r"page size of (\d+) bytes", vm)
    page = int(pagesize.group(1)) if pagesize else None
    pages = {k.strip(): int(v) for k, v in re.findall(r"^([^:\n]+):\s+(\d+)\.", vm, re.M)}
    free_pct = re.search(r"free percentage:\s*(\d+)%", mp)
    return {"load": load.strip() or None, "memory_pressure": mp.strip() or None,
            "memory_free_percent": int(free_pct.group(1)) if free_pct else None,
            "vm_page_size_bytes": page, "vm_pages": pages, "swap": swap.strip() or None,
            "disk_path": str(HOME), "disk_free_bytes": disk.free, "disk_total_bytes": disk.total,
            "errors": [x for x in [ve, me, le, se] if x]}


def collect(policy, histories=(), sample_seconds=None):
    rows0, errors0 = processes()
    sample = policy["thresholds"]["sample_seconds"] if sample_seconds is None else sample_seconds
    start = time.monotonic()
    if rows0:
        time.sleep(sample)
        rows, errors = processes()
    else:
        rows, errors = {}, []
    span = max(time.monotonic() - start, .01)
    now = time.time()
    cwd, ce = cwd_map()
    managed, mge = managed_pids()
    paths, sessions, ae = session_dirs()
    held, he = leases()
    holder_pids, holder_errors = lock_holders(rows, held, now)
    names, ne = roster()
    owned, oe = task_owners(rows, cwd)
    errors = errors0 + errors + ce + ae + he + holder_errors + ne + mge + oe
    activity_cache = {}
    agent_seeds = {pid for pid, p in rows.items() if any(re.search(r, p["_command"]) for r in policy["never_command_regex"])}
    agent_seeds.add(os.getpid())
    for pid in agent_seeds:
        if pid in cwd:
            paths.append(cwd[pid])
    paths += policy["extra_live_task_dirs"]
    roots = sorted(set(os.path.realpath(os.path.expanduser(x)) for x in paths if x))
    broad = [x for x in roots if x in ("/", str(HOME))]
    roots = [x for x in roots if x not in broad]
    descendants = {pid: [] for pid in rows}
    for q in rows.values():
        for ancestor in chain(q["pid"], rows)[1:]:
            descendants[ancestor].append(q)
    for p in rows.values():
        cmd = p["_command"]
        old = rows0.get(p["pid"])
        p["sample_cpu_percent"] = round(max(0, (p["cpu_seconds"] - old["cpu_seconds"]) * 100 / span), 2) if old and old["identity"] == p["identity"] else None
        p["cwd"] = cwd.get(p["pid"])
        p["category"] = category(cmd)
        ancestors = chain(p["pid"], rows)
        p["parent_chain"] = [{"pid": x, "ppid": rows[x]["ppid"], "command": display_command(rows[x]["_command"])} for x in ancestors]
        p["protected_reasons"] = []
        reasons = p["protected_reasons"]
        if p["uid"] != os.getuid() or p["pid"] <= 1:
            reasons.append("system_or_other_user")
        if cmd.startswith(tuple(policy["never_system_prefixes"])):
            reasons.append("system_executable")
        if re.search(policy["never_system_command_regex"], cmd):
            reasons.append("system_command")
        if any(x in managed for x in ancestors):
            reasons.append("launchd_managed_service_or_descendant")
        if any(x in agent_seeds for x in ancestors):
            reasons.append("agent_session_supervisor_or_descendant")
        if any(x in holder_pids for x in ancestors):
            reasons.append("resource_lock_holder_or_descendant")
        if not p["cwd"]:
            reasons.append("cwd_unknown")
        for root in roots:
            if (p["cwd"] and within(p["cwd"], root)) or command_in(cmd, root):
                reasons.append("live_task_directory:" + root)
                break
        if re.search(r"(?i)(?:pymobiledevice3|idevice|devicectl|(?:^|[/\s])adb(?:\s|$))", cmd) and (he or any(x["kind"] in ("device", "unknown") for x in held)):
            reasons.append("device_lease_held_or_unknown")
        if p["category"] in policy["managed_services"]:
            reasons.append("managed_service_report_only")
        if p["category"] == "gui_app":
            reasons.append("gui_unsaved_work_report_only")
        if "Z" in p["state"]:
            reasons.append("zombie_cannot_be_cleaned_by_signal")
        if p["sample_cpu_percent"] is None:
            reasons.append("process_identity_changed_during_sample")
            p["sample_cpu_percent"] = 0
        p.update(history_evidence(p, histories, now, policy["thresholds"]))
        p["owner"] = owned.get(str(p["pid"]), {})
        task_dir = p["owner"].get("taskDir")
        if task_dir not in activity_cache:
            activity_cache[task_dir] = task_activity(task_dir)
        p["owner_task_quiet"] = not p["owner"].get("inferred") and p["owner"].get("evidence") != "inferred-worktree-id" and owner_quiet(p["owner"], now, policy["thresholds"]["idle_seconds"], activity_cache[task_dir])
        p["leftover_evidence"] = []
        if p["ppid"] == 1 and p["elapsed_seconds"] >= policy["thresholds"]["orphan_min_age_seconds"]:
            # A launchd-managed daemon also has PPID 1; exclude those categories above.
            p["leftover_evidence"].append("ppid_1_and_old")
        if p["observed_idle_seconds"] >= policy["thresholds"]["idle_seconds"]:
            p["leftover_evidence"].append("continuously_observed_idle")
        p["proposed_action"] = "report_only"
        if not reasons and not errors and p["owner_task_quiet"] and p["observed_idle_seconds"] >= policy["thresholds"]["idle_seconds"] and p["category"] in policy["killable_categories"]:
            p["proposed_action"] = "terminate_after_release"
        if p["category"] == "gui_chrome" and not reasons and not errors and p["elapsed_seconds"] >= policy["thresholds"]["gui_min_age_seconds"] and p["observed_high_cpu_seconds"] >= policy["thresholds"]["chrome_high_cpu_seconds"]:
            p["proposed_action"] = "restart_chrome_after_release"
        p["command"] = display_command(cmd)
    # Protection extends to descendants even if their own cwd differs, and an
    # individually protected descendant vetoes a parent's entire action.
    # PID 1 launches almost everything on macOS. Protect it, without treating
    # the entire machine as its protected worker tree.
    protected_seeds = {p["pid"] for p in rows.values() if p["pid"] > 1 and p["protected_reasons"]}
    for p in rows.values():
        if any(x in protected_seeds for x in chain(p["pid"], rows)[1:]):
            p["protected_reasons"].append("protected_ancestor")
        children = descendants[p["pid"]]
        if any(q["protected_reasons"] for q in children):
            p["protected_reasons"].append("protected_descendant_vetoes_tree")
        if p["category"] == "gui_chrome" and any(q["category"] != "gui_chrome" for q in children):
            p["protected_reasons"].append("non_gui_chrome_descendant")
        if p["protected_reasons"]:
            p["proposed_action"] = "report_only"
    top_rss = sorted(rows.values(), key=lambda p: p["rss_kib"], reverse=True)[:20]
    top_cpu = sorted(rows.values(), key=lambda p: p["cpu_percent"], reverse=True)[:20]
    tops = {p["pid"] for p in top_rss + top_cpu}
    candidates = [p for p in rows.values() if p["category"] != "other" or p["pid"] in tops]
    for p in rows.values():
        p.pop("_command", None)
    return {"schema_version": 1, "captured_epoch": now,
            "captured_at": dt.datetime.now().astimezone().isoformat(), "complete": not errors,
            "errors": errors, "policy_hash": hashlib.sha256(json.dumps(policy, sort_keys=True).encode()).hexdigest(),
            "health": health(), "orchestrators": names, "sessions": sessions,
            "held_resources": held, "resource_lock_holder_pids": sorted(holder_pids),
            "live_task_dirs": roots, "broad_session_dirs_ignored": broad,
            "sample_seconds": span, "process_count": len(rows), "processes": list(rows.values()),
            "candidates": candidates, "top20_rss_pids": [p["pid"] for p in top_rss],
            "top20_cpu_pids": [p["pid"] for p in top_cpu]}


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--history", action="append", default=[], help="Prior inventory JSON; pass multiple continuous samples (read-only)")
    ap.add_argument("--policy", default=str(BASE / "protect.json"))
    ap.add_argument("--resource-log", default=str(SHARED / "resource-log.jsonl"), help="Shared sampler JSONL, last 3h including rotations")
    args = ap.parse_args()
    policy = read_metadata(args.policy, "policy")
    histories = [read_metadata(x, "inventory") for x in args.history] + resource_history(args.resource_log)
    snap = collect(policy, histories)
    json.dump(snap, sys.stdout, indent=2, ensure_ascii=False)
    print()
    print("Inventory %s: %s; %d processes, %d candidates, %d proposals" % (
        snap["captured_at"], "COMPLETE" if snap["complete"] else "INCOMPLETE / NO KILLS",
        snap["process_count"], len(snap["candidates"]), sum(x["proposed_action"] != "report_only" for x in snap["candidates"])), file=sys.stderr)
    h = snap["health"]
    print("Load: %s; memory free: %s%%; disk free: %.1f GiB" % (h["load"] or "unknown", h["memory_free_percent"], h["disk_free_bytes"] / 2**30), file=sys.stderr)
    for p in sorted(snap["candidates"], key=lambda x: x["rss_kib"], reverse=True)[:20]:
        print("PID %s PPID %s age %.0fs CPU %.1f%% RSS %.1f MiB %s: %s [%s]" % (p["pid"], p["ppid"], p["elapsed_seconds"], p["cpu_percent"], p["rss_kib"] / 1024, p["category"], p["proposed_action"], ", ".join(p["protected_reasons"]) or "needs explicit releases"), file=sys.stderr)
    for e in snap["errors"]:
        print("ERROR: " + e, file=sys.stderr)
    return 0 if snap["complete"] else 2


if __name__ == "__main__":
    sys.exit(main())
