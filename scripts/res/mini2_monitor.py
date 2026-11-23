"""User launchd monitor; two failures close admission, two successes recover."""
import argparse
import json
import os
from pathlib import Path
import plistlib
import subprocess
import sys
sys.dont_write_bytecode = True
import time

from mini2_control import root_dir, config, guard, read, atomic, observe
from mini2_link import observation


def deliver(root):
    with guard(root):
        cfg = config(root)
        state = read(root/"mini2-link.json", {})
        if cfg["maintenance"]: return
        while state.get("outbox"):
            row = state["outbox"][0]
            try:
                node = Path.home()/".nvm/versions/node/v22.17.0/bin/node"
                result = subprocess.run([str(node), str(Path(__file__).resolve().parents[1]/"mini2-alert.mjs"),
                    cfg["owner"], row["id"], row["tag"], row["reason"], str(row["at"])],
                    env={**os.environ, "RULES_SHARED":str(root)}, capture_output=True, timeout=15, check=True)
                if not json.loads(result.stdout).get("delivered"): raise ValueError("not delivered")
            except (OSError, ValueError, subprocess.SubprocessError):
                state["alert"]="FAILED"; atomic(root/"mini2-link.json",state); return
            state["outbox"].pop(0)
            state["alert"]="DELIVERED"
            atomic(root/"mini2-link.json",state)


def once(root):
    with guard(root): cfg = config(root)
    sample = observation("maintenance" if cfg["maintenance"] else "probe")
    # A maintenance transition during the probe must discard in-flight evidence.
    with guard(root):
        if config(root)["generation"] != cfg["generation"]:
            return {"link":"UNKNOWN", "reason":"config-changed"}
    result = observe(root, sample, generation=cfg["generation"])
    deliver(root)
    facts=read(root/"mini2-facts.json",{})
    if result.get("link") == "UP" and not result.get("maintenance") and not 0 <= time.time()-facts.get("at",0) < 3600:
        node=Path.home()/".nvm/versions/node/v22.17.0/bin/node"
        runner=Path(__file__).resolve().parents[1]/"mini2-run.mjs"
        refresh='const m=await import(process.argv[1]); await m.refresh({observeLink:false});'
        checked=subprocess.run([str(node),"--input-type=module","-e",refresh,runner.as_uri()],
                               env={**os.environ,"RES_DIR":str(root)},capture_output=True,timeout=60)
        if checked.returncode: result["factsRefresh"]="FAILED"
    return result


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--once", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--install", action="store_true")
    args=parser.parse_args()
    root=root_dir()
    if args.dry_run:
        import tempfile
        with tempfile.TemporaryDirectory(prefix="mini2-alarm-dry-") as temp:
            scratch=Path(temp)
            for i,link in enumerate(("UNKNOWN", "UNKNOWN", "UNKNOWN", "UP", "UP", "UP")):
                value=observe(scratch, {"link":link,"reason":"dry-run"},now=time.time()+i*300)
            print(json.dumps(dict(tags=[x["tag"] for x in value["outbox"]], maintenance=value["maintenance"], delivered=False)))
    elif args.install:
        target=Path.home()/"Library/LaunchAgents/com.bytedance.orchestrator.mini2-link.plist"
        if target.exists(): raise ValueError("mini2 launch agent already exists")
        target.parent.mkdir(parents=True,exist_ok=True)
        payload=dict(Label="com.bytedance.orchestrator.mini2-link",
                     ProgramArguments=[sys.executable,"-B",str(Path(__file__).resolve()),"--once"],
                     EnvironmentVariables={"RES_DIR":str(root)}, StartInterval=300, RunAtLoad=True,
                     StandardOutPath=str(root/"mini2-monitor.log"), StandardErrorPath=str(root/"mini2-monitor-error.log"))
        with target.open("xb") as stream: plistlib.dump(payload,stream)
        subprocess.run(["/bin/launchctl","bootstrap","gui/"+str(os.getuid()),str(target)],check=True)
        print(str(target))
    else:
        print(json.dumps(once(root)))


if __name__ == "__main__": main()
