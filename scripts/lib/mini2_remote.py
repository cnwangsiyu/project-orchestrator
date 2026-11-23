"""Darwin-only, unsigned native runner. All mutable data belongs to one UUID.

No daemon workloads are qualified. Owned descendants and any unknown process
touching the workspace prevent cleanup and slot return; user activity is counted.
"""
import ctypes
from contextlib import contextmanager
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import re
import resource
import shutil
import signal
import shlex
import subprocess
import sys
import time
import uuid

GIB = 1024 ** 3
ROOT = Path.home() / "mac-build-runner"
SCRATCH = ("work", "cache", "home", "tmp", "DerivedData", "ModuleCache", "bin")


def command(args, **kwargs):
    return subprocess.run(args, check=True, capture_output=True, text=True,
                          timeout=kwargs.pop("timeout", 10), **kwargs).stdout.strip()


def atomic(file, value):
    tmp = file.with_name(file.name + "." + str(uuid.uuid4()) + ".tmp")
    with tmp.open("x") as stream:
        json.dump(value, stream)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(tmp, file)


def metrics():
    if sys.platform != "darwin":
        raise RuntimeError("Darwin required")
    total = int(command(["/usr/sbin/sysctl", "-n", "hw.memsize"]))
    vm = command(["/usr/bin/vm_stat"])
    page = int(re.search(r"page size of (\d+) bytes", vm)[1])
    pages = {k: int(v) for k, v in re.findall(r"^([^:\n]+):\s+(\d+)\.", vm, re.M)}
    level = subprocess.run(["/usr/sbin/sysctl", "-n", "kern.memorystatus_level"],
                           capture_output=True, text=True, timeout=5)
    if level.returncode == 0:
        percent = float(level.stdout)
        if not math.isfinite(percent) or not 0 <= percent <= 100:
            raise RuntimeError("invalid memorystatus level")
        available = total * percent / 100
    elif "unknown oid" in level.stderr.lower():
        available = page * sum(pages[k] for k in ("Pages free", "Pages inactive", "Pages speculative"))
    else:
        raise RuntimeError("memory evidence unavailable")
    pressure = int(command(["/usr/sbin/sysctl", "-n", "kern.memorystatus_vm_pressure_level"]))
    swap = command(["/usr/sbin/sysctl", "-n", "vm.swapusage"])
    used, unit = re.search(r"used = ([\d.]+)([MG])", swap).groups()
    location = ROOT if ROOT.exists() else Path.home()
    if location.is_symlink(): raise RuntimeError("runner root must not be a symlink")
    disk = os.statvfs(location)
    # Also require df to identify a readable filesystem at the actual runner root.
    command(["/bin/df", "-k", str(location)])
    usage = {}
    now=time.time()
    for file in (ROOT/"runs").glob("*/usage.json"):
        value=json.loads(file.read_text())
        if 0 <= now-value.get("at",0) < 15:
            usage[file.parent.name]={name:value[name] for name in ("at","cpuLoad","memoryGiB")}
    return dict(at=now, host=command(["/bin/hostname"]), os=command(["/usr/bin/sw_vers", "-productVersion"]),
                arch=command(["/usr/bin/uname", "-m"]), cores=int(command(["/usr/sbin/sysctl", "-n", "hw.ncpu"])),
                load5=os.getloadavg()[1], availableGiB=available/GIB, totalGiB=total/GIB,
                freeGiB=disk.f_bavail*disk.f_frsize/GIB, pressure=pressure,
                compressorGiB=pages["Pages occupied by compressor"]*page/GIB,
                swapGiB=float(used)/(1024 if unit == "M" else 1),leaseUsage=usage)


def facts():
    tools = {tool: command([tool, "--version"]).splitlines()[0] for tool in ("cmake", "ninja", "ccache")}
    tools["clang"] = command(["/usr/bin/clang", "--version"]).splitlines()[0]
    tools["xcode"] = command(["/usr/bin/xcodebuild", "-version"])
    tools["simulatorSDK"] = command(["/usr/bin/xcrun", "--sdk", "iphonesimulator", "--show-sdk-version"])
    try:
        tools["deviceSDK"] = command(["/usr/bin/xcrun", "--sdk", "iphoneos", "--show-sdk-version"])
    except subprocess.SubprocessError:
        tools["deviceSDK"] = None
    if tools["cmake"] != "cmake version 4.4.5" or tools["ninja"] != "1.13.2" or tools["ccache"] != "ccache version 4.14.3":
        raise RuntimeError("native tool version changed")
    if "clang-2100.3.34.2" not in tools["clang"] or tools["xcode"] != "Xcode 27.1\nBuild version 27A9275":
        raise RuntimeError("compiler version changed")
    if tools["simulatorSDK"] != "27.1": raise RuntimeError("simulator SDK version changed")
    caps = ["cmake-native", "xcode-ios-sim-compile"]
    if tools["deviceSDK"] == "27.1":
        caps.append("xcode-ios-device-compile-unsigned")
    return dict(at=time.time(), host=command(["/bin/hostname"]), caps=caps, tools=tools)


class BSDInfo(ctypes.Structure):
    _fields_ = [(name, ctypes.c_uint32) for name in (
        "flags", "status", "xstatus", "pid", "ppid", "uid", "gid", "ruid", "rgid", "svuid", "svgid", "rfu")]
    _fields_ += [("comm", ctypes.c_char*16), ("name", ctypes.c_char*32)]
    _fields_ += [(name, ctypes.c_uint32) for name in ("nfiles", "pgid", "pjobc", "tdev", "tpgid", "nice")]
    _fields_ += [("start_sec", ctypes.c_uint64), ("start_usec", ctypes.c_uint64)]


class UniqueInfo(ctypes.Structure):
    _fields_ = [("uuid",ctypes.c_ubyte*16),("unique",ctypes.c_uint64),("parent_unique",ctypes.c_uint64),
                ("version",ctypes.c_int32),("original_parent_version",ctypes.c_int32),
                ("reserved2",ctypes.c_uint64),("reserved3",ctypes.c_uint64)]


class ProcessInfo(ctypes.Structure):
    _fields_ = [("bsd",BSDInfo),("unique",UniqueInfo)]


def identity(pid):
    lib = ctypes.CDLL("/usr/lib/libproc.dylib", use_errno=True)
    lib.proc_pidinfo.argtypes=[ctypes.c_int,ctypes.c_int,ctypes.c_uint64,ctypes.c_void_p,ctypes.c_int]
    combined = ProcessInfo()
    result = lib.proc_pidinfo(int(pid), 18, 0, ctypes.byref(combined), ctypes.sizeof(combined))
    buf = combined.bsd
    if result == 0:
        try: os.kill(int(pid), 0)
        except ProcessLookupError: return None
        state = subprocess.run(["/bin/ps", "-p", str(pid), "-o", "stat="],
                               capture_output=True, text=True, timeout=3)
        if state.returncode == 1 and not state.stdout: return None
        if state.returncode == 0 and state.stdout.strip().startswith("Z"): return None
        raise RuntimeError("process identity unreadable")
    if result == ctypes.sizeof(combined) and buf.status == 5: return None  # Confirmed zombie.
    if result != ctypes.sizeof(combined) or buf.pid != int(pid) or buf.start_sec == 0 or not combined.unique.version:
        raise RuntimeError("invalid process identity")
    return dict(pid=buf.pid, ppid=buf.ppid, pgid=buf.pgid, uid=buf.uid,
                start=[buf.start_sec, buf.start_usec], version=combined.unique.version,
                originalParentVersion=combined.unique.original_parent_version)


def processes():
    listing = command(["/bin/ps", "-U", str(os.getuid()), "-o", "pid="])
    rows = {}
    for value in listing.split():
        row = identity(int(value))
        if row: rows[row["pid"]] = row
    return rows


def born(before, after):
    return {pid: row for pid, row in after.items()
            if pid not in before or before[pid]["start"] != row["start"]}


def attributed(current, ownership):
    """Attribute descendants by original parent generation, not process names.

    Unrelated and unknown processes are counted, never signaled. An unknown
    process touching the workspace is independently caught by lsof at cleanup.
    """
    pending={pid:row for pid,row in current.items() if row["version"] not in ownership}
    while pending:
        progressed=False
        for pid,row in list(pending.items()):
            if row["originalParentVersion"] in ownership:
                ownership[row["version"]]=ownership[row["originalParentVersion"]]
                pending.pop(pid); progressed=True
        if not progressed: break
    return {pid:row for pid,row in current.items() if ownership.get(row["version"]) is True}


def settle(before, timeout=5, ownership=None):
    """Wait for exiting children to disappear; never waive a surviving process."""
    deadline=time.monotonic()+timeout
    empty=0
    while True:
        current=processes()
        remaining=attributed(current,ownership) if ownership is not None else born(before,current)
        remaining.pop(os.getpid(),None)
        empty=empty+1 if not remaining else 0
        if empty >= 2 or time.monotonic() >= deadline: return remaining
        time.sleep(0.2)


def signal_owned(row, sig):
    current = identity(row["pid"])
    if current is None: return
    if current != row: raise RuntimeError("process identity changed; retained")
    os.kill(row["pid"], sig)


def location(run_id):
    if str(uuid.UUID(run_id)) != run_id: raise RuntimeError("invalid run UUID")
    if ROOT.is_symlink(): raise RuntimeError("symlink runner root")
    ROOT.mkdir(mode=0o700, exist_ok=True)
    if ROOT.stat().st_uid != os.getuid(): raise RuntimeError("foreign runner root")
    runs = ROOT / "runs"
    if runs.is_symlink(): raise RuntimeError("symlink runs directory")
    runs.mkdir(mode=0o700, exist_ok=True)
    run = runs / run_id
    if run.is_symlink(): raise RuntimeError("symlink run")
    return run


def disk_gate(estimate=0):
    sample = metrics()
    if sample["freeGiB"]-estimate < 20: raise RuntimeError("disk gate closed")
    return sample


def prepare(data):
    run = location(data["runId"])
    disk_gate(data["diskGiB"])
    run.mkdir(mode=0o700)  # Never replay or overwrite a launch UUID.
    atomic(run / "intent.json", data)
    print(json.dumps(dict(run=str(run))))


def receive(data):
    run = location(data["runId"])
    intent = json.loads((run / "intent.json").read_text())
    if data["file"] not in intent["uploads"]: raise RuntimeError("unknown upload")
    disk_gate(data["diskGiB"])
    file = run / data["file"]
    digest = hashlib.sha256()
    with file.open("xb") as out:
        while block := sys.stdin.buffer.read(1024*1024):
            out.write(block)
            digest.update(block)
    if digest.hexdigest() != intent["uploads"][data["file"]]: raise RuntimeError("upload digest mismatch")
    print("received")



def isolation(run, cores):
    """All writable compiler caches and default outputs are per run UUID."""
    jobs = str(max(1,math.floor(cores)))
    paths = {name:run/name for name in ("home","tmp","cache","DerivedData","ModuleCache","bin")}
    for folder in paths.values(): folder.mkdir(mode=0o700,exist_ok=True)
    wrapper = paths["bin"]/"xcodebuild"
    wrapper.write_text('#!/bin/bash\nexec /usr/bin/xcodebuild "$@" -derivedDataPath "$MINI2_DERIVED_DATA" -jobs "$MINI2_JOBS" CLANG_MODULE_CACHE_PATH="$MINI2_MODULE_CACHE"\n')
    wrapper.chmod(0o700)
    return dict(MINI2_TASK_HOME=str(paths["home"]),TMPDIR=str(paths["tmp"])+"/",
                CCACHE_DIR=str(paths["cache"]),CCACHE_BASEDIR=str(run/"work"),
                CMAKE_BUILD_PARALLEL_LEVEL=jobs,MAKEFLAGS="-j"+jobs,MINI2_JOBS=jobs,
                MINI2_DERIVED_DATA=str(paths["DerivedData"]),MINI2_MODULE_CACHE=str(paths["ModuleCache"]),
                CLANG_MODULE_CACHE_PATH=str(paths["ModuleCache"]),SWIFT_MODULECACHE_PATH=str(paths["ModuleCache"]),
                XDG_CACHE_HOME=str(paths["cache"]),MINI2_TASK_BIN=str(paths["bin"]))


@contextmanager
def execution_guard(run,dynamic):
    # The original runner's EX lock is still respected by concurrent SH runs.
    # Reconciliation takes the per-run EX lock, never another run's lock.
    with (ROOT/"execution.lock").open("a") as host, (run/"execution.lock").open("a") as lease:
        fcntl.flock(host, (fcntl.LOCK_SH if dynamic else fcntl.LOCK_EX) | fcntl.LOCK_NB)
        fcntl.flock(lease,fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield


def execute(data):
    run = location(data["runId"])
    with execution_guard(run,data.get("dynamic",False)):
        execute_owned(data)


def execute_owned(data):
    run = location(data["runId"])
    intent = json.loads((run / "intent.json").read_text())
    if intent != data: raise RuntimeError("launch intent mismatch")
    (run / "launched").touch(exist_ok=False)
    sample = disk_gate(data["diskGiB"])
    if sample["load5"] > 6 or sample["availableGiB"] < 16 or sample["pressure"] != 1:
        raise RuntimeError("launch admission closed")
    workspace = run / "work"
    command(["/usr/bin/git", "clone", "--no-checkout", str(run/"source.bundle"), str(workspace)], timeout=120)
    command(["/usr/bin/git", "-C", str(workspace), "checkout", "--detach", data["commit"]], timeout=120)
    if "worktree.patch" in data["uploads"]:
        command(["/usr/bin/git", "-C", str(workspace), "apply", "--binary", str(run/"worktree.patch")])
    # First version accepts tracked source only; no alternate extraction path.
    before = processes()
    # Original parents of already-existing processes also predate this run.
    # This records launchd's generation without inspecting a root-owned process.
    ownership={version:False for row in before.values() for version in (row["version"],row["originalParentVersion"])}
    ownership[before[os.getpid()]["version"]]=True
    boot = command(["/usr/sbin/sysctl", "-n", "kern.bootsessionuuid"])
    atomic(run/"baseline.json", dict(boot=boot, processes=before))
    cancelled = False
    timed_out = False
    def cancel(*_):
        nonlocal cancelled
        cancelled = True
    for sig in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT): signal.signal(sig, cancel)
    start = time.monotonic()
    deadline = start + data["timeoutSec"]
    tracked = {}
    failure = None
    errors = []
    peak_tree_rss = 0
    task_env = isolation(run,data.get("cores",4))
    # The account's toolchain setup may define cache/parallelism defaults. Task
    # values win after setup, including in the inherited child environment.
    launch = ('read -r ready && . "$HOME/.mini2-env.sh" && export '
              + ' '.join(name+'='+shlex.quote(value) for name,value in task_env.items())
              + ' HOME="$MINI2_TASK_HOME" PATH="$MINI2_TASK_BIN:$PATH" && exec /bin/bash -e -c "$1"')
    with (run/"build.log").open("xb") as log:
        child = subprocess.Popen(["/bin/bash", "-c", launch, "mini2", data["command"]],
                                 cwd=workspace, stdin=subprocess.PIPE, stdout=log, stderr=subprocess.STDOUT, start_new_session=True,
                                 env={**os.environ, **task_env})
        leader = identity(child.pid)
        if not leader: raise RuntimeError("leader identity missing")
        atomic(run/"process.json", dict(boot=boot, leader=leader, supervisor=identity(os.getpid())))
        tracked[child.pid] = leader
        ownership[leader["version"]]=True
        child.stdin.write(b"ready\n"); child.stdin.close()
        samples = [sample]
        last_sample = 0
        while child.poll() is None:
            try:
                current = processes()
                for row in current.values():
                    if row["pgid"] == leader["pgid"] and row["start"] >= leader["start"]:
                        ownership[row["version"]]=True
                attributed(current,ownership)
                family = {pid for pid,row in current.items() if ownership.get(row["version"]) is True and pid != os.getpid()}
                for pid in family:
                    if pid in current: tracked[pid] = current[pid]
                rss = command(["/bin/ps", "-U", str(os.getuid()), "-o", "pid=,rss=,pcpu="])
                owned = [line.split() for line in rss.splitlines() if len(line.split())==3 and int(line.split()[0]) in family]
                current_rss=sum(int(fields[1])*1024 for fields in owned)
                peak_tree_rss = max(peak_tree_rss,current_rss)
                if time.monotonic()-last_sample >= 2:
                    # CPU load averages converge over five minutes. Attribute
                    # only the corresponding elapsed portion of owned CPU use;
                    # the controller further caps credit by visible host delta.
                    cpu=sum(float(fields[2])/100 for fields in owned)
                    atomic(run/"usage.json",dict(at=time.time(),cpuLoad=cpu*(1-math.exp(-(time.monotonic()-start)/300)),memoryGiB=current_rss/GIB))
                    samples.append(metrics()); last_sample=time.monotonic()
            except Exception as error:
                errors.append(type(error).__name__+": "+str(error))
                failure = "process-or-metric-evidence-unavailable"; cancelled = True
            if cancelled or time.monotonic() >= deadline:
                timed_out = not cancelled
                for row in tracked.values():
                    try: signal_owned(row, signal.SIGTERM)
                    except Exception: failure = "process-identity-changed"
                try: child.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    for row in tracked.values():
                        try: signal_owned(row, signal.SIGKILL)
                        except Exception: failure = "process-identity-changed"
                break
            time.sleep(0.2)
        try: code = child.wait(timeout=5)
        except subprocess.TimeoutExpired: code = 124; failure = "command-still-live"
    # Never kill new unrelated processes. Conservatively retain on uncertainty.
    remaining = settle(before,ownership=ownership)
    if remaining: failure = "new-surviving-processes"
    atomic(run/"tracked.json", list(tracked.values()))
    atomic(run/"ownership.json",ownership)
    receipt = dict(runId=data["runId"], commit=data["commit"], boot=boot, exit=124 if timed_out else 143 if cancelled else code,
                   wallSec=time.monotonic()-start, cleanupReady=not failure, failure=failure,
                   cancelled=cancelled, timedOut=timed_out, samples=samples, evidenceErrors=errors, remaining=list(remaining.values()),
                   endedAt=time.time(), unrelatedObserved=sum(value is False for value in ownership.values()),
                   peakTreeRssBytes=peak_tree_rss, maxChildRssBytes=resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss)
    atomic(run/"receipt.json", receipt)
    print(json.dumps(receipt))


def app_is_unsigned(bundle):
    def raise_walk_error(error):
        raise error

    signing_entries = {"_codesignature", "embedded.mobileprovision"}
    for _, directories, files in os.walk(bundle, onerror=raise_walk_error):
        if signing_entries.intersection(name.casefold() for name in directories + files):
            return False
    return True


def collect(data):
    run = location(data["runId"])
    receipt = json.loads((run/"receipt.json").read_text())
    workspace = run/"work"
    artifacts = []
    for relative in data["artifacts"]:
        parts = Path(relative).parts
        if Path(relative).is_absolute() or not parts or any(p in ("..", ".") for p in parts):
            raise RuntimeError("unsafe artifact path")
        file = workspace/relative
        if file.is_symlink() or not file.is_file() or file.resolve() != file.absolute():
            raise RuntimeError("artifact is not a regular owned file")
        item = dict(path=relative, size=file.stat().st_size,
                    sha256=hashlib.sha256(file.read_bytes()).hexdigest())
        # Check the complete bundle on mini2, where unlisted files are visible.
        if file.name == "Info.plist" and file.parent.suffix == ".app":
            item["unsignedApp"] = app_is_unsigned(file.parent)
        artifacts.append(item)
    atomic(run/"artifacts.json", artifacts)
    print(json.dumps(dict(receipt=receipt, artifacts=artifacts)))


def fetch(data):
    run = location(data["runId"])
    name = data["file"]
    allowed = {"build.log", "receipt.json", "artifacts.json"}
    if name not in allowed:
        artifacts = json.loads((run/"artifacts.json").read_text())
        if name not in {"work/"+a["path"] for a in artifacts}: raise RuntimeError("unlisted fetch")
    file = run/name
    if file.resolve() != file.absolute() or not file.is_file(): raise RuntimeError("unsafe fetch")
    with file.open("rb") as stream: shutil.copyfileobj(stream, sys.stdout.buffer)


def clean(data, reconciled=False):
    run = location(data["runId"])
    if not run.exists(): raise RuntimeError("run evidence missing")
    if (run/"work").is_symlink(): raise RuntimeError("workspace was replaced")
    if not (run/"launched").exists():
        opened = subprocess.run(["/usr/sbin/lsof", "-nP", "+D", str(run), "-Fpn"],
                                capture_output=True, text=True, timeout=15)
        if opened.returncode != 1 or opened.stdout or opened.stderr: raise RuntimeError("upload still open")
        intent = json.loads((run/"intent.json").read_text())
        for name in intent["uploads"]: (run/name).unlink(missing_ok=True)
        receipt=dict(runId=data["runId"], clean=True, at=time.time(), neverLaunched=True)
        atomic(run/"clean.json",receipt); print(json.dumps(receipt)); return
    receipt = json.loads((run/"receipt.json").read_text())
    if not receipt["cleanupReady"] and not reconciled: raise RuntimeError("retained: cleanup unproved")
    baseline = json.loads((run/"baseline.json").read_text())
    if baseline["boot"] != command(["/usr/sbin/sysctl", "-n", "kern.bootsessionuuid"]):
        raise RuntimeError("boot changed; reconciliation required")
    for row in json.loads((run/"tracked.json").read_text()):
        current=identity(row["pid"])
        if current and current["start"] == row["start"]:
            raise RuntimeError("recorded process is present; retained")
    # The supervisor's SSH ancestry and this control operation can change. Check
    # exact workspace open files, plus every process recorded during execution.
    # The guard's own receipt/lock files stay open during reconciliation.
    # Check every writable scratch tree, excluding those evidence files.
    for name in SCRATCH:
        folder=run/name
        if not folder.exists(): continue
        opened = subprocess.run(["/usr/sbin/lsof", "-nP", "+D", str(folder), "-Fpn"],
                                capture_output=True, text=True, timeout=15)
        if opened.returncode != 1 or opened.stdout or opened.stderr:
            raise RuntimeError("open-file attribution not empty")
    if data.get("artifactsVerified") is not True: raise RuntimeError("artifact retention not confirmed")
    for name in SCRATCH:
        file = run/name
        if file.is_symlink(): raise RuntimeError("owned scratch replaced")
        if file.exists(): shutil.rmtree(file)
    for name in json.loads((run/"intent.json").read_text())["uploads"]:
        (run/name).unlink()
    atomic(run/"clean.json", dict(runId=data["runId"], clean=True, at=time.time()))
    print(json.dumps(dict(runId=data["runId"], clean=True)))


def reconcile(data):
    run=location(data["runId"])
    intent=json.loads((run/"intent.json").read_text())
    with execution_guard(run,intent.get("dynamic",False)):
        reconcile_owned(data)


def reconcile_owned(data):
    run=location(data["runId"])
    baseline=json.loads((run/"baseline.json").read_text())
    if baseline["boot"] != command(["/usr/sbin/sysctl","-n","kern.bootsessionuuid"]):
        raise RuntimeError("boot changed; retained")
    current=processes()
    if (run/"ownership.json").exists():
        ownership={int(version):owned for version,owned in json.loads((run/"ownership.json").read_text()).items()}
    else:
        # Compatibility for staged runs: reconstruct only unchanged baseline
        # processes. A disappeared parent remains unknown, never presumed safe.
        ownership={version:False for pid,row in current.items()
                   if str(pid) in baseline["processes"] and baseline["processes"][str(pid)]["start"] == row["start"]
                   for version in (row["version"],row["originalParentVersion"])}
        for row in json.loads((run/"tracked.json").read_text()):
            if row["pid"] in current and current[row["pid"]]["start"] == row["start"]:
                ownership[current[row["pid"]]["version"]]=True
    remaining=attributed(current,ownership)
    ancestor=os.getpid()
    while ancestor in current:
        remaining.pop(ancestor,None); ancestor=current[ancestor]["ppid"]
    if data.get("inspect"):
        labels={}
        for pid in remaining:
            lib=ctypes.CDLL("/usr/lib/libproc.dylib")
            info=BSDInfo()
            if lib.proc_pidinfo(pid,3,0,ctypes.byref(info),ctypes.sizeof(info)) == ctypes.sizeof(info):
                labels[pid]=dict(name=info.name.decode(errors="replace"),comm=info.comm.decode(errors="replace"),status=info.status)
        print(json.dumps(dict(remaining=list(remaining.values()),labels=labels,receipt=json.loads((run/"receipt.json").read_text())))); return
    if remaining: raise RuntimeError("unaccounted processes remain; retained")
    # A lost connection may leave no tracked record only if launch never began;
    # that case is handled separately by clean, never by this reconciliation.
    if not (run/"tracked.json").exists():
        raise RuntimeError("tracked process record missing; retained")
    clean(data,reconciled=True)


if __name__ == "__main__":
    operation, data = sys.argv[1], json.loads(sys.argv[2])
    if operation == "metrics": print(json.dumps(metrics()))
    elif operation == "facts": print(json.dumps(facts()))
    elif operation in ("prepare", "receive", "execute", "collect", "fetch", "clean", "reconcile"):
        globals()[operation](data)
    else: raise RuntimeError("unknown operation")
