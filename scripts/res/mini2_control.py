"""One Darwin slot, one host guard, default-off admission, no remote status I/O."""
import argparse
from contextlib import contextmanager
import datetime
import fcntl
import json
import math
import os
from pathlib import Path
import re
import shutil
import sys
import time
import uuid

HOST = "Bytedances-Mac-mini.local"
SLOT = "mini2-exec-1"
DEFAULT = dict(enabled=False, maintenance=False, load5Limit=6, minAvailableGiB=16,
               minFreeGiB=20, owner="9850afbb-edd7-492b-b885-913ccbf40020", generation=0)
ROW = SLOT + "\tremote\tnever\t-\tSecond Mac mini bytedance@" + HOST + " os=darwin arch=arm64 cores=10 ram=32GiB iface=en12\n"


def root_dir():
    return Path(os.environ.get("RES_DIR") or os.environ.get("RULES_SHARED") or Path.home()/".claude/orchestrator/_shared")


def read(file, default=None):
    try:
        info = file.stat()
        if file.is_symlink() or not file.is_file() or info.st_size > 1024*1024:
            raise ValueError("unsafe mini2 state file")
        value=json.loads(file.read_text())
        if not isinstance(value,dict): raise ValueError("invalid mini2 state shape")
        return value
    except FileNotFoundError: return default


def atomic(file, value):
    file.parent.mkdir(parents=True, exist_ok=True)
    tmp = file.with_name(file.name+"."+str(uuid.uuid4())+".tmp")
    with tmp.open("x") as stream:
        json.dump(value, stream)
        stream.flush(); os.fsync(stream.fileno())
    os.replace(tmp, file)


@contextmanager
def guard(root):
    root.mkdir(parents=True, exist_ok=True)
    with (root/"mini2.guard").open("a") as file:
        fcntl.flock(file, fcntl.LOCK_EX)
        yield


def config(root):
    value = read(root/"mini2-config.json", DEFAULT.copy())
    if not isinstance(value, dict) or set(value) != set(DEFAULT): raise ValueError("invalid mini2 config schema")
    for name in ("enabled", "maintenance"):
        if type(value[name]) is not bool: raise ValueError("invalid mini2 switch")
    for name, limit in (("load5Limit", 6), ("minAvailableGiB", 16), ("minFreeGiB", 20)):
        v = value[name]
        if type(v) not in (int, float) or not math.isfinite(v) or v <= 0:
            raise ValueError("invalid mini2 threshold")
        if name == "load5Limit" and v > limit or name != "load5Limit" and v < limit:
            raise ValueError("mini2 threshold exceeds qualified envelope")
    if not isinstance(value["owner"], str) or not re.fullmatch(r"[a-zA-Z0-9_.:-]{1,200}", value["owner"]):
        raise ValueError("invalid mini2 owner")
    if type(value["generation"]) is not int or value["generation"] < 0: raise ValueError("invalid mini2 generation")
    return value


def fresh(value, now, ttl):
    return type(value) in (int, float) and math.isfinite(value) and 0 <= now-value < ttl


def admission(root, cfg, now, disk=0, need=(), qualification=False):
    if not cfg["enabled"] and not qualification: return "disabled"
    if cfg["maintenance"]: return "maintenance"
    link = read(root/"mini2-link.json", {})
    if link.get("maintenance", True): return "link-maintenance"
    if not fresh(link.get("at"), now, 300) or link.get("link") != "UP": return "link-stale-or-down"
    sample = read(root/"mini2-metrics.json", {})
    if not fresh(sample.get("at"), now, 300) or sample.get("host") != HOST: return "metrics-stale-or-foreign"
    for key in ("load5", "availableGiB", "freeGiB", "pressure", "swapGiB", "compressorGiB"):
        if type(sample.get(key)) not in (int, float) or not math.isfinite(sample[key]) or sample[key] < 0:
            return "invalid-metrics"
    if sample["load5"] > cfg["load5Limit"]: return "load5"
    if sample["availableGiB"] < cfg["minAvailableGiB"]: return "memory"
    if sample["freeGiB"]-disk < cfg["minFreeGiB"]: return "disk"
    if sample["pressure"] != 1: return "pressure"
    facts = read(root/"mini2-facts.json", {})
    if not fresh(facts.get("at"), now, 3600) or facts.get("host") != HOST: return "facts-stale-or-foreign"
    if not set(need) <= set(facts.get("caps", [])): return "capability"
    if (root/"mini2-cleanup-pending.json").exists(): return "cleanup-pending"
    return "open"


def journal(root, event, holder, detail=""):
    with (root/"log.tsv").open("a") as file:
        file.write(datetime.datetime.now().strftime("%Y-%m-%d %H:%M")+"\t"+event+"\t"+SLOT+"\t"+holder+"\t"+detail+"\n")


def status(root, now=None):
    now = time.time() if now is None else now
    try:
        cfg = config(root)
        reason = admission(root, cfg, now)
    except (ValueError, OSError):
        cfg = DEFAULT.copy(); reason = "invalid-config-or-state"
    def safe(name):
        try: return read(root/name, {})
        except (ValueError, OSError): return {}
    link, metrics, facts = (safe("mini2-"+name+".json") for name in ("link", "metrics", "facts"))
    held = (root/"locks"/(SLOT+".d")).exists()
    takes = 0
    try:
        for line in (root/"log.tsv").read_text().splitlines():
            fields = line.split("\t")
            if len(fields) >= 3 and fields[1:3] == ["take", SLOT]:
                at = datetime.datetime.strptime(fields[0], "%Y-%m-%d %H:%M").timestamp()
                takes += now-86400 <= at <= now
    except FileNotFoundError: pass
    return dict(host=HOST, slot=SLOT, pool="mini2", enabled=cfg["enabled"],
                maintenance=cfg["maintenance"] or link.get("maintenance", True),
                link=link.get("link", "UNKNOWN") if fresh(link.get("at"), now, 300) else "UNKNOWN",
                lastSuccess=link.get("lastSuccess"), reason="held" if reason == "open" and held else reason,
                slots=1, held=int(held), takes24h=takes, metricsAge=now-metrics["at"] if "at" in metrics else None,
                factsAge=now-facts["at"] if "at" in facts else None, caps=facts.get("caps", []),
                alert=link.get("alert", "UNCONFIGURED"))


def observe(root, observation, now=None, generation=None):
    """Persist a transition and outbox in the same host transaction."""
    now = time.time() if now is None else now
    with guard(root):
        cfg = config(root)
        if generation is not None and cfg["generation"] != generation:
            return {"link":"UNKNOWN", "reason":"config-changed"}
        state = read(root/"mini2-link.json", {})
        if cfg["maintenance"]:
            state.update(at=now, link="MAINTENANCE", maintenance=True, failures=0, successes=0)
            state.pop("failureSince",None)
            atomic(root/"mini2-link.json", state)
            return state
        up = observation.get("link") == "UP"
        state["successes"] = min(2, state.get("successes", 0)+1) if up else 0
        if up:
            state["failures"]=0; state.pop("failureSince",None)
        else:
            state.setdefault("failureSince",now)
            state["failures"]=2 if now-state["failureSince"] >= 300 and state.get("failures",0) else 1
        state.update(at=now, link="UP" if up else "DOWN", reason=observation.get("reason", "healthy" if up else "ssh-failed"))
        if up: state["lastSuccess"] = now
        state.setdefault("maintenance", True)
        state.setdefault("alert", "READY")
        if state["failures"] >= 2 and not state.get("outage"):
            state["outage"] = str(uuid.uuid4()); state["maintenance"] = True
            state.setdefault("outbox", []).append(dict(id=state["outage"]+":down", tag="mini2-down", reason=state["reason"], at=now))
        if state["successes"] >= 2:
            state["maintenance"] = False
            if state.get("outage"):
                state.setdefault("outbox", []).append(dict(id=state.pop("outage")+":up", tag="mini2-up", reason="two-successes", at=now))
        if state.get("outbox"): state["alert"] = "PENDING"
        atomic(root/"mini2-link.json", state)
        return state


def acquire(root, args):
    if not args.by or not args.project or not args.task or not args.purpose or not args.pid or args.pid <= 1:
        raise ValueError("mini2 take requires --by --project --task --for --pid")
    for value in (args.by, args.project, args.task, args.purpose):
        if any(c in value for c in "\t\r\n\0"): raise ValueError("invalid hold field")
    if args.profile not in ("heavy", "light"): raise ValueError("--profile heavy|light required")
    if not math.isfinite(args.disk_gib) or args.disk_gib < 0: raise ValueError("invalid disk reservation")
    if not math.isfinite(args.timeout) or args.timeout < 0: raise ValueError("invalid timeout")
    qualification = False
    if args.qualification:
        qualification_file = Path(args.qualification)
        q = read(qualification_file, {})
        qualification = (q.get("task") == args.task == "mini2-enable" and q.get("enabled") is True
                         and q.get("by") == args.by and qualification_file.stat().st_mode & 0o077 == 0
                         and fresh(q.get("at"), time.time(), 7200))
        if not qualification: raise ValueError("qualification is absent or expired")
    queue = root/"mini2-waiters"
    queue.mkdir(parents=True, exist_ok=True)
    ticket = queue/(str(time.time_ns())+"-"+str(uuid.uuid4())+".json")
    deadline = time.monotonic()+args.timeout*60
    atomic(ticket, dict(pid=args.pid, controller=os.getpid(), at=time.time()))
    try:
        while True:
            os.kill(args.pid, 0)
            with guard(root):
                if qualification:
                    q=read(Path(args.qualification),{})
                    if q.get("task") != args.task or q.get("by") != args.by or q.get("enabled") is not True or not fresh(q.get("at"),time.time(),7200):
                        raise ValueError("qualification was removed or expired")
                cfg = config(root)
                registry = (root/"resources.tsv").read_text().splitlines()
                rows = [line.split("\t") for line in registry if line.startswith(SLOT+"\t")]
                if len(rows) != 1 or rows[0][1] != "remote" or rows[0][3] != "-": raise ValueError("mini2 row missing or invalid")
                required = args.need.split(",") if args.need else []
                approved = re.search(r"\bcaps=([a-zA-Z0-9_,.-]+)", rows[0][4])
                if not qualification and rows[0][2] != "open": reason="policy"
                elif not qualification and not set(required) <= set(approved[1].split(",") if approved else []): reason="registry-capability"
                else: reason=admission(root, cfg, time.time(), args.disk_gib, required, qualification)
                # Dead queue callers never retain FIFO position; no held slot is reclaimed here.
                for file in queue.glob("*.json"):
                    value = read(file)
                    try: os.kill(value["controller"], 0); os.kill(value["pid"], 0)
                    except ProcessLookupError: file.unlink()
                hold = root/"locks"/(SLOT+".d")
                if reason == "open" and not hold.exists() and ticket == min(queue.glob("*.json")):
                    hold.mkdir(parents=True)
                    values=dict(by=args.by, project=args.project, task=args.task, pid=args.pid,
                                host=os.uname().nodename, start=int(time.time()), profile=args.profile,
                                generation=str(uuid.uuid4()), remote_host=HOST, remote_cleanup_required="1", purpose=args.purpose)
                    atomic(hold/"lease.json", values)
                    (hold/"info").write_text("".join(str(k)+"\t"+str(v)+"\n" for k,v in values.items()))
                    journal(root, "take", args.by, "qualification" if qualification else args.profile)
                    print(json.dumps(dict(slot=SLOT, lease=values)))
                    return
                if time.monotonic() >= deadline: raise ValueError("mini2 admission closed: "+reason)
            time.sleep(1)
    finally:
        ticket.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("status", "stage", "configure", "take", "wait", "wait-pool", "return", "retain-remote", "holder"))
    parser.add_argument("resource", nargs="?")
    for arg in ("by", "project", "task", "profile", "need", "qualification", "receipt", "note"):
        parser.add_argument("--"+arg, default="")
    parser.add_argument("--for", dest="purpose", default="")
    parser.add_argument("--pid", type=int)
    parser.add_argument("--disk-gib", type=float, default=8)
    parser.add_argument("--timeout", type=float, default=0)
    parser.add_argument("--enable", action="store_true")
    parser.add_argument("--disable", action="store_true")
    parser.add_argument("--maintenance", choices=("on", "off"))
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    root = root_dir()
    if args.action == "status":
        value = status(root)
        print(json.dumps(value) if args.json else "mini2 "+" ".join(k+"="+str(v) for k,v in value.items()))
    elif args.action in ("stage", "configure"):
        with guard(root):
            cfg=config(root)
            if args.action == "stage":
                file=root/"resources.tsv"
                lines=file.read_text() if file.exists() else ""
                if not any(line.startswith(SLOT+"\t") for line in lines.splitlines()):
                    with file.open("a") as stream: stream.write(ROW)
            else:
                if args.enable and args.disable: raise ValueError("conflicting flags")
                if args.enable:
                    evidence = read(Path(args.receipt), {}) if args.receipt else {}
                    if evidence.get("clean") is not True or evidence.get("receipt", {}).get("exit") != 0 or not evidence.get("artifacts"):
                        raise ValueError("successful measured build receipt required")
                    cfg["enabled"]=True
                if args.disable: cfg["enabled"]=False
                if args.maintenance: cfg["maintenance"]=args.maintenance == "on"
                cfg["generation"]+=1
                if args.enable or args.disable:
                    file = root/"resources.tsv"
                    lines=file.read_text().splitlines(keepends=True)
                    matches=[i for i,line in enumerate(lines) if line.startswith(SLOT+"\t")]
                    if len(matches) != 1: raise ValueError("mini2 row missing or duplicate")
                    i=matches[0]; fields=lines[i].rstrip("\n").split("\t")
                    if fields[1] != "remote" or fields[3] != "-": raise ValueError("invalid mini2 row")
                    fields[2]="open" if args.enable else "never"
                    fields[4]=re.sub(r"\s+caps=[a-zA-Z0-9_,.-]+", "", fields[4])
                    if args.enable: fields[4]+=" caps=cmake-native"
                    lines[i]="\t".join(fields)+"\n"
                    staged=file.with_name(".mini2-registry-"+str(uuid.uuid4()))
                    staged.write_text("".join(lines)); os.replace(staged,file)
            atomic(root/"mini2-config.json", cfg)
            print(json.dumps(cfg))
    elif args.action in ("take", "wait", "wait-pool"):
        if args.resource not in (SLOT, "mini2"): raise ValueError("unknown mini2 resource")
        acquire(root,args)
    elif args.action == "holder":
        print(json.dumps(read(root/"locks"/(SLOT+".d")/"lease.json", {})))
    else:
        with guard(root):
            hold=root/"locks"/(SLOT+".d")
            lease=read(hold/"lease.json", {})
            if not lease: raise ValueError("mini2 hold missing")
            if lease.get("by") != args.by: raise ValueError("mini2 hold belongs to another wrapper")
            if args.action == "retain-remote":
                atomic(root/"mini2-cleanup-pending.json", dict(lease=lease, reason=args.note, at=time.time()))
            else:
                receipt=read(Path(args.receipt), {}) if args.receipt else {}
                if receipt.get("generation") != lease["generation"] or receipt.get("clean") is not True:
                    raise ValueError("receipt-matched cleanup required")
                (root/"mini2-cleanup-pending.json").unlink(missing_ok=True)
                shutil.rmtree(hold)
                journal(root,"return",args.by)
            print(args.action+" "+SLOT)


if __name__ == "__main__":
    try: main()
    except (ValueError, OSError) as error:
        print("mini2: "+str(error), file=sys.stderr); sys.exit(2)
