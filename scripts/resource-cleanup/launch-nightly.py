#!/usr/bin/env python3
"""Launch one Claude coordination session per local date; dry handled by shell."""
import datetime as dt
import fcntl
import json
import os
from pathlib import Path
import re
import subprocess
import sys

BASE = Path(__file__).resolve().parent


def agents():
    p = subprocess.run(["claude", "agents", "--json"], capture_output=True, text=True, timeout=30)
    if p.returncode:
        raise RuntimeError("BLOCKED: live session listing unavailable; sign in if requested")
    a = json.loads(p.stdout)
    if not isinstance(a, list):
        raise RuntimeError("BLOCKED: unexpected session list")
    return a


def main():
    if os.environ.get("MINI_CLEANUP_MODE") != "apply":
        print("BLOCKED: launcher needs MINI_CLEANUP_MODE=apply", file=sys.stderr)
        return 2
    health = Path.home() / ".claude/orchestrator/_shared/resource-cleanup"
    health.mkdir(parents=True, exist_ok=True)
    day = dt.datetime.now().astimezone().date().isoformat()
    name = "mini-nightly-cleanup-" + day
    # Persistent flock file; no lock directories, stale lock deletion or unlink.
    with (health / "launch.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print("another launcher is active; skipping")
            return 0
        with (health / "launch.log").open("a") as log:
            def note(s):
                log.write(dt.datetime.now().astimezone().isoformat() + " " + s + "\n")
                log.flush()
            active = agents()
            marker = health / ("launched-" + day + ".json")
            if marker.exists() or any(a.get("name") == name for a in active):
                note("already launched today; skipping")
                return 0
            pattern = re.compile(r"^mini-nightly-cleanup-(\d{4}-\d{2}-\d{2})$")
            for a in active:
                m = pattern.fullmatch(a.get("name", ""))
                if m and m.group(1) < day:
                    raise RuntimeError("BLOCKED: prior cleanup session still present; its orchestrator must review/end it, never auto-stop a worker")
            # A leftover executor may still be restoring Chrome. Its own lock
            # prevents overlap; the new session must check action audit first.
            prompt = (BASE / "session-prompt.md").read_text().replace("{{DATE}}", day).replace("{{TASK_DIR}}", str(BASE)).replace("{{HEALTH_DIR}}", str(health))
            rendered = health / ("session-prompt-" + day + ".md")
            if rendered.exists():
                if rendered.read_text() != prompt:
                    raise RuntimeError("BLOCKED: existing rendered prompt differs; preserve it for review")
            else:
                with rendered.open("x") as out:
                    out.write(prompt)
            command = ["claude", "--bg", "--remote-control", "--permission-mode", "bypassPermissions", "-n", name,
                       "--model", "sonnet", "--effort", "medium", prompt]
            note("starting " + name)
            p = subprocess.run(command, cwd=health, stdin=subprocess.DEVNULL,
                               stdout=log, stderr=log, timeout=60)
            if p.returncode:
                raise RuntimeError("BLOCKED: Claude launch failed; no cleanup authorized")
            with marker.open("x") as out:
                json.dump({"date": day, "name": name, "prompt": str(rendered)}, out, indent=2)
            note("launch accepted")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (Exception, KeyboardInterrupt) as e:
        print(str(e), file=sys.stderr)
        sys.exit(2)
