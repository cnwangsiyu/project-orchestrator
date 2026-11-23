"""Shared weighted headroom calculation for remote host leases.

Callers own metric validation, policy, locking, reservation lifetimes and I/O
gates. Keeping this arithmetic common prevents host allocators from drifting.
"""
import math
import ctypes
import sys
import datetime


class ProcessUsage(ctypes.Structure):
    # Darwin rusage_info_v0, the stable prefix accepted by proc_pid_rusage.
    _fields_=[("uuid",ctypes.c_ubyte*16)]+[(name,ctypes.c_uint64) for name in (
        "user_time","system_time","idle_wakeups","interrupt_wakeups","pageins",
        "wired_size","resident_size","phys_footprint","start_time","exit_time")]


def process_usage(pid):
    """Kernel generation and private ledger, using the stable Darwin prefix."""
    if sys.platform!="darwin": return None
    try:
        lib=ctypes.CDLL("/usr/lib/libproc.dylib",use_errno=True)
        lib.proc_pid_rusage.argtypes=[ctypes.c_int,ctypes.c_int,ctypes.c_void_p]
        value=ProcessUsage()
        if lib.proc_pid_rusage(int(pid),0,ctypes.byref(value)): return None
        return value
    except (OSError,AttributeError): return None


def process_clock():
    if sys.platform!="darwin": return None
    try:
        lib=ctypes.CDLL(None)
        lib.mach_absolute_time.restype=ctypes.c_uint64
        return lib.mach_absolute_time()
    except (OSError,AttributeError): return None


def process_birth(pid):
    value=process_usage(pid)
    return value.start_time if value and value.start_time and not value.exit_time else None


def physical_footprint(pid):
    """Private process ledger; unavailable evidence receives no reservation credit."""
    value=process_usage(pid)
    return min(value.phys_footprint,value.resident_size) if value else 0


def numeric_metric(value, positive=False):
    if type(value) not in (int,float): return None
    try:
        return value if math.isfinite(value) and (value>0 if positive else value>=0) else None
    except OverflowError: return None


def iso_timestamp(value):
    if numeric_metric(value) is None: return None
    try: return datetime.datetime.fromtimestamp(value,datetime.timezone.utc).isoformat()
    except (ValueError,OverflowError,OSError): return None


def cached_timestamp(value):
    if isinstance(value,str):
        try:
            parsed=datetime.datetime.fromisoformat(value.replace("Z","+00:00"))
            return value if parsed.tzinfo and parsed.timestamp()>=0 else None
        except (ValueError,OverflowError,OSError): return None
    return None


def json_safe(value):
    if isinstance(value,float) and not math.isfinite(value): return None
    if isinstance(value,dict): return {name:json_safe(item) for name,item in value.items()}
    if isinstance(value,(list,tuple)): return [json_safe(item) for item in value]
    return value


def smaller_bypass(cost, older_cost, reason, count, maximum):
    return (reason in ("load","memory","disk") and count < maximum
            and all(x <= y for x,y in zip(cost,older_cost))
            and any(x < y for x,y in zip(cost,older_cost)))


def reservation_totals(leases, sample=None, now=None):
    costs=[]
    for lease in leases:
        cost=lease.get("weights")
        if not isinstance(cost,list) or len(cost)!=3 or any(numeric_metric(v) is None for v in cost) or cost[0]<=0 or cost[1]<=0:
            raise ValueError("legacy-or-incomplete-hold")
        costs.append(list(cost))
    if sample and now is not None and all(numeric_metric(sample.get(name)) is not None for name in ("load5","availableGiB")):
        baselines=[lease["baseline"] for lease in leases if lease.get("baseline")]
        if any(not isinstance(v,dict) or any(numeric_metric(v.get(name)) is None for name in ("load5","availableGiB")) for v in baselines):
            raise ValueError("invalid reservation baseline")
        visible=[max(0,sample["load5"]-min((v["load5"] for v in baselines),default=sample["load5"])),
                 max(0,max((v["availableGiB"] for v in baselines),default=sample["availableGiB"])-sample["availableGiB"])]
        usages=sample.get("leaseUsage",{})
        if not isinstance(usages,dict): usages={}
        for lease,cost in zip(leases,costs):
            usage=usages.get(lease.get("runId"),{})
            if not isinstance(usage,dict): continue
            if lease.get("ownerId"):
                workload=lease.get("workload",{})
                if (lease.get("dispatch")!="bound" or not isinstance(workload,dict) or not workload
                    or usage.get("generation")!=lease.get("generation")
                    or usage.get("workloadPid")!=workload.get("pid")
                    or usage.get("workloadBirth")!=workload.get("birth")):
                    continue
            at=usage.get("at")
            if numeric_metric(at) is None or not 0<=now-at<15: continue
            for index,name in ((0,"cpuLoad"),(1,"memoryGiB")):
                amount=usage.get(name)
                if numeric_metric(amount) is None: continue
                credit=min(cost[index],amount,visible[index])
                cost[index]-=credit; visible[index]-=credit
    amounts=tuple(sum(cost[i] for cost in costs) for i in range(3))
    if any(numeric_metric(value) is None for value in amounts): raise ValueError("invalid reservation total")
    return amounts


def headroom(load, available, free, reserved, cost, load_limit, memory_floor, disk_floor):
    cpu, memory, disk = reserved
    if free - disk - cost[2] < disk_floor:
        return "disk"
    if available - memory - cost[1] < memory_floor:
        return "memory"
    if load + cpu + cost[0] > load_limit:
        return "load"
    return "open"
