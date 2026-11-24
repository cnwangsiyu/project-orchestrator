#!/usr/bin/env python3
"""Continuously sample registered hosts, sequentially, with one SSH per remote."""
import argparse
import datetime as dt
import fcntl
import json
import os
from pathlib import Path
import re
import shlex
import signal
import subprocess
import sys
import threading
import time

sys.dont_write_bytecode = True
from mini2_control import atomic, read, root_dir, HOST
from mini2_link import cable_ssh

HERE = Path(__file__).resolve().parent
SAFE_HOST = r"[A-Za-z0-9][A-Za-z0-9.-]*"


def targets(root):
    result = {os.uname().nodename: ("local", "", str(root))}
    for line in (root/"resources.tsv").read_text().splitlines():
        fields = line.split("\t", 4)
        if len(fields) != 5 or fields[1] != "remote":
            continue
        slot, _, _, _, description = fields
        if slot == "mini2-exec-1" and "bytedance@"+HOST in description.split():
            result[HOST] = ("mini2", "", "")
        if not re.fullmatch("devbox-host-"+SAFE_HOST, slot):
            continue
        addresses = set(re.findall(r"[A-Za-z_][A-Za-z0-9_.-]*@"+SAFE_HOST, description))
        if len(addresses) != 1:
            raise ValueError("ambiguous registered devbox target")
        target = addresses.pop()
        host = target.split("@")[1].rstrip(".")
        match = re.search(r"(?:^|\s)root=(\S+)", description)
        location = match[1] if match else ""
        if location and not re.fullmatch(r"/[A-Za-z0-9_./-]+", location):
            raise ValueError("invalid registered root")
        result[host] = ("linux", target, location)
    return result


def collect(mode, target, root):
    command = ["python3", "-B", "-", mode, root]
    if mode == "mini2":
        link = subprocess.run([sys.executable, "-B", str(HERE/"mini2_link.py"), "--resolve-usb"],
                              capture_output=True, timeout=8, check=True)
        address = json.loads(link.stdout)["address"]
        command = cable_ssh(address, timeout=5) + [shlex.join(["/usr/bin/python3", *command[1:]])]
    elif mode == "linux":
        command = ["ssh", "-T", "-oBatchMode=yes", "-oConnectTimeout=5", "-oGSSAPIDelegateCredentials=no",
                   target, shlex.join(command)]
    result = subprocess.run(command, input=(HERE/"host_probe.py").read_bytes(), capture_output=True, timeout=8, check=True)
    sample = json.loads(result.stdout)
    metrics = ("cores load1 load5 load15 totalGiB memAvailableGiB freeGiB pressure compressorGiB "
               "compressedLogicalGiB freeInactiveGiB swapGiB io_some_avg10 io_some_avg60 io_full_avg10").split()
    if not isinstance(sample, dict) or not set(sample) <= set(metrics+["arch"]) or any(
            type(v) not in (float,int) or not 0 <= v < float("inf") for k,v in sample.items() if k != "arch"):
        raise ValueError("invalid probe result")
    if "arch" in sample and sample["arch"] not in ("arm64","x86_64"):
        raise ValueError("invalid architecture")
    return sample


def error_class(error):
    if isinstance(error, subprocess.TimeoutExpired):
        return "timeout"
    message = (getattr(error, "stderr", b"") or b"").lower()
    for fragment, name in [(b"permission denied", "auth"), (b"host key verification", "auth"),
                           (b"timed out", "timeout"), (b"connection refused", "refused")]:
        if fragment in message:
            return name
    return "other"


def cycle(root, data, stop, probe=collect):
    hosts = targets(root)
    latest = read(data/"latest.json", {}).get("hosts", {})
    updated = {h: latest[h] for h in hosts if h in latest}
    for host, args in hosts.items():
        if stop.is_set():
            break
        previous = updated.get(host, {})
        now = time.time()
        if previous.get("ok") is False and 0 <= now-previous["at"] < 300:
            continue
        started = time.monotonic()
        try:
            row = dict(probe(*args), schema=1, host=host, at=now, ok=True)
            updated[host] = row
        except (OSError, ValueError, KeyError, subprocess.SubprocessError) as error:
            row = dict(schema=1, host=host, at=now, ok=False, errorClass=error_class(error))
            good = previous if previous.get("ok") else previous.get("lastGood")
            updated[host] = dict(row, lastGood=good)
        day = dt.datetime.fromtimestamp(now, dt.timezone.utc).date()
        directory = data/"history"/host
        directory.mkdir(parents=True, exist_ok=True)
        line = json.dumps(row, separators=(",", ":"), allow_nan=False)+"\n"
        with (directory/(str(day)+".ndjson")).open("a") as stream:
            stream.write(line)
        atomic(data/"latest.json", dict(schema=1, hosts=updated))
        print(f"{host} ok={row['ok']} bytes={len(line.encode())} seconds={time.monotonic()-started:.3f}", flush=True)
    cutoff = dt.datetime.now(dt.timezone.utc).date() - dt.timedelta(days=6)
    for file in (data/"history").glob("*/*.ndjson"):
        if re.fullmatch(r"\d{4}-\d\d-\d\d", file.stem) and file.stem < str(cutoff):
            file.unlink()


def main():
    parser = argparse.ArgumentParser()
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--once", action="store_true")
    mode.add_argument("--loop", type=int)
    parser.add_argument("--data-dir", type=Path)
    args = parser.parse_args()
    if args.loop is not None and args.loop < 1:
        parser.error("positive interval required")
    root = root_dir()
    data = args.data_dir or root/"host-samples"
    data.mkdir(parents=True, exist_ok=True)
    stop = threading.Event()
    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, lambda *_: stop.set())
    with (data/"sampler.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            sys.exit("sampler already running")
        while not stop.is_set():
            start = time.monotonic()
            cycle(root, data, stop)
            if args.once:
                break
            stop.wait(max(0, args.loop-(time.monotonic()-start)))


if __name__ == "__main__":
    main()
