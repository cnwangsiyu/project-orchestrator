"""Darwin host leases, one host transaction, no remote status I/O."""
import argparse
from contextlib import contextmanager
import datetime
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import plistlib
import re
import shutil
import shlex
import sys
sys.dont_write_bytecode = True
import subprocess
import time
import uuid
from dynamic_capacity import headroom, reservation_totals, smaller_bypass, json_safe, numeric_metric, iso_timestamp
from xml.parsers.expat import ExpatError

HOST = "Bytedances-Mac-mini.local"
SLOT = "mini2-exec-1"
LEASE_ID = re.compile(r"mini2-exec-[1-9][0-9]*\Z")
MAX_BYPASS = 3
DEVICE_CAP = "xcode-ios-device-compile-unsigned"
DEFAULT = dict(enabled=False, maintenance=False, load5Limit="derived", minAvailableGiB="derived",
               minFreeGiB=20, owner="9850afbb-edd7-492b-b885-913ccbf40020", generation=0)
ROW = SLOT + "\tremote\tnever\t-\tSecond Mac mini bytedance@" + HOST + " os=darwin arch=arm64 cores=10 ram=32GiB iface=usb-ncm\n"


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
def guard(root,name="mini2.guard"):
    root.mkdir(parents=True, exist_ok=True)
    with (root/name).open("a") as file:
        fcntl.flock(file, fcntl.LOCK_EX)
        yield


def allocator_invocation(args):
    """Peel known launchers; None means the command cannot be classified."""
    while args:
        launcher=Path(args[0]).name
        index=1
        if launcher=="env":
            while index<len(args):
                option=args[index]
                if option=="--": index+=1; break
                if option in ("-i","--ignore-environment","-"): index+=1
                elif option in ("-u","--unset","-C","--chdir"):
                    if index+1>=len(args): return None
                    index+=2
                elif option in ("-S","--split-string"):
                    if index+1>=len(args): return None
                    try: args=args[:index]+shlex.split(args[index+1])+args[index+2:]
                    except ValueError: return None
                elif option.startswith(("--unset=","--chdir=")) or re.match(r"^-[uC].+",option): index+=1
                elif re.match(r"^[A-Za-z_][A-Za-z0-9_]*=",option): index+=1
                elif option.startswith("-"): return None
                else: break
        elif launcher in ("bash","sh","zsh") or re.fullmatch(r"python[0-9.]*",launcher):
            shell=launcher in ("bash","sh","zsh")
            while index<len(args):
                option=args[index]
                if option=="--": index+=1; break
                if not option.startswith(("-","+")): break
                if shell:
                    if option in ("-o","+o","--rcfile","--init-file"):
                        if index+1>=len(args): return None
                        index+=2
                    elif option in ("--noprofile","--norc","--posix","--restricted","--verbose"): index+=1
                    elif re.fullmatch(r"[-+][abefhiklmnprtuvxBCEHPT]+",option):
                        index+=1
                    else: return None
                elif option in ("-B","-u","-I","-s","-S","-E","-O","-OO","-q"): index+=1
                elif option in ("-W","-X"):
                    if index+1>=len(args): return None
                    index+=2
                elif option.startswith(("-W","-X")) and len(option)>2: index+=1
                else: return None
        else:
            return args if launcher in ("res","mini2_control.py","local_control.py") else None
        args=args[index:]
    return None


def agent_runtime(executable,argv):
    """Only ps comm identifies an agent; a prose argv mention never does."""
    name=Path(executable).name
    if name in ("codex","claude"): return True
    if name!="node" or not argv or Path(argv[0]).name!="node": return False
    index=1
    while index<len(argv):
        option=argv[index]
        if option=="--": index+=1; break
        if option in ("--eval","--print") or option.startswith(("-e","-p","--eval=","--print=")): return False
        if option in ("-r","--require","--import","--loader","--experimental-loader"):
            index+=2
        elif option.startswith("-"): index+=1
        else: break
    return index<len(argv) and Path(argv[index]).name in ("codex-worker.mjs","route.mjs")


def process_ancestry():
    table=subprocess.check_output(["/bin/ps","-ax","-o","pid=,ppid="],text=True,timeout=3)
    parents={}
    for line in table.splitlines():
        fields=line.split()
        if len(fields)==2 and all(field.isdigit() for field in fields):
            parents[int(fields[0])]=int(fields[1])
    # The launching shell can contain the migration brief/heredoc in its argv.
    # Exempt only this chain, never descendants or unrelated wrapper processes.
    ancestors={os.getpid()}
    pid=os.getppid()
    while pid>0 and pid not in ancestors:
        ancestors.add(pid)
        pid=parents.get(pid,0)
    return ancestors


def allocator_processes(kind):
    ancestors=process_ancestry()
    table=subprocess.check_output(["/bin/ps","-axww","-o","pid=,comm=,args="],text=True,timeout=3)
    result=[]
    for line in table.splitlines():
        fields=line.strip().split(None,2)
        if len(fields)!=3 or fields[0].isdigit() and int(fields[0]) in ancestors: continue
        command=fields[2]
        try: argv=shlex.split(command)
        except ValueError: argv=[]
        if agent_runtime(fields[1],argv): continue
        if "RES_BUILD_PROCESS_SOURCE" in command:
            result.append("pid="+fields[0]+" legacy inline allocator"); continue
        args=allocator_invocation(argv)
        if args is None:
            # ps does not preserve argv quoting. Opaque wrappers, inline shell
            # commands and malformed input must not hide an allocator waiter;
            # separators and extra arguments need not keep its action adjacent.
            scripts=r"(?:res|mini2_control\.py|local_control\.py)"
            shaped=(any(Path(part).name in ("res","mini2_control.py","local_control.py") for part in argv)
                    or re.search(r"(?:^|[\s\"';|])[^\s\"';|]+/"+scripts+r"(?=$|[\s\"';|])",command)
                    or re.search(r"(?:^|[;&|]|\s-[A-Za-z]*c[A-Za-z]*\s+[\"']?)\s*"+scripts+r"(?=$|[\s\"';|])",command)
                    or re.search(r"(?:^|[\s\"';|])"+scripts+r"(?=$|[\s\"';|])",command))
            if shaped:
                result.append("pid="+fields[0]+" unclassified allocator")
            continue
        part=args[0]
        tail=args[1:]
        if tail and tail[0]=="mini2": tail=tail[1:]
        action=tail[0] if tail else ""; resource=tail[1] if len(tail)>1 else ""
        known={"take","wait","take-build","wait-build","wait-lane","wait-pool","status","holder","bind",
               "stage","configure","return","return-build","extend","slot-host","pool-capacity","devbox-registry",
               "reserved-disk","box-health","audit","release-dead","retain-remote","quarantine","unquarantine",
               "report-infra","check-config","heavy-check","add","note","log"}
        if action not in known or action in ("take","wait","wait-pool") and not resource:
            result.append("pid="+fields[0]+" unclassified allocator"); continue
        local=action in ("take-build","wait-build","wait-lane") or action in ("take","wait") and resource.startswith("heavy-") or action=="wait-pool" and resource in ("local","local-light","local-build")
        mini=action in ("take","wait") and resource.startswith("mini2-exec-") or action=="wait-pool" and resource=="mini2" or part.endswith("mini2_control.py") and action in ("take","wait","wait-pool")
        if (local if kind=="local" else mini):
            result.append("pid="+fields[0]+" "+kind+" allocator")
    return result


def refuse_legacy_allocators(root,kind):
    blockers=allocator_processes(kind)
    paths=([*root.glob("build-waiters/*/info"),*root.glob("lane-waiters/*/info")]
           if kind=="local" else [*root.glob("mini2-waiters/*.json"),*root.glob("pool-waiters/mini2/*/info")])
    for file in paths:
        value=read(file,{}) if file.suffix==".json" else dict(line.split("\t",1) for line in file.read_text().splitlines() if "\t" in line)
        pid=value.get("controller",value.get("pid"))
        if value.get("host",os.uname().nodename)!=os.uname().nodename or not str(pid).isdigit() or int(pid)<=1 or process_start(int(pid)) is not None:
            blockers.append(file.parent.name+" pid="+(str(pid) if str(pid).isdigit() else "unknown"))
    if kind=="local":
        file=root/".build-admission.lock"
        if file.exists():
            pid=file.read_text().strip()
            if not pid.isdigit() or int(pid)<=1 or process_start(int(pid)) is not None: blockers.append(".build-admission.lock pid="+(pid if pid.isdigit() else "unknown"))
    if blockers: raise ValueError("legacy allocators waiting or mid-transaction: "+", ".join(sorted(set(blockers)))+"; stop and restart these allocator commands using the installed controller before retrying migration")


@contextmanager
def allocator_switch(root,kind):
    # Admission holds a shared lock from allocator selection through its entire
    # transaction/wait. Migration never waits behind it or races that selection.
    with (root/("."+kind+"-allocator-switch.guard")).open("a") as file:
        try: fcntl.flock(file,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError:
            blockers=allocator_processes(kind)
            if tool:=shutil.which("lsof"):
                try:
                    listing=subprocess.run([tool,"-w","-t",str(root/("."+kind+"-allocator-switch.guard"))],capture_output=True,text=True,timeout=3)
                    blockers.extend("pid="+pid+" "+kind+" allocator switch holder" for pid in listing.stdout.splitlines() if pid.isdigit() and pid!=str(os.getpid()))
                except (OSError,subprocess.TimeoutExpired): pass
            raise ValueError("allocator selection/transaction active: "+", ".join(blockers or [kind+" allocator"])+"; stop and restart these allocator commands using the installed controller before retrying migration")
        yield


def config(root):
    value = read(root/"mini2-config.json", DEFAULT.copy())
    if not isinstance(value, dict) or set(value) != set(DEFAULT): raise ValueError("invalid mini2 config schema")
    for name in ("enabled", "maintenance"):
        if type(value[name]) is not bool: raise ValueError("invalid mini2 switch")
    for name, limit in (("load5Limit", 6), ("minAvailableGiB", 16), ("minFreeGiB", 20)):
        v = value[name]
        if v == "derived" and name != "minFreeGiB": continue
        if type(v) not in (int, float) or not math.isfinite(v) or v <= 0:
            raise ValueError("invalid mini2 threshold")

    if not isinstance(value["owner"], str) or not re.fullmatch(r"[a-zA-Z0-9_.:-]{1,200}", value["owner"]):
        raise ValueError("invalid mini2 owner")
    if type(value["generation"]) is not int or value["generation"] < 0: raise ValueError("invalid mini2 generation")
    return value


def fresh(value, now, ttl):
    return numeric_metric(value) is not None and 0 <= now-value < ttl


def registry_row(root):
    rows = [line.split("\t") for line in (root/"resources.tsv").read_text().splitlines()
            if line.startswith(SLOT+"\t")]
    if len(rows) != 1 or len(rows[0]) != 5 or rows[0][1] != "remote" or rows[0][3] != "-":
        raise ValueError("mini2 row missing or invalid")
    if "bytedance@"+HOST not in rows[0][4]: raise ValueError("mini2 registry host mismatch")
    return rows[0]


def dynamic_row(row):
    return "dynamic-host" in row[4].split()


def lease_holds(root):
    return sorted(p for p in (root/"locks").glob("mini2-exec-*.d") if LEASE_ID.fullmatch(p.name[:-2]))


def weights(args):
    native = not args.need or set(args.need.split(",")) <= {"cmake-native"}
    profile = args.profile or ("light" if native else "heavy")
    if profile not in ("heavy", "light"): raise ValueError("--profile heavy|light required")
    defaults = (1, 1, 8) if profile == "light" and native else (4, 8, 16)
    result = tuple(default if value is None else value for default, value in zip(defaults,
                   (getattr(args,"cores",None), getattr(args,"mem_gib",None),args.disk_gib)))
    if any(type(v) not in (int,float) or not math.isfinite(v) or v < 0 for v in result):
        raise ValueError("invalid claim weight")
    if result[0] < 0.25 or result[1] < 0.25: raise ValueError("claim weight below minimum")
    return result


def reserved(root):
    holds=lease_holds(root)+list((root/"mini2-pending").glob("*/hold"))
    return reservation_totals([read(hold/"lease.json",{}) for hold in holds])


def process_start(pid):
    result=subprocess.run(["/bin/ps","-p",str(pid),"-o","stat=","-o","lstart="],capture_output=True,text=True,timeout=5)
    if result.returncode==1 and not result.stdout: return None
    if result.returncode!=0 or not result.stdout.strip(): raise ValueError("local process identity unavailable")
    state,*born=result.stdout.strip().split()
    return None if state.startswith("Z") else " ".join(born)


def local_alive(lease):
    if lease.get("host") != os.uname().nodename: return True
    pid = lease.get("pid")
    if type(pid) is not int or pid <= 1: return True
    try:
        current=process_start(pid)
    except (ValueError,OSError,subprocess.TimeoutExpired): return True
    return current is not None and (not lease.get("pid_start") or lease["pid_start"] == current)


def reap_dead(root):
    for hold in lease_holds(root):
        lease = read(hold/"lease.json", {})
        if local_alive(lease): continue
        # Old runner holds have no dispatch marker: never assume those safe.
        if lease.get("dispatch") == "unbound":
            shutil.rmtree(hold)
            journal(root,"reclaim-dead",lease.get("by","?"),slot=hold.name[:-2])
        else:
            pending = root/"mini2-pending"/hold.name[:-2]
            pending.mkdir(parents=True,exist_ok=True)
            atomic(pending/"pending.json",dict(lease=lease,reason="dead-holder-remote-unconfirmed",at=time.time()))
            # Retain identity for receipt-matched reconciliation and prevent ID
            # reuse; remove its active reservation by moving it out of locks.
            os.replace(hold,pending/"hold")


def pending_cleanup(root):
    return (root/"mini2-cleanup-pending.json").exists()


def stored_lease(root,resource):
    return read(root/"locks"/(resource+".d")/"lease.json",None) or read(root/"mini2-pending"/resource/"hold"/"lease.json",{})


def resolve(root, resource):
    if not resource or not LEASE_ID.fullmatch(resource): raise ValueError("unknown mini2 lease id")
    row = registry_row(root)
    known = resource == SLOT or dynamic_row(row) or (root/"locks"/(resource+".d")).exists() or (root/"mini2-pending"/resource).exists()
    if not known: raise ValueError("unknown mini2 lease id")
    approved = re.search(r"\bcaps=([a-zA-Z0-9_,.-]+)",row[4])
    return dict(slot=resource,host=HOST,user="bytedance",target="bytedance@"+HOST,
                kind="remote",cores=numeric_metric(read(root/"mini2-metrics.json",{}).get("cores"),True),memGiB=numeric_metric(read(root/"mini2-metrics.json",{}).get("totalGiB"),True),factsAt=iso_timestamp(read(root/"mini2-facts.json",{}).get("at")),
                resolverOnly=not dynamic_row(row) and resource != SLOT,root="/Users/bytedance/mac-build-runner",caps=approved[1].split(",") if approved else [],
                policy=row[2],dynamic=dynamic_row(row),category="LIGHT" if stored_lease(root,resource).get("profile")=="light" else "HEAVY")


def registry_slots(root):
    ids={SLOT}
    ids.update(hold.name[:-2] for hold in lease_holds(root))
    ids.update(p.name for p in (root/"mini2-pending").glob("*"))
    if dynamic_row(registry_row(root)):
        number=1
        while "mini2-exec-"+str(number) in ids: number+=1
        ids.add("mini2-exec-"+str(number))
    return [resolve(root,id) for id in sorted(ids)]


def admission(root, cfg, now, disk=0, need=(), qualification=False, cost=None):
    if not cfg["enabled"] and not qualification: return "disabled"
    if cfg["maintenance"]: return "maintenance"
    link = read(root/"mini2-link.json", {})
    if link.get("maintenance", True): return "link-maintenance"
    if not fresh(link.get("at"), now, 300) or link.get("link") != "UP": return "link-stale-or-down"
    sample = read(root/"mini2-metrics.json", {})
    if not fresh(sample.get("at"), now, 300) or sample.get("host") != HOST: return "metrics-stale-or-foreign"
    if any(numeric_metric(sample.get(name)) is None for name in ("load5","availableGiB","freeGiB","pressure","swapGiB","compressorGiB")):
        return "invalid-metrics"
    for key in ("load5", "availableGiB", "freeGiB", "pressure", "swapGiB", "compressorGiB"):
        if type(sample.get(key)) not in (int, float) or not math.isfinite(sample[key]) or sample[key] < 0:
            return "invalid-metrics"
    limits = thresholds(cfg,sample)
    if limits is None: return "hardware-mismatch"
    if sample["load5"] > limits[0]: return "load5"
    if sample["availableGiB"] < limits[1]: return "memory"
    if sample["freeGiB"]-disk < cfg["minFreeGiB"]: return "disk"
    if sample["pressure"] != 1: return "pressure"
    facts = read(root/"mini2-facts.json", {})
    if not fresh(facts.get("at"), now, 3600) or facts.get("host") != HOST: return "facts-stale-or-foreign"
    if not set(need) <= set(facts.get("caps", [])): return "capability"
    if pending_cleanup(root): return "cleanup-pending"
    if cost is None and (any(hold.name != SLOT+".d" for hold in lease_holds(root)) or any((root/"mini2-pending").glob("*/pending.json"))): return "dynamic-leases-draining"
    if cost is not None:
        if sample.get("arch") != "arm64":
            return "hardware-mismatch"
        try: reservations = reserved(root)
        except ValueError: return "legacy-or-incomplete-hold"
        return headroom(sample["load5"],sample["availableGiB"],sample["freeGiB"],
                        reservations,cost,limits[0],limits[1],cfg["minFreeGiB"])
    return "open"


def journal(root, event, holder, detail="", slot=SLOT):
    with (root/"log.tsv").open("a") as file:
        file.write(datetime.datetime.now().strftime("%Y-%m-%d %H:%M")+"\t"+event+"\t"+slot+"\t"+holder+"\t"+detail+"\n")


def status(root, now=None):
    now = time.time() if now is None else now
    try:
        cfg = config(root)
        row = registry_row(root)
        dynamic = dynamic_row(row)
        reason = admission(root, cfg, now, cost=(1,1,8) if dynamic else None)
        if row[2] != "open": reason = "policy"
    except (ValueError, OSError):
        cfg = DEFAULT.copy(); reason = "invalid-config-or-state"; dynamic = False
    def safe(name):
        try: return read(root/name, {})
        except (ValueError, OSError): return {}
    link, metrics, facts = (safe("mini2-"+name+".json") for name in ("link", "metrics", "facts"))
    held = len(lease_holds(root))
    takes = 0
    try:
        for line in (root/"log.tsv").read_text().splitlines():
            fields = line.split("\t")
            if len(fields) >= 3 and fields[1] == "take" and LEASE_ID.fullmatch(fields[2]):
                at = datetime.datetime.strptime(fields[0], "%Y-%m-%d %H:%M").timestamp()
                takes += now-86400 <= at <= now
    except FileNotFoundError: pass
    return dict(host=HOST, slot=SLOT, pool="mini2", enabled=cfg["enabled"],
                maintenance=cfg["maintenance"] or link.get("maintenance", True),
                link=link.get("link", "UNKNOWN") if fresh(link.get("at"), now, 300) else "UNKNOWN",
                lastSuccess=link.get("lastSuccess") if iso_timestamp(link.get("lastSuccess")) is not None else None, reason="held" if reason == "open" and held and not dynamic else reason,
                slots=None if dynamic else 1, dynamic=dynamic, held=held,pending=len(list((root/"mini2-pending").glob("*/pending.json"))),
                capacity=capacity(root,cfg,metrics,dynamic), takes24h=takes, metricsAge=age(metrics,now),
                factsAge=age(facts,now), caps=facts.get("caps", []),
                alert=link.get("alert", "UNCONFIGURED"))


def thresholds(cfg,sample):
    cpu,ram=sample.get("cores"),sample.get("totalGiB")
    if numeric_metric(cpu,True) is None or numeric_metric(ram,True) is None or numeric_metric(cpu+ram,True) is None: return None
    return (cpu if cfg["load5Limit"]=="derived" else cfg["load5Limit"],
            max(4,0.12*ram) if cfg["minAvailableGiB"]=="derived" else cfg["minAvailableGiB"])


def age(value,now):
    at=value.get("at")
    return now-at if iso_timestamp(at) is not None and now>=at else None


def capacity(root,cfg,sample,dynamic):
    try: amounts = reserved(root) if dynamic else (0,0,0)
    except ValueError: amounts = None
    return dict(cores=numeric_metric(sample.get("cores"),True),loadLimit=(thresholds(cfg,sample) or (None,None))[0],memoryFloorGiB=(thresholds(cfg,sample) or (None,None))[1],
                diskFloorGiB=cfg["minFreeGiB"],load5=numeric_metric(sample.get("load5")),availableGiB=numeric_metric(sample.get("availableGiB")),
                freeGiB=numeric_metric(sample.get("freeGiB")),reserved=amounts,swapGiB=numeric_metric(sample.get("swapGiB")),
                compressorGiB=numeric_metric(sample.get("compressorGiB")),defaultLight=[1,1,8],defaultHeavy=[4,8,16],maxBypass=MAX_BYPASS)


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
    cost = weights(args)
    pid_start = process_start(args.pid)
    if pid_start is None: raise ValueError("holder is dead")
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
    atomic(ticket, dict(pid=args.pid, controller=os.getpid(), host=os.uname().nodename, at=time.time(),
                        cost=cost, need=args.need, bypasses=0))
    try:
        while True:
            os.kill(args.pid, 0)
            with guard(root):
                if qualification:
                    q=read(Path(args.qualification),{})
                    if q.get("task") != args.task or q.get("by") != args.by or q.get("enabled") is not True or not fresh(q.get("at"),time.time(),7200):
                        raise ValueError("qualification was removed or expired")
                cfg = config(root)
                row = registry_row(root)
                dynamic = dynamic_row(row)
                reap_dead(root)
                required = args.need.split(",") if args.need else []
                approved = re.search(r"\bcaps=([a-zA-Z0-9_,.-]+)", row[4])
                if not qualification and row[2] != "open": reason="policy"
                elif not qualification and not set(required) <= set(approved[1].split(",") if approved else []): reason="registry-capability"
                else: reason=admission(root, cfg, time.time(), cost[2], required, qualification, cost=cost if dynamic else None)
                for file in queue.glob("*.json"):
                    value = read(file)
                    if value is None: continue
                    try: os.kill(value["controller"], 0); os.kill(value["pid"], 0)
                    except ProcessLookupError: file.unlink()
                earlier = sorted(file for file in queue.glob("*.json") if file < ticket)
                bypass = []
                for file in earlier:
                    older = read(file)
                    if older is None: continue
                    if not dynamic:
                        reason = "fifo"; break
                    old_cost = older["cost"]
                    old_reason = admission(root,cfg,time.time(),old_cost[2],older["need"].split(",") if older["need"] else [],qualification,cost=old_cost)
                    if not smaller_bypass(cost,old_cost,old_reason,older["bypasses"],MAX_BYPASS):
                        reason = "fifo"; break
                    bypass.append((file,older))
                resource = getattr(args,"resource",None) or SLOT
                if resource != "mini2" and not LEASE_ID.fullmatch(resource): raise ValueError("unknown mini2 resource")
                if resource not in (SLOT,"mini2") and not dynamic: raise ValueError("dynamic admission disabled")
                if resource == "mini2" and dynamic:
                    ordinal=1
                    while (root/"locks"/("mini2-exec-"+str(ordinal)+".d")).exists() or (root/"mini2-pending"/("mini2-exec-"+str(ordinal))).exists(): ordinal+=1
                    resource="mini2-exec-"+str(ordinal)
                elif resource == "mini2": resource=SLOT
                hold = root/"locks"/(resource+".d")
                if (hold.exists() or (root/"mini2-pending"/resource).exists()) and reason == "open": reason = "held-or-pending"
                if reason == "open":
                    hold.mkdir(parents=True)
                    try:
                        sample=read(root/"mini2-metrics.json",{})
                        values=dict(by=args.by, project=args.project, task=args.task, pid=args.pid,pid_start=pid_start,
                                    host=os.uname().nodename, start=int(time.time()), profile=args.profile or ("light" if not args.need or set(args.need.split(",")) <= {"cmake-native"} else "heavy"),
                                    slot=resource,dynamic=dynamic,weights=cost,dispatch="unbound" if getattr(args,"resource",None)=="mini2" else "legacy",
                                    limits=dict(loadLimit=thresholds(cfg,sample)[0],memoryFloorGiB=thresholds(cfg,sample)[1],diskFloorGiB=cfg["minFreeGiB"]),
                                    generation=str(uuid.uuid4()), remote_host=HOST, remote_cleanup_required="1", purpose=args.purpose)
                        atomic(hold/"lease.json", values)
                        (hold/"info").write_text("".join(str(k)+"\t"+str(v)+"\n" for k,v in values.items()))
                        for file,older in bypass:
                            atomic(file,{**older,"bypasses":older["bypasses"]+1})
                        journal(root, "take", args.by, "qualification" if qualification else values["profile"],slot=resource)
                        ticket.unlink(missing_ok=True)
                    except BaseException:
                        shutil.rmtree(hold)
                        raise
                    print(json.dumps(dict(slot=resource, lease=values)))
                    return
                if time.monotonic() >= deadline:
                    ticket.unlink(missing_ok=True)
                    raise ValueError("mini2 admission closed: "+reason)
            time.sleep(1)
    finally:
        ticket.unlink(missing_ok=True)


def measured_build(file):
    evidence = read(file, {})
    if evidence.get("clean") is not True or evidence.get("receipt", {}).get("exit") != 0 or not evidence.get("artifacts"):
        raise ValueError("successful measured build receipt required")
    return evidence


def verify_ios_build(summary, platform, *, unsigned=False):
    evidence = measured_build(summary)
    if evidence.get("host") != HOST:
        raise ValueError("mini2 receipt required")
    root = (summary.parent / "artifacts").resolve()
    for item in evidence["artifacts"]:
        relative = Path(item["path"])
        if relative.name != "Info.plist" or relative.parent.suffix != ".app":
            continue
        if relative.is_absolute() or ".." in relative.parts:
            continue
        artifact = root / relative
        file = artifact.resolve()
        if root not in file.parents or not file.is_file():
            continue
        if unsigned:
            if item.get("unsignedApp") is not True or file != artifact:
                continue
            if any(entry.name.casefold() in {"_codesignature", "embedded.mobileprovision"}
                   for entry in file.parent.rglob("*")):
                continue
        data = file.read_bytes()
        if hashlib.sha256(data).hexdigest() != item["sha256"]:
            continue
        try:
            plist = plistlib.loads(data)
        except (plistlib.InvalidFileException, ExpatError):
            continue
        platforms = plist.get("CFBundleSupportedPlatforms") if isinstance(plist, dict) else None
        if isinstance(platforms, list) and platform in platforms:
            return
    raise ValueError(f"verified {'unsigned ' if unsigned else ''}{platform} app artifact required")


def verify_simulator_build(summary):
    verify_ios_build(summary, "iPhoneSimulator")


def verify_device_build(summary):
    verify_ios_build(summary, "iPhoneOS", unsigned=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("status", "stage", "configure", "take", "wait", "wait-pool", "return", "retain-remote", "release-dead", "holder", "bind", "slot-host", "pool-capacity", "devbox-registry"))
    parser.add_argument("resource", nargs="?")
    for arg in ("by", "project", "task", "profile", "need", "qualification", "receipt", "note", "run-id", "generation"):
        parser.add_argument("--"+arg, default="")
    parser.add_argument("--for", dest="purpose", default="")
    parser.add_argument("--pid", type=int)
    parser.add_argument("--disk-gib", type=float)
    parser.add_argument("--cores", type=float)
    parser.add_argument("--mem-gib", type=float)
    parser.add_argument("--timeout", type=float, default=0)
    parser.add_argument("--ios-receipt", type=Path)
    parser.add_argument("--ios-device-receipt", type=Path)
    parser.add_argument("--enable", action="store_true")
    parser.add_argument("--disable", action="store_true")
    parser.add_argument("--maintenance", choices=("on", "off"))
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    root = root_dir()
    if args.action == "devbox-registry":
        print(json.dumps(json_safe(registry_slots(root)),allow_nan=False))
    elif args.action == "slot-host":
        print(json.dumps(json_safe(resolve(root,args.resource)),allow_nan=False))
    elif args.action in ("status","pool-capacity"):
        value = status(root)
        if args.action == "pool-capacity":
            detail=value["capacity"]; remaining=detail["reserved"]
            count=0
            if value["reason"]=="open" and remaining is not None:
                count=max(0,min(math.floor(detail["loadLimit"]-detail["load5"]-remaining[0]),
                                math.floor(detail["availableGiB"]-detail["memoryFloorGiB"]-remaining[1]),
                                math.floor((detail["freeGiB"]-detail["diskFloorGiB"]-remaining[2])/8)))
            value={HOST:dict(claims=count,gate="headroom" if value["reason"]=="open" else value["reason"],**value)}
        print(json.dumps(json_safe(value),allow_nan=False) if args.json or args.action=="pool-capacity" else "mini2 "+" ".join(k+"="+str(v) for k,v in value.items()))
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
                    if not args.receipt: raise ValueError("successful measured build receipt required")
                    measured_build(Path(args.receipt))
                    if args.ios_receipt:
                        verify_simulator_build(args.ios_receipt)
                    if args.ios_device_receipt:
                        if lease_holds(root) or pending_cleanup(root) or any((root/"mini2-pending").glob("*/pending.json")):
                            raise ValueError("mini2 slot held")
                        verify_device_build(args.ios_device_receipt)
                    cfg["enabled"]=True
                if args.disable: cfg["enabled"]=False
                if args.maintenance: cfg["maintenance"]=args.maintenance == "on"
                cfg["generation"]+=1
                if args.enable or args.disable:
                    file = root/"resources.tsv"
                    with file.open(newline="") as stream:
                        lines=stream.readlines()
                    matches=[i for i,line in enumerate(lines) if line.startswith(SLOT+"\t")]
                    if len(matches) != 1: raise ValueError("mini2 row missing or duplicate")
                    i=matches[0]; row=lines[i].rstrip("\r\n"); fields=row.split("\t")
                    if fields[1] != "remote" or fields[3] != "-": raise ValueError("invalid mini2 row")
                    fields[2]="open" if args.enable else "never"
                    fields[4]=re.sub(r"\s+caps=[a-zA-Z0-9_,.-]+", "", fields[4])
                    if args.enable:
                        fields[4]+=" caps=cmake-native"
                        if args.ios_receipt: fields[4]+=",xcode-ios-sim-compile"
                        if args.ios_device_receipt: fields[4]+=","+DEVICE_CAP
                    lines[i]="\t".join(fields)+lines[i][len(row):]
                    staged=file.with_name(".mini2-registry-"+str(uuid.uuid4()))
                    with staged.open("x", newline="") as stream:
                        stream.writelines(lines)
                    shutil.copymode(file, staged)
                    os.replace(staged,file)
            atomic(root/"mini2-config.json", cfg)
            print(json.dumps(cfg))
    elif args.action in ("take", "wait", "wait-pool"):
        if args.resource != "mini2" and not LEASE_ID.fullmatch(args.resource or ""): raise ValueError("unknown mini2 resource")
        acquire(root,args)
    elif args.action == "holder":
        resolve(root,args.resource)
        print(json.dumps(stored_lease(root,args.resource)))
    else:
        with guard(root):
            resolve(root,args.resource)
            hold=root/"locks"/(args.resource+".d")
            pending=root/"mini2-pending"/args.resource
            if not hold.exists() and (pending/"hold").exists(): hold=pending/"hold"
            lease=read(hold/"lease.json", {})
            if not lease: raise ValueError("mini2 hold missing")
            if lease.get("by") != args.by: raise ValueError("mini2 hold belongs to another wrapper")
            if args.action == "release-dead":
                if lease.get("host") != os.uname().nodename or not args.pid or args.pid <= 1 or args.pid != lease.get("pid"):
                    raise ValueError("exact local holder PID required")
                try:
                    os.kill(args.pid, 0)
                except ProcessLookupError:
                    pass
                else:
                    raise ValueError("holder still alive")
            if args.action == "bind":
                if lease.get("generation") != args.generation or not local_alive(lease): raise ValueError("lease generation or holder mismatch")
                if str(uuid.UUID(args.run_id)) != args.run_id or lease.get("dispatch") not in ("unbound","legacy"): raise ValueError("invalid or repeated dispatch")
                lease.update(dispatch="bound",runId=args.run_id)
                atomic(hold/"lease.json",lease)
            elif args.action == "retain-remote":
                atomic(pending/"pending.json", dict(lease=lease, reason=args.note, at=time.time()))
            else:
                receipt=read(Path(args.receipt), {}) if args.receipt else {}
                if receipt.get("generation") != lease["generation"] or receipt.get("clean") is not True:
                    raise ValueError("receipt-matched cleanup required")
                if lease.get("runId") and receipt.get("runId") != lease["runId"]:
                    raise ValueError("cleanup run identity mismatch")
                if args.resource == SLOT: (root/"mini2-cleanup-pending.json").unlink(missing_ok=True)
                (pending/"pending.json").unlink(missing_ok=True)
                shutil.rmtree(hold)
                if pending.exists(): pending.rmdir()
                journal(root,args.action,args.by, "pid="+str(args.pid) if args.action=="release-dead" else "",slot=args.resource)
            print(args.action+" "+args.resource)


if __name__ == "__main__":
    try: main()
    except (ValueError, OSError) as error:
        print("mini2: "+str(error), file=sys.stderr); sys.exit(2)
