import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shlex
import signal
import subprocess
import sys
sys.dont_write_bytecode = True
import tempfile
import unittest
from unittest.mock import patch
import uuid
from contextlib import ExitStack

spec=importlib.util.spec_from_file_location("mini2_remote",Path(__file__).resolve().parents[2]/"lib/mini2_remote.py")
m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)

class RemoteTests(unittest.TestCase):
    def test_read_only_scratch_cleanup_on_prelaunch_normal_and_reconcile_paths(self):
        for launched, reconciled in ((False, False), (True, False), (True, True)):
            with self.subTest(launched=launched, reconciled=reconciled),\
                 tempfile.TemporaryDirectory() as temp,patch.object(m,"ROOT",Path(temp)/"runner"),patch.object(m,"disk_gate"):
                data=dict(runId=str(uuid.uuid4()),diskGiB=1,uploads={},artifactsVerified=True)
                with contextlib.redirect_stdout(io.StringIO()): m.prepare(data)
                run=m.location(data["runId"])
                outside=Path(temp)/"outside"; outside.mkdir()
                keep=outside/"keep"; keep.write_text("fixture"); keep.chmod(0o400); outside.chmod(0o500)
                for name in m.SCRATCH:
                    nested=run/name/"nested"/"input"; nested.mkdir(parents=True)
                    file=nested/"input.mp4"; file.write_text("fixture"); file.chmod(0o400)
                    (nested/"outside").symlink_to(outside,target_is_directory=True)
                    nested.chmod(0o500); nested.parent.chmod(0o500); (run/name).chmod(0o500)
                if launched:
                    (run/"launched").touch()
                    m.atomic(run/"receipt.json",dict(cleanupReady=not reconciled))
                    m.atomic(run/"baseline.json",dict(boot="fixture",processes={}))
                    m.atomic(run/"tracked.json",[])
                try:
                    with patch.object(m,"command",return_value="fixture"),\
                         patch.object(m,"processes",return_value={}),\
                         patch.object(subprocess,"run",return_value=subprocess.CompletedProcess([],1,"","")),\
                         contextlib.redirect_stdout(io.StringIO()):
                        if reconciled: m.reconcile(data)
                        else: m.clean(data)
                    self.assertFalse(any((run/name).exists() for name in m.SCRATCH))
                    self.assertTrue(json.loads((run/"clean.json").read_text())["clean"])
                    self.assertEqual(outside.stat().st_mode & 0o777,0o500)
                    self.assertEqual(keep.stat().st_mode & 0o777,0o400)
                    self.assertEqual(keep.read_text(),"fixture")
                finally:
                    outside.chmod(0o700)

    def test_scratch_cleanup_refuses_foreign_entries_and_top_level_symlinks(self):
        for kind in ("root", "directory", "file", "symlink"):
            with self.subTest(kind=kind),tempfile.TemporaryDirectory() as temp,patch.object(m,"ROOT",Path(temp)/"runner"):
                run=m.location(str(uuid.uuid4())); nested=run/"home"/"nested"; nested.mkdir(parents=True)
                file=nested/"keep"; file.write_text("fixture"); file.chmod(0o400)
                outside=Path(temp)/"outside"; outside.mkdir()
                (nested/"link").symlink_to(outside,target_is_directory=True)
                nested.chmod(0o500); (run/"home").chmod(0o500)
                target={"root":"home","directory":"nested","file":"keep","symlink":"link"}[kind]
                real_stat=os.stat
                def foreign_stat(name,*args,**kwargs):
                    info=real_stat(name,*args,**kwargs)
                    if os.fspath(name)==target:
                        fields=list(info); fields[4]=os.geteuid()+1; return os.stat_result(fields)
                    return info
                with patch.object(os,"stat",side_effect=foreign_stat),self.assertRaisesRegex(RuntimeError,"owner mismatch"):
                    m.remove_owned_scratch(run,"home")
                if kind=="symlink": self.assertTrue((nested/"link").is_symlink())
                else:
                    self.assertTrue(file.exists()); self.assertEqual(file.stat().st_mode & 0o777,0o400)
                if kind in ("root","directory"):
                    folder=run/"home" if kind=="root" else nested
                    self.assertEqual(folder.stat().st_mode & 0o777,0o500)
                (run/"tmp").symlink_to(outside,target_is_directory=True)
                with self.assertRaisesRegex(RuntimeError,"symlink or non-directory"):
                    m.remove_owned_scratch(run,"tmp")
                self.assertTrue((run/"tmp").is_symlink()); self.assertTrue(outside.is_dir())

    def test_scratch_cleanup_restores_inaccessible_directories(self):
        with tempfile.TemporaryDirectory() as temp,patch.object(m,"ROOT",Path(temp)/"runner"):
            run=m.location(str(uuid.uuid4())); nested=run/"tmp"/"nested"; nested.mkdir(parents=True)
            (nested/"keep").write_text("fixture")
            nested.chmod(0); (run/"tmp").chmod(0)
            m.remove_owned_scratch(run,"tmp")
            self.assertFalse((run/"tmp").exists())

    def test_metrics_do_not_read_usage_or_credit_mid_sample_materialization(self):
        with tempfile.TemporaryDirectory() as temp,patch.object(m,"ROOT",Path(temp)):
            actual={"available":24}
            def measured(command):
                if command[0]=="/usr/sbin/sysctl":
                    return {"hw.memsize":str(32*2**30),"hw.ncpu":"10",
                            "kern.memorystatus_vm_pressure_level":"1","vm.swapusage":"used = 0M"}[command[-1]]
                if command[0]=="/usr/bin/vm_stat":
                    return ("Mach Virtual Memory Statistics: (page size of 16384 bytes)\n"
                            "Pages occupied by compressor: 0.\nPages stored in compressor: 0.\n")
                if command[0]=="/bin/df": actual["available"]-=8
                return "fixture"
            with patch.object(m.sys,"platform","darwin"),patch.object(m,"command",side_effect=measured),\
                 patch.object(m.subprocess,"run",return_value=subprocess.CompletedProcess([],0,"75\n","")),\
                 patch.object(m.os,"getloadavg",return_value=(0,0,0)),\
                 patch.object(Path,"glob",side_effect=AssertionError("metric sampling must not collect lease usage")):
                sample=m.metrics()
            self.assertEqual(sample["availableGiB"],24)
            self.assertEqual(actual["available"],16)
            self.assertNotIn("leaseUsage",sample)
            self.assertLess(sample["availableGiB"]-2*8-8,4,"full reservations reject a third heavy peak")

    def test_dynamic_launch_uses_resolved_config_instead_of_legacy_limits(self):
        data=dict(dynamic=True,limits=dict(loadLimit=10,memoryFloorGiB=4,diskFloorGiB=30))
        sample=dict(load5=7,availableGiB=14,pressure=1,freeGiB=40)
        m.launch_gate(sample,data)
        with self.assertRaisesRegex(RuntimeError,"launch admission"): m.launch_gate(sample,{})
        with self.assertRaisesRegex(RuntimeError,"missing"): m.launch_gate(sample,dict(dynamic=True))
        for change in (dict(load5=10.1),dict(availableGiB=3.9),dict(pressure=2)):
            with self.assertRaisesRegex(RuntimeError,"launch admission"): m.launch_gate({**sample,**change},data)
        with patch.object(m,"metrics",return_value=sample):
            m.disk_gate(10,m.launch_limits(data)["diskFloorGiB"])
            with self.assertRaisesRegex(RuntimeError,"disk gate"): m.disk_gate(10.1,30)

    def test_rejected_prelaunch_cleans_owned_workspace_without_receipt(self):
        with tempfile.TemporaryDirectory() as temp,patch.object(m,"ROOT",Path(temp)/"runner"),patch.object(m,"disk_gate"):
            data=dict(runId=str(uuid.uuid4()),diskGiB=1,uploads={})
            with contextlib.redirect_stdout(io.StringIO()): m.prepare(data)
            run=m.location(data["runId"])
            for name in m.SCRATCH: (run/name).mkdir()
            with patch.object(subprocess,"run",return_value=subprocess.CompletedProcess([],1,"","")),contextlib.redirect_stdout(io.StringIO()): m.clean(data)
            self.assertFalse(any((run/name).exists() for name in m.SCRATCH))
            self.assertTrue(json.loads((run/"clean.json").read_text())["neverLaunched"])

    def test_concurrent_guards_isolate_runs_and_respect_legacy_lock(self):
        with tempfile.TemporaryDirectory() as temp,patch.object(m,"ROOT",Path(temp)/"runner"):
            runs=[m.location(str(uuid.uuid4())) for _ in range(3)]
            for run in runs: run.mkdir()
            with ExitStack() as stack:
                for run in runs: stack.enter_context(m.execution_guard(run,True))
                with self.assertRaises(BlockingIOError):
                    with m.execution_guard(runs[0],True): pass
                with self.assertRaises(BlockingIOError):
                    with m.execution_guard(runs[0],False): pass
            with m.execution_guard(runs[0],False):
                with self.assertRaises(BlockingIOError):
                    with m.execution_guard(runs[1],True): pass

    def test_every_mutable_compiler_path_is_distinct(self):
        with tempfile.TemporaryDirectory() as temp,patch.object(m,"ROOT",Path(temp)/"runner"):
            environments=[]
            for cores in (1,4,2):
                run=m.location(str(uuid.uuid4())); run.mkdir()
                env=m.isolation(run,cores); environments.append(env)
                self.assertEqual(env["MAKEFLAGS"],"-j"+str(cores))
                wrapper=(run/"bin"/"xcodebuild").read_text()
                self.assertIn('-derivedDataPath "$MINI2_DERIVED_DATA"',wrapper)
                self.assertIn('CLANG_MODULE_CACHE_PATH="$MINI2_MODULE_CACHE"',wrapper)
            for name in ("MINI2_TASK_HOME","TMPDIR","CCACHE_DIR","MINI2_DERIVED_DATA","MINI2_MODULE_CACHE","XDG_CACHE_HOME","MINI2_TASK_BIN"):
                self.assertEqual(len({env[name] for env in environments}),3,name)

    def test_xcodebuild_only_adds_isolation_flags_to_build_actions(self):
        with tempfile.TemporaryDirectory(prefix="mini2 wrapper ") as temp:
            run = Path(temp)
            env = m.isolation(run, 4)
            wrapper = run / "bin" / "xcodebuild"
            fake = run / "fake-xcodebuild"
            fake.write_text('#!/bin/bash\nprintf "%s\\0" "$@"\n')
            fake.chmod(0o700)
            script = wrapper.read_text()
            self.assertEqual(script.count("exec /usr/bin/xcodebuild "), 2)
            wrapper.write_text(script.replace("/usr/bin/xcodebuild", shlex.quote(str(fake))))

            cases = [
                ["-version"], ["-showsdks"], ["-list", "-json"],
                ["-downloadPlatform", "iOS"],
                ["-downloadAllPlatforms"], ["-importPlatform", "runtime image.dmg"],
                ["-checkFirstLaunchStatus"],
            ]
            def invoke(args):
                result = subprocess.check_output([str(wrapper), *args], env={**os.environ, **env})
                return result.decode().split("\0")[:-1]

            for args in cases:
                with self.subTest(args=args):
                    self.assertEqual(invoke(args), args)
            # Build-settings queries keep the isolation flags so reported paths match the real build.
            for build in (["-scheme", "Fixture App", "build"],
                          ["-workspace", "Fixture App.xcworkspace", "-scheme", "Fixture App", "-showBuildSettings"],
                          ["-showBuildSettingsForIndex"],
                          ["-scheme", "Fixture App", "-showdestinations"],
                          ["-list", "-scheme", "Fixture App"],
                          ["-scheme", "Fixture App", "-list"]):
                with self.subTest(args=build):
                    self.assertEqual(invoke(build), [
                        *build, "-derivedDataPath", env["MINI2_DERIVED_DATA"], "-jobs", "4",
                        "CLANG_MODULE_CACHE_PATH=" + env["MINI2_MODULE_CACHE"],
                    ])

            for action in ("-runFirstLaunch", "-license"):
                with self.subTest(action=action):
                    result = subprocess.run(
                        [str(wrapper), "-version", action], env={**os.environ, **env},
                        capture_output=True, text=True,
                    )
                    self.assertEqual(result.returncode, 64)
                    self.assertEqual(result.stdout, "")
                    self.assertIn(action + " changes host-wide state", result.stderr)

    def test_cleanup_checks_cache_files_and_excludes_its_guard(self):
        with tempfile.TemporaryDirectory() as temp,patch.object(m,"ROOT",Path(temp)/"runner"):
            run=m.location(str(uuid.uuid4())); run.mkdir()
            for name in m.SCRATCH: (run/name).mkdir()
            (run/"launched").touch()
            m.atomic(run/"receipt.json",dict(cleanupReady=True))
            m.atomic(run/"baseline.json",dict(boot="fixture"))
            m.atomic(run/"tracked.json",[])
            m.atomic(run/"intent.json",dict(uploads={}))
            def opened(args,**_):
                path=Path(args[args.index("+D")+1])
                return subprocess.CompletedProcess(args,0 if path.name=="ModuleCache" else 1,"p42\n" if path.name=="ModuleCache" else "","")
            with patch.object(m,"command",return_value="fixture"),patch.object(subprocess,"run",side_effect=opened):
                with self.assertRaisesRegex(RuntimeError,"open-file"): m.clean(dict(runId=run.name,artifactsVerified=True))
            self.assertTrue((run/"work").exists())
            with m.execution_guard(run,True),patch.object(m,"command",return_value="fixture"),patch.object(subprocess,"run",return_value=subprocess.CompletedProcess([],1,"","")) as lsof,contextlib.redirect_stdout(io.StringIO()):
                m.clean(dict(runId=run.name,artifactsVerified=True))
            self.assertEqual(len(lsof.call_args_list),len(m.SCRATCH))
            self.assertFalse(any((run/name).exists() for name in m.SCRATCH))

    def test_device_facts_require_pinned_sdk(self):
        versions = {
            "cmake": "cmake version 4.4.5", "ninja": "1.13.2", "ccache": "ccache version 4.14.3",
            "/usr/bin/clang": "Apple clang (clang-2100.3.34.2)",
            "/usr/bin/xcodebuild": "Xcode 27.1\nBuild version 27A9275",
            "/bin/hostname": "Bytedances-Mac-mini.local",
        }
        for sdk in ("27.1", "27.0", None):
            with self.subTest(sdk=sdk):
                def version(args):
                    if args[0] == "/usr/bin/xcrun":
                        if args[2] == "iphonesimulator":
                            return "27.1"
                        self.assertEqual(args[2:], ["iphoneos", "--show-sdk-version"])
                        if sdk is None:
                            raise subprocess.CalledProcessError(1, args)
                        return sdk
                    return versions[args[0]]

                with patch.object(m, "command", side_effect=version):
                    facts = m.facts()
                self.assertEqual(facts["tools"]["deviceSDK"], sdk)
                caps = ["cmake-native", "xcode-ios-sim-compile"]
                if sdk == "27.1":
                    caps.append("xcode-ios-device-compile-unsigned")
                self.assertEqual(facts["caps"], caps)

    def test_collect_checks_signing_files_even_if_they_are_not_retained(self):
        with tempfile.TemporaryDirectory() as temp, patch.object(m, "ROOT", Path(temp).resolve()/"runner"):
            run = m.location(str(uuid.uuid4()))
            relative = "Fixture.app/Info.plist"
            plist = run/"work"/relative
            plist.parent.mkdir(parents=True)
            plist.touch()
            m.atomic(run/"receipt.json", {})
            signing_entries = [plist.parent/"_CodeSignature", plist.parent/"embedded.mobileprovision"]
            for entry in signing_entries:
                with self.subTest(entry=entry):
                    entry.touch()
                    with contextlib.redirect_stdout(io.StringIO()):
                        m.collect(dict(runId=run.name, artifacts=[relative]))
                    self.assertIs(json.loads((run/"artifacts.json").read_text())[0]["unsignedApp"], False)
                    entry.unlink()
            with contextlib.redirect_stdout(io.StringIO()):
                m.collect(dict(runId=run.name, artifacts=[relative]))
            self.assertIs(json.loads((run/"artifacts.json").read_text())[0]["unsignedApp"], True)

    @unittest.skipUnless(sys.platform == "darwin", "Darwin kernel identity acceptance")
    def test_kernel_original_parent_survives_reparenting(self):
        module=str(Path(__file__).resolve().parents[2]/"lib/mini2_remote.py")
        script='''import importlib.util,json,os,sys,time
spec=importlib.util.spec_from_file_location("remote",sys.argv[1]); m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
print(json.dumps(m.identity(os.getpid())),flush=True)
pid=os.fork()
if pid:
 print(pid,flush=True); os._exit(0)
os.setsid(); os.close(1); os.close(2); time.sleep(5); os._exit(0)
'''
        parent=subprocess.Popen([sys.executable,"-B","-c",script,module],stdout=subprocess.PIPE,text=True)
        child=None
        try:
            original=json.loads(parent.stdout.readline())
            child=int(parent.stdout.readline())
            parent.wait(timeout=3)
            row=m.identity(child)
            self.assertIsNotNone(row)
            self.assertEqual(row["originalParentVersion"],original["version"])
            self.assertEqual(row["ppid"],1)
            self.assertEqual(set(m.attributed({child:row},{original["version"]:True})),{child})
        finally:
            if child:
                row=m.identity(child)
                if row: m.signal_owned(row,signal.SIGTERM)
            if parent.poll() is None: parent.terminate(); parent.wait(timeout=3)
            parent.stdout.close()

    def test_interactive_and_indexing_processes_are_ignored_but_escaped_child_is_owned(self):
        ownership={1:False,10:True}
        # Chrome and Spotlight can start during the run; a detached browser
        # helper can also start afterwards with an already-exited parent.
        rows={20:dict(pid=20,version=20,originalParentVersion=1,ppid=1,label="Chrome during"),
              21:dict(pid=21,version=21,originalParentVersion=10,ppid=1),
              22:dict(pid=22,version=22,originalParentVersion=999,ppid=1,label="Chrome after"),
              23:dict(pid=23,version=23,originalParentVersion=1,ppid=1,label="Spotlight during")}
        self.assertEqual(set(m.attributed(rows,ownership)),{21})
        self.assertFalse(ownership[20]); self.assertTrue(ownership[21]); self.assertNotIn(22,ownership)

    def test_cleanup_settles_exiting_children_but_retains_survivors(self):
        row=dict(pid=42,ppid=1,pgid=42,uid=1,start=[10,22])
        with patch.object(m,"processes",side_effect=[{42:row},{},{}]),patch.object(m.time,"sleep"):
            self.assertEqual(m.settle({}),{})
        with patch.object(m,"processes",return_value={42:row}):
            self.assertEqual(m.settle({},timeout=0),{42:row})

    def test_pid_identity_and_reuse(self):
        row=dict(pid=42,ppid=1,pgid=42,uid=1,start=[10,22])
        with patch.object(m,"identity",return_value={**row,"start":[10,23]}),patch.object(m.os,"kill") as kill:
            with self.assertRaises(RuntimeError): m.signal_owned(row,signal.SIGTERM)
            kill.assert_not_called()
        self.assertEqual(m.born({42:row},{42:{**row,"start":[11,1]}}),{42:{**row,"start":[11,1]}})
        with patch.object(m,"identity",side_effect=RuntimeError("unreadable")),patch.object(m.os,"kill") as kill:
            with self.assertRaises(RuntimeError): m.signal_owned(row,signal.SIGTERM)
            kill.assert_not_called()

    def test_partial_upload_cleanup_and_no_replay(self):
        with tempfile.TemporaryDirectory() as temp,patch.object(m,"ROOT",Path(temp)/"runner"),patch.object(m,"disk_gate"):
            data=dict(runId=str(uuid.uuid4()),diskGiB=1,uploads={"source.bundle":"fixture"})
            with contextlib.redirect_stdout(io.StringIO()): m.prepare(data)
            with self.assertRaises(FileExistsError): m.prepare(data)
            run=m.location(data["runId"]); (run/"source.bundle").write_text("partial")
            with patch.object(subprocess,"run",return_value=subprocess.CompletedProcess([],1,"","")),contextlib.redirect_stdout(io.StringIO()): m.clean(data)
            self.assertFalse((run/"source.bundle").exists())
            self.assertTrue(json.loads((run/"clean.json").read_text())["neverLaunched"])

    def test_cleanup_fails_closed_on_open_files_or_missing_receipt(self):
        with tempfile.TemporaryDirectory() as temp,patch.object(m,"ROOT",Path(temp)/"runner"),patch.object(m,"disk_gate"):
            data=dict(runId=str(uuid.uuid4()),diskGiB=1,uploads={})
            with contextlib.redirect_stdout(io.StringIO()): m.prepare(data)
            run=m.location(data["runId"])
            with patch.object(subprocess,"run",return_value=subprocess.CompletedProcess([],0,"p42\n","")):
                with self.assertRaises(RuntimeError): m.clean(data)
            (run/"launched").touch()
            with self.assertRaises(FileNotFoundError): m.clean(data)
            self.assertTrue(run.exists())

    def test_artifact_symlinks_are_not_followed(self):
        with tempfile.TemporaryDirectory() as temp,patch.object(m,"ROOT",Path(temp)/"runner"):
            run=m.location(str(uuid.uuid4())); run.mkdir(); (run/"work").mkdir()
            m.atomic(run/"receipt.json",{})
            outside=Path(temp)/"outside"; outside.write_text("fixture")
            (run/"work"/"artifact").symlink_to(outside)
            with self.assertRaises(RuntimeError): m.collect(dict(runId=run.name,artifacts=["artifact"]))
            self.assertEqual(outside.read_text(),"fixture")

if __name__ == "__main__": unittest.main()
