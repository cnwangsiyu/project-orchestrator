"""Shared weighted headroom calculation for remote host leases.

Callers own metric validation, policy, locking, reservation lifetimes and I/O
gates. Keeping this arithmetic common prevents host allocators from drifting.
"""
import math
import datetime


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


def reservation_totals(leases):
    """Retain every declared peak until return or ownership-proven reclamation."""
    costs=[]
    for lease in leases:
        cost=lease.get("weights")
        if not isinstance(cost,list) or len(cost)!=3 or any(numeric_metric(v) is None for v in cost) or cost[0]<=0 or cost[1]<=0:
            raise ValueError("legacy-or-incomplete-hold")
        costs.append(list(cost))
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
