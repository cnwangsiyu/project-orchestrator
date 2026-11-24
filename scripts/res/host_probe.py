"""Read-only host probe, also sent over SSH on standard input."""
import json
import os
from pathlib import Path
import platform
import re
import subprocess
import sys


def darwin(local):
    def sysctl(name):
        return subprocess.check_output(["/usr/sbin/sysctl", "-n", name], text=True).strip()

    total = int(sysctl("hw.memsize")) / 2**30
    vm = subprocess.check_output(["/usr/bin/vm_stat"], text=True)
    unit = int(re.search(r"page size of (\d+) bytes", vm)[1]) / 2**30
    pages = {k: int(v)*unit for k, v in re.findall(r"^([^:\n]+):\s+(\d+)\.", vm, re.M)}
    free = pages["Pages free"] + pages["Pages inactive"]
    level = subprocess.run(["/usr/sbin/sysctl", "-n", "kern.memorystatus_level"], capture_output=True, text=True)
    if level.returncode == 0:
        percent = float(level.stdout)
        if not 0 <= percent <= 100:
            raise ValueError("invalid available memory")
        available = total * percent / 100
    elif "unknown oid" in level.stderr.lower():
        available = free + (0 if local else pages["Pages speculative"])
    else:
        raise ValueError("available memory unavailable")
    amount, scale = re.search(r"used\s*=\s*([\d.]+)([KMGT])", sysctl("vm.swapusage")).groups()
    return dict(arch=platform.machine(), cores=int(sysctl("hw.physicalcpu" if local else "hw.ncpu")),
                totalGiB=total, memAvailableGiB=available, pressure=int(sysctl("kern.memorystatus_vm_pressure_level")),
                compressorGiB=pages["Pages occupied by compressor"], compressedLogicalGiB=pages["Pages stored in compressor"],
                freeInactiveGiB=free, swapGiB=float(amount)*1024**("KMGT".index(scale)-2))


def linux():
    mem = dict(re.findall(r"^(MemAvailable|MemTotal):\s+(\d+) kB$", Path("/proc/meminfo").read_text(), re.M))
    result = dict(cores=os.cpu_count(), totalGiB=int(mem["MemTotal"])/2**20, memAvailableGiB=int(mem["MemAvailable"])/2**20)
    try:
        for line in Path("/proc/pressure/io").read_text().splitlines():
            category, *fields = line.split()
            for field in fields:
                name, _, value = field.partition("=")
                if (category, name) in (("some", "avg10"), ("some", "avg60"), ("full", "avg10")):
                    result["io_"+category+"_"+name] = float(value)
    except FileNotFoundError:
        pass
    return result


def probe(mode, root):
    if mode == "linux":
        if not root:
            user = os.environ["USER"]
            root = next(p for p in [Path("/data00/home")/user/"devbox-run", Path("/data00")/user/"devbox-run",
                                    Path.home()/"devbox-run"] if p.is_dir())
        result = linux()
    else:
        if mode == "mini2":
            if os.uname().nodename != "Bytedances-Mac-mini.local":
                raise ValueError("host mismatch")
            root = Path.home()/"mac-build-runner"
            if not root.exists():
                root = Path.home()
        result = darwin(mode == "local")
    disk = os.statvfs(root)
    result["load1"], result["load5"], result["load15"] = os.getloadavg()
    result["freeGiB"] = disk.f_bavail * disk.f_frsize / 2**30
    return result


if __name__ == "__main__":
    print(json.dumps(probe(*sys.argv[1:]), allow_nan=False))
