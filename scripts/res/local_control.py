"""Measured local compute leases. Migration is independent of mini2."""
import argparse
import datetime
import getpass
import json
import math
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
sys.dont_write_bytecode = True
import time
import uuid

from host_records import decision, evidence, completion
from host_samples import shared, basis
from dynamic_capacity import headroom, reservation_totals, smaller_bypass, json_safe, numeric_metric, iso_timestamp
from mini2_control import atomic, guard, read, root_dir, process_start

ID = re.compile(r"(?:heavy-build(?:-[2-9][0-9]*|-[1-9][0-9]+)?|heavy-lane-[1-9][0-9]*)\Z")
DEFAULTS=dict(LOCAL_LOAD_LIMIT="derived",LOCAL_MIN_AVAILABLE_GIB="derived",LOCAL_HEAVY_CORES="derived",
              LOCAL_HEAVY_GIB="derived",LOCAL_MEDIUM_CORES="derived",LOCAL_MEDIUM_GIB="derived",LOCAL_LIGHT_CORES=1,LOCAL_LIGHT_GIB=2,
              LOCAL_MIN_FREE_GIB=20,LOCAL_MAX_BYPASS=3,
              LOCAL_METRICS_TTL_SECONDS=5)


def helpers():
    namespace={"__name__":"res_local_helpers"}
    exec(os.environ["RES_MACHINE_SOURCE"],namespace)
    return namespace


def configuration(root):
    helper=helpers()
    file=root/"machine.conf"
    parsed=helper["parse_config"](helper["regular_config"](file)) if file.exists() else helper["parse_config"]("# defaults\n")
    return {**DEFAULTS,**parsed.get("local",{})},parsed


def registry(root):
    rows=[line.rstrip("\r\n").split("\t") for line in (root/"resources.tsv").read_text().splitlines() if line.startswith("heavy-build\t")]
    if len(rows)!=1 or len(rows[0])!=5 or rows[0][1]!="slot" or rows[0][3]!="-": raise ValueError("invalid local host row")
    return rows[0]


def holds(root):
    return sorted(p for p in (root/"locks").glob("heavy*.d") if ID.fullmatch(p.name[:-2]))


def info(hold):
    try: return dict(line.rstrip("\n").split("\t",1) for line in (hold/"info").read_text().splitlines() if "\t" in line)
    except FileNotFoundError: return {}


def claims(root):
    result=[]
    for hold in holds(root):
        value=read(hold/"lease.json",{})
        if value.get("ownerId") and value["ownerId"]!=hold.name[:-2]: continue
        result.append((hold,value))
    return result


def activated(root):
    return "dynamic-local" in registry(root)[4].split()


def fixture_file(root,name):
    value=os.environ.get(name)
    if not value: return None
    file=Path(value).resolve()
    live=(Path.home()/".claude/orchestrator/_shared").resolve()
    if root.resolve()==live or root.resolve() not in file.parents: raise ValueError("fixture requires scratch state")
    return file


def measured(root,parsed):
    fixture=fixture_file(root,"RES_TEST_LOCAL_SAMPLE")
    cached = shared(root, os.uname().nodename, time.time(), darwin=True)
    if cached:
        # Reuse the local guard (including swapfile count and sustained pressure)
        # with the same page totals as the original vm_stat/sysctl observation.
        memory = helpers()["memory_probe"](str(root), parsed, sampled=cached, prefer_native=True)
        if memory["memory"] == "HIGH": raise ValueError("memory-guard-high")
        return cached
    if fixture: return read(fixture,{})
    helper=helpers()
    at=time.time()
    hardware=subprocess.check_output(["/usr/sbin/sysctl","-n","hw.physicalcpu","hw.memsize","kern.memorystatus_vm_pressure_level"],text=True,timeout=3).splitlines()
    cores,total,pressure=(int(value) for value in hardware)
    pages,swap=helper["native_memory_readings"]()
    memory=helper["memory_probe"](str(root),parsed,readings=(pages,swap),prefer_native=True)
    if memory["memory"]=="HIGH": raise ValueError("memory-guard-high")
    size=int(re.search(r"page size of (\d+) bytes",pages)[1])
    counts={k:int(v) for k,v in re.findall(r"^([^:\n]+):\s*(\d+)\.",pages,re.M)}
    available=size*(counts["Pages free"]+counts["Pages inactive"])/2**30
    level=subprocess.run(["/usr/sbin/sysctl","-n","kern.memorystatus_level"],capture_output=True,text=True,timeout=3)
    if level.returncode==0:
        percent=float(level.stdout)
        if not math.isfinite(percent) or not 0<=percent<=100: raise ValueError("invalid available memory")
        available=total/2**30*percent/100
    elif "unknown oid" not in level.stderr.lower(): raise ValueError("available memory unavailable")
    disk=os.statvfs(root)
    sample=dict(at=at,host=os.uname().nodename,cores=cores,totalGiB=total/2**30,load5=os.getloadavg()[1],
                availableGiB=available,pressure=pressure,compressedLogicalGiB=counts["Pages stored in compressor"]*size/2**30,freeGiB=disk.f_bavail*disk.f_frsize/2**30,compressorGiB=counts["Pages occupied by compressor"]*size/2**30,swapGiB=float(re.search(r"used = ([\d.]+)K",swap)[1])/1024**2)
    return sample


def limits(cfg,sample):
    value=lambda name,default: default if cfg[name]=="derived" else cfg[name]
    return (value("LOCAL_LOAD_LIMIT",sample["cores"]),value("LOCAL_MIN_AVAILABLE_GIB",max(4,0.12*sample["totalGiB"])))


def cost_for(args,cfg,sample):
    profile=args.profile or ("light" if args.resource=="local-light" else "medium" if args.action=="wait-lane" else "heavy")
    if profile not in ("heavy","medium","light"): raise ValueError("invalid profile")
    cpu=cfg["LOCAL_"+profile.upper()+"_CORES"]
    mem=cfg["LOCAL_"+profile.upper()+"_GIB"]
    if cpu=="derived": cpu=max(1,math.ceil(sample["cores"]/(4 if profile=="heavy" else 8)))
    if mem=="derived": mem=max(2,math.ceil(sample["totalGiB"]/(8 if profile=="heavy" else 16)))
    disk={"heavy":16,"medium":8,"light":2}[profile] if args.disk_gib is None else args.disk_gib
    cost=[cpu if args.cores is None else args.cores,mem if args.mem_gib is None else args.mem_gib,disk]
    if any(type(v) not in (int,float) or not math.isfinite(v) or v<0 for v in cost) or any(v<0.25 for v in cost[:2]): raise ValueError("invalid claim weight")
    return profile,cost


def gate(root,cfg,sample,cost, details=None):
    at=sample.get("at"); now=time.time()
    if numeric_metric(at) is None or not 0<=now-at<sample.get("sampleTTL",cfg["LOCAL_METRICS_TTL_SECONDS"]): return "stale-or-missing-metrics"
    if sample.get("host")!=os.uname().nodename: return "foreign-metrics"
    for name in ("cores","totalGiB","load5","availableGiB","pressure","freeGiB","swapGiB","compressorGiB"):
        value=sample.get(name)
        if numeric_metric(value) is None: return "invalid-metrics"
    if sample["cores"]<=0 or sample["totalGiB"]<=0: return "invalid-metrics"
    if sample["pressure"]!=1: return "pressure"
    if registry(root)[2]!="open": return "policy"
    if not activated(root): return "dynamic-leases-draining"
    try: amounts=reservation_totals([v for _,v in claims(root)])
    except ValueError: return "legacy-or-incomplete-hold"
    load,floor=limits(cfg,sample)
    charged, available, window = basis(root,sample["host"],sample,amounts,now)
    if details is not None:
        details.update(evidence(sample,amounts,[load,floor,cfg["LOCAL_MIN_FREE_GIB"]],window,charged,available))
    return headroom(charged,available,sample["freeGiB"],(0,0,amounts[2]),cost,load,floor,cfg["LOCAL_MIN_FREE_GIB"])


def log(root,event,id,by,detail=""):
    with (root/"log.tsv").open("a") as file:
        file.write(datetime.datetime.now().strftime("%Y-%m-%d %H:%M")+"\t"+event+"\t"+id+"\t"+by+"\t"+detail+"\n")


def remove_claim(root,hold,lease):
    lane=lease.get("lane")
    if lane:
        other=root/"locks"/(lane+".d")
        sibling=read(other/"lease.json",{})
        if sibling.get("generation")!=lease["generation"]: raise ValueError("lane ownership changed")
        shutil.rmtree(other)
    shutil.rmtree(hold)
    completion(root,os.uname().nodename,hold.name[:-2],lease,True)
    log(root,"return",hold.name[:-2],lease["by"])


def reap(root):
    namespace={"__name__":"res_local_build_probe"}
    exec(os.environ["RES_BUILD_PROCESS_SOURCE"],namespace)
    for hold,lease in claims(root):
        if not lease or lease.get("host")!=os.uname().nodename: continue
        if process_start(lease["pid"])==lease.get("pid_start"): continue
        safe=lease.get("controlled") and lease.get("dispatch")=="unbound"
        if not safe:
            count,_=namespace["probe"](info(hold))
            safe=count==0 and bool(json.loads(info(hold).get("checkout_paths","[]")))
        if safe: remove_claim(root,hold,lease)
        elif not lease.get("pending"):
            atomic(hold/"lease.json",{**lease,"pending":True})


def checkout_identity(args):
    if args.checkout:
        file=Path(args.checkout).resolve()
        if not file.is_dir(): raise ValueError("checkout missing")
        return str(file)
    current=Path.cwd().resolve()
    for parent in (current,*current.parents):
        if (parent/".git").exists(): return str(parent)
    return "project:"+args.project


def free_id(root,kind,pin=None):
    if pin:
        return pin if not (root/"locks"/(pin+".d")).exists() else None
    number=1
    while True:
        id=("heavy-build" if number==1 else "heavy-build-"+str(number)) if kind=="build" else "heavy-lane-"+str(number)
        if not (root/"locks"/(id+".d")).exists(): return id
        number+=1


def acquire(root,args):
    if not args.by or not args.project or not args.purpose or not args.pid or args.pid<=1: raise ValueError("claim requires --by --project --for --pid")
    for text in (args.by,args.project,args.task,args.purpose):
        if any(c in text for c in "\t\r\n\0"): raise ValueError("invalid claim field")
    born=process_start(args.pid)
    if born is None: raise ValueError("holder is dead")
    if not math.isfinite(args.timeout) or args.timeout<0: raise ValueError("invalid timeout")
    build=args.action in ("take-build","wait-build") or args.resource.startswith("heavy-build")
    checkout=checkout_identity(args)
    queue=root/"local-waiters"; queue.mkdir(parents=True,exist_ok=True)
    ticket=None
    deadline=time.monotonic()+args.timeout*60
    try:
        while True:
            if process_start(args.pid)!=born: raise ValueError("holder exited or changed")
            with guard(root,"local-capacity.guard"):
                # Register in transaction order. An immediate claim must not see
                # an unpriced ticket belonging to a caller still entering the guard.
                if ticket is None:
                    ticket=queue/(str(time.time_ns())+"-"+str(uuid.uuid4())+".json")
                    atomic(ticket,dict(pid=args.pid,controller=os.getpid(),cost=None,bypasses=0))
                cfg,parsed=configuration(root)
                try:
                    sample=measured(root,parsed)
                except (ValueError,OSError,subprocess.SubprocessError) as error:
                    reason="memory-guard-high" if str(error)=="memory-guard-high" else "invalid-metrics"
                    decision(root,os.uname().nodename,args.project,args.task,args.profile or "unknown",None,
                             reason,False,evidence(shared(root,os.uname().nodename,time.time(),darwin=True)))
                    raise
                # Validate hardware before deriving costs; stale evidence always
                # closes admission even when a fixture is otherwise well formed.
                if any(numeric_metric(sample.get(name),True) is None for name in ("cores","totalGiB")):
                    decision(root,os.uname().nodename,args.project,args.task,args.profile or "unknown",None,
                             "invalid-metrics",False,evidence(sample))
                    raise ValueError("invalid hardware metrics")
                profile,cost=cost_for(args,cfg,sample)
                reap(root)
                details=evidence(sample)
                reason=gate(root,cfg,sample,cost,details)
                own_ticket=read(ticket,{})
                atomic(ticket,{**own_ticket,"cost":cost})
                for file in queue.glob("*.json"):
                    waiter=read(file)
                    if waiter is None: continue
                    try: os.kill(waiter["controller"],0); os.kill(waiter["pid"],0)
                    except ProcessLookupError: file.unlink()
                bypass=[]
                for file in sorted(p for p in queue.glob("*.json") if p<ticket):
                    older=read(file)
                    if older is None: continue
                    if older["cost"] is None or not smaller_bypass(cost,older["cost"],gate(root,cfg,sample,older["cost"]),older["bypasses"],cfg["LOCAL_MAX_BYPASS"]): reason="fifo"; break
                    bypass.append((file,older))
                own=[(hold,lease) for hold,lease in claims(root) if lease.get("by")==args.by and lease.get("pid")==args.pid]
                if own:
                    hold,lease=own[0]
                    requested=args.lane or (args.resource if args.resource.startswith("heavy-lane-") else None)
                    assigned=lease.get("lane") or hold.name[:-2]
                    if not build and (not requested or requested==assigned): print("lane="+assigned); return
                    raise ValueError("wrapper already holds a compute lease")
                if build and any(lease.get("checkout")==checkout or not lease.get("checkout") for _,lease in claims(root) if lease.get("build")):
                    reason="checkout-held"
                pin=args.resource if ID.fullmatch(args.resource) else None
                build_id=free_id(root,"build",pin if build else None) if build else None
                lane_pin=args.lane or (pin if not build else ("heavy-lane-"+("1" if pin=="heavy-build" else pin.removeprefix("heavy-build-")) if pin else None))
                lane_id=free_id(root,"lane",lane_pin)
                if lane_id is None or build and build_id is None: reason="held"
                decision(root,os.uname().nodename,args.project,args.task,profile,cost,reason,reason=="open",details)
                if reason=="open":
                    owner=build_id or lane_id
                    created=[]
                    try:
                        generation=str(uuid.uuid4())
                        lease=dict(by=args.by,project=args.project,task=args.task,purpose=args.purpose,pid=args.pid,pid_start=born,
                                   host=os.uname().nodename,start=time.time(),generation=generation,runId=generation,ownerId=owner,
                                   weights=cost,profile=profile,
                                   build=build,checkout=checkout,lane=lane_id if build else None,controlled=args.wrapper,dispatch="unbound" if args.wrapper else "manual")
                        for id in ([build_id,lane_id] if build else [lane_id]):
                            hold=root/"locks"/(id+".d"); hold.mkdir(parents=True); created.append(hold)
                            atomic(hold/"lease.json",lease)
                            values={**lease,"checkouts":json.dumps([checkout]) if checkout else "[]","checkout_paths":json.dumps([checkout]) if checkout and not checkout.startswith("project:") else "[]"}
                            if os.environ.get("RES_TEST_LOCAL_FAIL_AFTER_HOLD")=="1" and fixture_file(root,"RES_TEST_LOCAL_SAMPLE"): raise ValueError("injected publication failure")
                            (hold/"info").write_text("".join(str(k)+"\t"+str(v)+"\n" for k,v in values.items()))
                        for file,older in bypass: atomic(file,{**older,"bypasses":older["bypasses"]+1})
                        atomic(root/"local-metrics.json",sample)
                        log(root,"take",owner,args.by,"profile="+profile)
                        ticket.unlink(missing_ok=True)
                    except BaseException:
                        for hold in reversed(created): shutil.rmtree(hold)
                        raise
                    if build: print("build-id="+owner+"\nbuild-lane="+lane_id)
                    elif args.action=="wait-pool": print("slot="+lane_id)
                    else: print("lane="+lane_id)
                    return
                if time.monotonic()>=deadline:
                    ticket.unlink(missing_ok=True)
                    raise ValueError("local admission closed: "+reason)
            time.sleep(1)
    finally:
        if ticket is not None: ticket.unlink(missing_ok=True)


def resolve(root,id):
    if not ID.fullmatch(id): raise ValueError("unknown local lease")
    known=id in {line.split("\t")[0] for line in (root/"resources.tsv").read_text().splitlines()} or activated(root) or (root/"locks"/(id+".d")).exists()
    if not known: raise ValueError("unknown local lease")
    sample=read(root/"local-metrics.json",{})
    lease=read(root/"locks"/(id+".d")/"lease.json",{})
    user=getpass.getuser(); host=os.uname().nodename
    return dict(slot=id,kind="slot",policy=registry(root)[2],host=host,user=user,target=user+"@"+host,
                root=lease.get("checkout"),cores=numeric_metric(sample.get("cores"),True),memGiB=numeric_metric(sample.get("totalGiB"),True),
                factsAt=iso_timestamp(sample.get("at")),
                caps=["local-build"],dynamic=activated(root),resolverOnly=not activated(root) and id not in ("heavy-build","heavy-lane-1","heavy-lane-2","heavy-lane-3"),
                category=lease.get("profile","heavy").upper())


def registry_slots(root):
    ids={p.name[:-2] for p in holds(root)}|{free_id(root,"build"),free_id(root,"lane")}
    return [resolve(root,id) for id in sorted(ids)]


def report(root,args):
    cfg,parsed=configuration(root)
    sample=measured(root,parsed)
    if any(numeric_metric(sample.get(name),True) is None for name in ("cores","totalGiB")): raise ValueError("invalid hardware metrics")
    _,cost=cost_for(args,cfg,sample)
    reason=gate(root,cfg,sample,cost)
    try: amounts=reservation_totals([lease for _,lease in claims(root)])
    except ValueError: amounts=None
    load,floor=limits(cfg,sample)
    if reason=="open": charged,available,_=basis(root,sample["host"],sample,amounts,time.time())
    count=0 if reason!="open" or amounts is None else max(0,min(math.floor((load-charged)/cost[0]),math.floor((available-floor)/cost[1]),(math.floor((sample["freeGiB"]-cfg["LOCAL_MIN_FREE_GIB"]-amounts[2])/cost[2]) if cost[2] else math.inf)))
    return {os.uname().nodename:dict(claims=count,gate="headroom" if reason=="open" else reason,
                                   cores=numeric_metric(sample["cores"],True),memGiB=numeric_metric(sample["totalGiB"],True),loadLimit=load,memoryFloorGiB=floor,
                                   load5=numeric_metric(sample.get("load5")),availableGiB=numeric_metric(sample.get("availableGiB")),pressure=numeric_metric(sample.get("pressure")),freeGiB=numeric_metric(sample.get("freeGiB")),diskFloorGiB=cfg["LOCAL_MIN_FREE_GIB"],
                                   reserved=amounts,held=len(claims(root)),dynamic=activated(root))}


def main():
    for sig in (signal.SIGTERM,signal.SIGHUP,signal.SIGINT): signal.signal(sig,lambda *_: (_ for _ in ()).throw(SystemExit(143)))
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action")
    parser.add_argument("resource",nargs="?",default="")
    for name in ("by","project","task","profile","checkout","lane","note","need","until"):
        parser.add_argument("--"+name,default="")
    parser.add_argument("--for",dest="purpose",default="")
    parser.add_argument("--pid",type=int)
    parser.add_argument("--workload-pid",type=int)
    parser.add_argument("--timeout",type=float,default=0)
    parser.add_argument("--cores",type=float)
    parser.add_argument("--mem-gib",type=float)
    parser.add_argument("--disk-gib",type=float)
    parser.add_argument("--wrapper",action="store_true")
    parser.add_argument("--force",action="store_true")
    parser.add_argument("--json",action="store_true")
    args=parser.parse_args(); root=root_dir()
    if args.action=="enabled":
        text=(root/"resources.tsv").read_text() if (root/"resources.tsv").exists() else ""
        enabled=any(line.startswith("heavy-build\t") and "dynamic-local" in line.split() for line in text.splitlines()) or any(lease.get("ownerId") for _,lease in claims(root))
        sys.exit(0 if enabled else 1)
    elif args.action=="has-owned":
        sys.exit(0 if any(lease.get("by")==args.by and (args.pid is None or lease.get("pid")==args.pid) for _,lease in claims(root)) else 1)
    elif args.action=="slot-host": print(json.dumps(json_safe(resolve(root,args.resource)),allow_nan=False))
    elif args.action=="devbox-registry": print(json.dumps(json_safe(registry_slots(root)),allow_nan=False))
    elif args.action in ("status","pool-capacity","heavy-check"):
        try: value=report(root,args)
        except (ValueError,OSError,subprocess.SubprocessError): value={os.uname().nodename:dict(claims=0,gate="invalid-config-or-metrics")}
        if args.action=="heavy-check":
            detail=value[os.uname().nodename]
            opened=detail["gate"]=="headroom" and detail["claims"]>0
            print("dynamic_gate="+("OPEN" if opened else "CLOSED")+" dynamic_reason="+detail["gate"]+
                  " dynamic_claims="+str(detail["claims"])+" dynamic_reserved="+json.dumps(json_safe(detail.get("reserved")),separators=(",",":"))+
                  " dynamic_memory_floor_gib="+str(detail.get("memoryFloorGiB")))
            sys.exit(0 if opened else 5)
        print(json.dumps(json_safe(value),allow_nan=False))
    elif args.action in ("take-build","wait-build","wait-lane","wait-pool","take","wait"):
        if args.lane and not re.fullmatch(r"heavy-lane-[1-9][0-9]*",args.lane): raise ValueError("invalid pinned lane")
        acquire(root,args)
    elif args.action in ("return-build","return","bind","holder"):
        with guard(root,"local-capacity.guard"):
            if args.action=="return-build":
                owned=[(hold,lease) for hold,lease in claims(root) if lease.get("by")==args.by and (args.pid is None or lease.get("pid")==args.pid)]
                if args.pid is None and len(owned)>1: raise ValueError("multiple wrappers share this holder; supply --pid")
                for hold,lease in owned: remove_claim(root,hold,lease)
            else:
                if not ID.fullmatch(args.resource): raise ValueError("unknown local lease")
                hold=root/"locks"/(args.resource+".d"); lease=read(hold/"lease.json",{})
                if not lease: raise ValueError("local hold missing")
                if args.action=="holder": print(json.dumps(lease)); return
                if lease.get("by")!=args.by: raise ValueError("local hold owned by another wrapper")
                owner=root/"locks"/(lease["ownerId"]+".d")
                if args.action=="bind":
                    if not lease.get("controlled") or lease.get("dispatch")!="unbound" or process_start(lease["pid"])!=lease["pid_start"]: raise ValueError("dispatch identity mismatch")
                    # --workload-pid remains accepted for existing wrappers;
                    # binding controls reclamation, never reservation discounts.
                    atomic(owner/"lease.json",{**lease,"dispatch":"bound"})
                elif hold==owner: remove_claim(root,hold,lease)
                else:
                    canonical=read(owner/"lease.json",{})
                    if canonical.get("generation")!=lease["generation"]: raise ValueError("local generation mismatch")
                    atomic(owner/"lease.json",{**canonical,"lane":None}); shutil.rmtree(hold)
    else: raise ValueError("unsupported local action")


if __name__=="__main__":
    try: main()
    except (ValueError,OSError,subprocess.SubprocessError) as error:
        print("res local: "+str(error),file=sys.stderr); sys.exit(2)
