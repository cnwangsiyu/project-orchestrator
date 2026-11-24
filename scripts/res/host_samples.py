"""Validated, optional capacity evidence shared by the three host allocators."""
from functools import lru_cache
import json
import os
from pathlib import Path
import re
import stat
import sys
import time

from dynamic_capacity import numeric_metric


@lru_cache(maxsize=16)
def contents(path, stamp):
    with path.open("rb") as stream:
        return stream.read(stamp[2]+1).decode()


def small_file(path, limit):
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_size > limit:
        raise ValueError("invalid sample file")
    return contents(path, (info.st_ino, info.st_mtime_ns, info.st_size))


def options(root):
    defaults = dict(SHARED_SAMPLES=1, SAMPLE_TTL=180)
    result = defaults.copy()
    try:
        seen = set()
        for line in small_file(Path(root)/"machine.conf", 65536).splitlines():
            name, _, value = (s.strip() for s in line.partition("="))
            if name not in defaults:
                continue
            maximum = 1 if name == "SHARED_SAMPLES" else 86400
            if name in seen or not re.fullmatch(r"[0-9]{1,5}", value) or int(value)>maximum:
                raise ValueError("invalid sampling setting")
            result[name] = int(value)
            seen.add(name)
    except (ValueError,OSError):
        result["SHARED_SAMPLES"] = 0
    return result


def valid(row, host, darwin):
    if not isinstance(row,dict) or row.get("ok") is not True or row.get("host") != host:
        return False
    if type(row.get("schema")) is not int or row["schema"] != 1:
        return False
    required = ["at","load1","load5","load15","memAvailableGiB","freeGiB","totalGiB"]
    if darwin:
        required.extend(("pressure","compressorGiB","compressedLogicalGiB","swapGiB","freeInactiveGiB"))
        if row.get("arch") not in ("arm64","x86_64") or row.get("pressure") not in (1,2,4):
            return False
    if any(numeric_metric(row.get(k)) is None for k in required):
        return False
    if type(row.get("cores")) is not int or not 0 < row["cores"] <= 65536:
        return False
    if not row["totalGiB"] or row["memAvailableGiB"] > row["totalGiB"]:
        return False
    return all(numeric_metric(row[k]) is not None and row[k]<=100
               for k in ("io_some_avg10","io_some_avg60","io_full_avg10") if k in row)


@lru_cache(maxsize=4)
def latest(raw):
    obj = json.loads(raw)
    if not isinstance(obj,dict) or type(obj.get("schema")) is not int or obj["schema"] != 1:
        return {}
    return obj["hosts"] if isinstance(obj.get("hosts"),dict) else {}


def shared(root, host, now, darwin=False):
    path = Path(root)/"host-samples/latest.json"
    try:
        raw = small_file(path, 1024**2)
        cfg = options(root)
        row = latest(raw).get(host)
        if cfg["SHARED_SAMPLES"] and valid(row,host,darwin) and 0 <= now-row["at"] < cfg["SAMPLE_TTL"]:
            return dict(row, availableGiB=row["memAvailableGiB"], sampleSource="shared", sampleTTL=cfg["SAMPLE_TTL"])
    except (ValueError,OSError,RecursionError):
        pass
    return {}


if __name__ == "__main__":
    root, platform, *hosts = sys.argv[1:]
    print(json.dumps({h:v for h in hosts if (v:=shared(root,h,time.time(),platform=="darwin"))}))
