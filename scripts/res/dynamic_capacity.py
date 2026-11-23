"""Shared weighted headroom calculation for remote host leases.

Callers own metric validation, policy, locking, reservation lifetimes and I/O
gates. Keeping this arithmetic common prevents host allocators from drifting.
"""


def headroom(load, available, free, reserved, cost, load_limit, memory_floor, disk_floor):
    cpu, memory, disk = reserved
    if free - disk - cost[2] < disk_floor:
        return "disk"
    if available - memory - cost[1] < memory_floor:
        return "memory"
    if load + cpu + cost[0] > load_limit:
        return "load"
    return "open"
