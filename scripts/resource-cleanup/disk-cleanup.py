#!/usr/bin/env python3
"""Dry-default cleanup of explicitly registered self-made disposable build trees."""
import argparse
import fcntl
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import time
import inventory as inv

FORBIDDEN = re.compile(r"(?i)^(?:\.git|\.env(?:\..*)?|\.aws|\.codex|\.claude|\.netrc|cookies?.*|auth(?:\..*)?|credentials?.*|.*keychain.*|.*\.(?:pem|p12|pfx|key|mobileprovision)|gradle\.properties)$")


def signature(s):
    return (s.st_dev, s.st_ino, s.st_mode, s.st_size, s.st_mtime_ns)


def scan_tree(root, limit=100000):
    result, pending = {}, [Path(root)]
    while pending:
        item = pending.pop()
        if FORBIDDEN.fullmatch(item.name):
            raise ValueError("source/credential/config tree refused")
        s = item.lstat()
        if not stat.S_ISDIR(s.st_mode) and not stat.S_ISREG(s.st_mode):
            raise ValueError("symlink/special file refused")
        result[str(item.relative_to(root))] = signature(s)
        if len(result) > limit:
            raise ValueError("artifact too large to verify safely")
        if stat.S_ISDIR(s.st_mode):
            pending.extend(item.iterdir())
    return result


def plan(snap, claims, registry, tasks, now=None):
    now = time.time() if now is None else now
    vetoes, actions, candidates = [], [], []
    if not snap.get("complete"):
        return {"actions": [], "vetoes": ["inventory_incomplete"]}
    free = snap.get("health", {}).get("disk_free_bytes")
    if not isinstance(free, (int, float)) or free >= 10 ** 12:
        return {"actions": [], "vetoes": ["disk_unknown_or_not_below_1TB"]}
    if any(x.get("kind") in ("device", "unknown") for x in snap.get("held_resources", [])):
        return {"actions": [], "vetoes": ["held_device_resources_require_owner_review"]}
    if not 0 <= now - snap.get("captured_epoch", 0) <= 180:
        return {"actions": [], "vetoes": ["inventory_stale"]}
    if not 0 <= now - claims.get("announced_epoch", 0) <= 1500 or not claims.get("announced_epoch", 0) < claims.get("deadline_epoch", 0) <= claims.get("announced_epoch", 0) + 1200:
        return {"actions": [], "vetoes": ["coordination_stale"]}
    for entry in registry.get("artifacts", []):
        try:
            root = Path(entry["path"])
            if not root.is_absolute() or root.is_symlink() or str(root.resolve()) != str(root):
                raise ValueError("noncanonical path/symlink refused")
            if re.search(r"/orchestrator/[^/]+/tasks(?:/|$)", str(root)) or any(x in root.parts for x in (".gradle", ".npm")) or "/Library/Caches/" in str(root):
                raise ValueError("task archive/shared tool cache is never a disposable artifact")
            if entry.get("kind") not in ("build_clone", "build_template") or entry.get("created_by") != "orchestrator":
                raise ValueError("not a self-made build clone/template")
            if not any(inv.within(str(root), str(Path(r).resolve())) and str(root) != str(Path(r).resolve()) for r in registry.get("allowed_roots", [])):
                raise ValueError("outside exact approved artifact roots")
            marker = root / ".resource-build-artifact.json"
            if marker.is_symlink():
                raise ValueError("symlink marker")
            data = json.loads(marker.read_text())
            if not entry.get("nonce") or any(data.get(k) != entry.get(k) for k in ("nonce", "project", "task", "kind", "created_by")):
                raise ValueError("self-made marker mismatch")
            task = next((t for t in tasks if t["project"] == entry["project"] and t["task"] == entry["task"]), {})
            activity = inv.task_activity(task.get("taskDir"))
            if not inv.owner_quiet(task, now, 7200, activity):
                raise ValueError("terminal task/recent activity unproven")
            if any(inv.within(p.get("cwd") or "", str(root)) or inv.command_in(p.get("command", ""), str(root)) or (p.get("owner", {}).get("project"), p.get("owner", {}).get("task")) == (entry["project"], entry["task"]) for p in snap["processes"]) or any(inv.within(str(root), p) or inv.within(p, str(root)) for p in snap.get("live_task_dirs", [])):
                raise ValueError("live process/task uses artifact")
            if any(p.get("uid") == os.getuid() and p.get("category") in ("xcode_build_tool", "node_test_leftover", "headless_browser") and not p.get("cwd") for p in snap["processes"]):
                raise ValueError("build/test cwd unknown")
            manifest = scan_tree(root)
            if any(now - s[4] / 10 ** 9 < 7200 for s in manifest.values()):
                raise ValueError("recent artifact activity")
            s = root.stat()
            identity = "artifact:%s:%s:%s" % (s.st_dev, s.st_ino, entry["nonce"])
            candidates.append({"path": str(root), "identity": identity, "project": entry["project"], "task": entry["task"]})
            roster = snap.get("orchestrators", [])
            if not roster or identity not in claims.get("announced_identities", []) or any(claims.get("replies", {}).get(n, {}).get("state") != "answered" or identity not in claims["replies"][n].get("released_identities", []) or identity in claims["replies"][n].get("claimed_identities", []) for n in roster):
                raise ValueError("every orchestrator must release artifact identity")
            actions.append({"path": str(root), "identity": identity, "manifest": manifest, "entry": entry})
        except (OSError, ValueError, KeyError) as e:
            vetoes.append({"path": entry.get("path"), "reason": str(e)})
    return {"actions": actions, "candidates": candidates, "vetoes": vetoes}


def remove_artifact(action):
    """Descriptor-relative deletion; never follow symlinks or delete a replacement."""
    root = Path(action["path"])
    expected = {k: tuple(v) for k, v in action["manifest"].items()}
    if scan_tree(root) != expected:
        raise RuntimeError("artifact changed since authorization")
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    parent = os.open(str(root.parent), flags)
    fd = os.open(root.name, flags, dir_fd=parent)
    try:
        if signature(os.fstat(fd)) != expected["."]:
            raise RuntimeError("artifact identity changed")
        def walk(folder, prefix):
            names = sorted(os.listdir(folder))
            expected_names = sorted(k[len(prefix):] for k in expected if k.startswith(prefix) and k != "." and "/" not in k[len(prefix):])
            if names != expected_names:
                raise RuntimeError("artifact entries changed")
            for name in names:
                key = prefix + name
                current = os.stat(name, dir_fd=folder, follow_symlinks=False)
                if signature(current) != expected[key]:
                    raise RuntimeError("artifact member changed")
                if stat.S_ISDIR(current.st_mode):
                    child = os.open(name, flags, dir_fd=folder)
                    try:
                        if os.fstat(child).st_ino != current.st_ino:
                            raise RuntimeError("directory replaced")
                        walk(child, key + "/")
                        if os.stat(name, dir_fd=folder, follow_symlinks=False).st_ino != current.st_ino:
                            raise RuntimeError("directory replaced before removal")
                        os.rmdir(name, dir_fd=folder)
                    finally:
                        os.close(child)
                else:
                    os.unlink(name, dir_fd=folder)
        walk(fd, "")
        s = os.stat(root.name, dir_fd=parent, follow_symlinks=False)
        if (s.st_dev, s.st_ino) != expected["."][:2]:
            raise RuntimeError("root replaced; replacement preserved")
        os.rmdir(root.name, dir_fd=parent)
    finally:
        os.close(fd)
        os.close(parent)


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--inventory", required=True)
    ap.add_argument("--claims", required=True)
    ap.add_argument("--registry", default=str(inv.BASE / "build-artifacts.json"))
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--log-dir", default=str(inv.SHARED / "resource-cleanup"))
    args = ap.parse_args()
    snap = inv.read_metadata(args.inventory, "inventory")
    claims = inv.read_metadata(args.claims, "claims")
    registry = inv.read_metadata(args.registry, "registry")
    original_policy = inv.read_metadata(inv.BASE / "protect.json", "policy")
    expected_hash = inv.hashlib.sha256(json.dumps(original_policy, sort_keys=True).encode()).hexdigest()
    if snap.get("policy_hash") != expected_hash:
        raise RuntimeError("inventory policy changed")
    def task_states():
        p = subprocess.run(["node", str(inv.BASE.parent / "resource-state.mjs")], capture_output=True, text=True, timeout=10)
        data = json.loads(p.stdout)
        if p.returncode or not data.get("complete"):
            raise RuntimeError("ownership metadata incomplete")
        return data["tasks"]
    decision = plan(snap, claims, registry, task_states())
    if not args.apply:
        print(json.dumps(decision, indent=2))
        return 0
    if os.environ.get("MINI_CLEANUP_MODE") != "apply":
        print("BLOCKED: apply requires MINI_CLEANUP_MODE=apply", file=sys.stderr)
        return 2
    if not decision["actions"]:
        print(json.dumps(decision))
        return 2 if decision["vetoes"] else 0
    logdir = Path(args.log_dir)
    logdir.mkdir(parents=True, exist_ok=True)
    with (logdir / "execution.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        for previous in list(logdir.glob("actions-*.json")) + list(logdir.glob("disk-actions-*.json")):
            audit = inv.read_audit(previous)
            if inv.unfinished_recovery(audit):
                raise RuntimeError("prior process/Chrome recovery unfinished")
        for action in decision["actions"]:
            policy = json.loads((inv.BASE / "protect.json").read_text())
            if policy != original_policy:
                raise RuntimeError("policy changed before disk cleanup")
            fresh = inv.collect(policy)
            claims_now = inv.read_metadata(args.claims, "claims")
            registry_now = inv.read_metadata(args.registry, "registry")
            current = plan(fresh, claims_now, registry_now, task_states())
            match = next((a for a in current["actions"] if a["identity"] == action["identity"] and a["manifest"] == action["manifest"]), None)
            if not match:
                raise RuntimeError("disk/task/claim/protection changed")
            audit_path = logdir / ("disk-actions-%s-%s.json" % (time.time_ns(), os.getpid()))
            audit = {"status": "running", "path": action["path"], "identity": action["identity"]}
            with audit_path.open("x") as out:
                json.dump(audit, out)
            try:
                remove_artifact(action)
                audit["status"] = "completed"
            finally:
                audit_path.write_text(json.dumps(audit))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (Exception, KeyboardInterrupt) as e:
        print("BLOCKED: " + str(e), file=sys.stderr)
        sys.exit(2)
