"""Best-effort local decision records and read-only capacity report."""
import argparse
from collections import Counter, defaultdict
import datetime
import fcntl
import json
import math
import os
from pathlib import Path
import re
import stat
import time
import uuid

from dynamic_capacity import numeric_metric
from host_samples import history


def label(value):
    if not isinstance(value,str) or not re.fullmatch(r"[A-Za-z0-9_.-]{1,96}",value):
        return "[masked]"
    if re.search(r"password|secret|token|credential|api.?key|^(sk-|gh[pousr]_|xox[baprs]-)|[A-Za-z0-9_-]{48}",value,re.I):
        return "[masked]"
    return value


def utc_day(at):
    return datetime.datetime.fromtimestamp(at,datetime.timezone.utc).date()


def append(root, name, record):
    # One short append. Contention during rotation and filesystem failures drop
    # telemetry, never change scheduling. Never write through a pipe or symlink.
    try:
        directory = Path(root)/"host-samples"
        directory.mkdir(exist_ok=True)
        at = time.time()
        line = (json.dumps(dict(record,schema=1,at=at),separators=(",",":"),allow_nan=False)+"\n").encode()
        current = directory/(name+".ndjson")
        flags = os.O_APPEND | os.O_CREAT | os.O_WRONLY | os.O_NONBLOCK | os.O_NOFOLLOW
        today = utc_day(at)
        daily = directory/(name+"."+str(today)+".ndjson")
        with os.fdopen(os.open(daily,flags,0o600),"ab",buffering=0) as stream:
            if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
                return
            stream.write(line)
        # The dated file is canonical. Writers never wait for rollover; the
        # alias and retention are repaired by the next writer on contention.
        if current.exists() and not current.is_symlink() and current.samefile(daily):
            return
        with os.fdopen(os.open(directory/(name+".lock"),flags,0o600),"ab") as lock:
            fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
            if today != utc_day(time.time()):
                return
            temp=directory/(name+"."+uuid.uuid4().hex+".tmp")
            os.link(daily,temp)
            try:
                os.replace(temp,current)
            finally:
                temp.unlink(missing_ok=True)
            cutoff = str(today-datetime.timedelta(days=13))
            for file in directory.glob(name+".????-??-??.ndjson"):
                if file.name.split(".")[1]<cutoff:
                    file.unlink()
    except (OSError,ValueError,OverflowError,TypeError):
        pass


def decision(root, host, project, task, profile, cost, gate, opened, evidence):
    append(root,"admission",dict(host=host,project=label(project),task=label(task),profile=label(profile),
                                 cost=cost,gate=gate,open=opened,**evidence))


def evidence(sample, reserved=None, limits=None, window=None, charged=None, available=None):
    fields=("at","cores","load5","totalGiB","memAvailableGiB","availableGiB","freeGiB","pressure","io_some_avg60","io_full_avg10")
    return dict(source="shared" if sample.get("sampleSource")=="shared" else "probe",
                sample={k:sample[k] for k in fields if numeric_metric(sample.get(k)) is not None},
                reserved=reserved,limits=limits,window=window,chargedCores=charged,availableBeforeFloorGiB=available)


def completion(root, host, slot, lease, darwin):
    try:
        end=time.time()
        start=float(lease["start"])
        if not 0 < start <= end:
            return
        rows=history(root,host,max(start-300,end-7*86400),end,darwin)
        previous=next((r for r in reversed(rows) if r["at"]<start),None)
        during=[r for r in rows if r["at"]>=start]
        peak=max((r["load5"] for r in during),default=None)
        low=min((r["memAvailableGiB"] for r in during),default=None)
        baseline={k:previous[k] for k in ("at","load5","memAvailableGiB")} if previous else None
        weights=lease.get("weights")
        if not isinstance(weights,(list,tuple)) or len(weights)!=3 or any(numeric_metric(v) is None for v in weights):
            weights=None
        append(root,"claims",dict(host=host,slot=slot,project=label(lease.get("project")),task=label(lease.get("task")),
                                  profile=label(lease.get("profile")),declared=weights,start=start,end=end,
                                  durationSeconds=end-start,baseline=baseline,count=len(during),peakLoad5=peak,
                                  lowAvailableGiB=low,deltaCores=max(0,peak-previous["load5"]) if previous and during else None,
                                  deltaGiB=max(0,previous["memAvailableGiB"]-low) if previous and during else None))
    except (KeyError,ValueError,TypeError,OSError,OverflowError):
        pass


def summary(values):
    values=sorted(v for v in values if type(v) in (float,int) and math.isfinite(v))
    if not values:
        return None
    return dict(p50=values[math.ceil(.5*len(values))-1],p90=values[math.ceil(.9*len(values))-1],max=values[-1])


def report(root, days):
    groups=defaultdict(lambda:dict(claims=0, measured=0,refusals=Counter(),values=defaultdict(list)))
    cutoff=time.time()-days*86400
    directory=Path(root)/"host-samples"
    for name in ("claims","admission"):
        for file in sorted(directory.glob(name+".????-??-??.ndjson")):
            if not re.fullmatch(name+r"(?:\.\d{4}-\d\d-\d\d)?\.ndjson", file.name) or file.is_symlink() or not file.is_file():
                continue
            with file.open() as stream:
                for line in stream:
                    try:
                        row=json.loads(line)
                        if row["schema"]!=1 or row["at"]<cutoff or row.get("type")=="placement":
                            continue
                        group=groups[(row["project"],row["profile"])]
                        if name=="admission":
                            if not row["open"]:
                                group["refusals"][row["gate"]]+=1
                            continue
                        group["claims"]+=1
                        for metric, value in zip(("declaredCores","declaredGiB","declaredDiskGiB"),row["declared"] or []):
                            group["values"][metric].append(value)
                        if row["deltaCores"] is not None:
                            group["measured"]+=1
                        for metric in ("deltaCores","deltaGiB"):
                            group["values"][metric].append(row[metric])
                    except (KeyError,TypeError,ValueError):
                        continue
    result=[]
    for (project,profile),group in sorted(groups.items()):
        percentiles={k:summary(v) for k,v in group.pop("values").items()}
        result.append(dict(project=project,profile=profile,**group,percentiles=percentiles))
    return dict(days=days,groups=result)


if __name__=="__main__":
    parser=argparse.ArgumentParser()
    parser.add_argument("root")
    parser.add_argument("--days",type=int,default=14,choices=range(1,15))
    args=parser.parse_args()
    print(json.dumps(report(args.root,args.days),indent=2))
