#!/usr/bin/env python3
"""Owner-only local lane migration; independent of mini2 registry/config."""
import argparse
import difflib
import os
from pathlib import Path
import re
import sys
sys.dont_write_bytecode = True

sys.path.insert(0,str(Path(__file__).resolve().parent/"res"))
from mini2_control import guard, allocator_switch, refuse_legacy_allocators
sys.path.insert(0,str(Path(__file__).resolve().parent))
from importlib.util import spec_from_file_location,module_from_spec
spec=spec_from_file_location("mini2_migration",Path(__file__).with_name("mini2-host-migrate.py"))
m=module_from_spec(spec); spec.loader.exec_module(m)

SETTINGS={"LOCAL_LOAD_LIMIT":"derived","LOCAL_MIN_AVAILABLE_GIB":"derived","LOCAL_HEAVY_CORES":"derived",
          "LOCAL_HEAVY_GIB":"derived","LOCAL_MEDIUM_CORES":"derived","LOCAL_MEDIUM_GIB":"derived",
          "LOCAL_LIGHT_CORES":"1","LOCAL_LIGHT_GIB":"2","LOCAL_MIN_FREE_GIB":"20",
          "LOCAL_MAX_BYPASS":"3","LOCAL_METRICS_TTL_SECONDS":"5"}


def migrate(content):
    lines=content.decode().splitlines(keepends=True)
    matches=[i for i,line in enumerate(lines) if line.startswith("heavy-build\t")]
    if len(matches)!=1: raise ValueError("local host row missing or duplicate")
    i=matches[0]; row=lines[i].rstrip("\r\n"); fields=row.split("\t")
    if len(fields)!=5 or fields[1]!="slot" or fields[3]!="-": raise ValueError("invalid local host row")
    if "dynamic-local" in fields[4].split(): raise ValueError("local lanes already dynamic")
    fields[4]+=" dynamic-local"
    lines[i]="\t".join(fields)+lines[i][len(row):]
    return "".join(lines).encode()


def configure(content):
    if content and not content.endswith(b"\n"): raise ValueError("machine.conf requires final newline")
    names={line.split(b"=",1)[0].strip().decode() for line in content.splitlines() if b"=" in line and not line.lstrip().startswith(b"#")}
    additions="".join(name+"="+value+"\n" for name,value in SETTINGS.items() if name not in names)
    return content+additions.encode()


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--registry",type=Path,required=True)
    parser.add_argument("--backup",type=Path)
    action=parser.add_mutually_exclusive_group()
    action.add_argument("--apply",action="store_true")
    action.add_argument("--rollback",action="store_true")
    args=parser.parse_args(); file=args.registry.absolute()
    backup=args.backup or file.with_name(file.name+".pre-local-dynamic")
    config=file.parent/"machine.conf"; config_backup=backup.with_name(backup.name+".machine")
    existed=backup.with_name(backup.name+".machine-existed")
    if any(p.is_symlink() for p in (file,backup,config,config_backup,existed)) or backup.absolute()==file: raise ValueError("unsafe migration path")
    # Both migrations serialize registry edits with the mini2 host guard; local
    # claims also hold their own guard. No live capacity resource is taken.
    with allocator_switch(file.parent,"local"),guard(file.parent),guard(file.parent,"local-capacity.guard"):
        current=file.read_bytes(); mode=file.stat().st_mode & 0o777
        config_current=config.read_bytes() if config.exists() else b""
        config_mode=config.stat().st_mode & 0o777 if config.exists() else 0o600
        if args.rollback:
            original,config_original,was_present=m.local_backup_set(backup,config_backup,existed)
            restored=m.restore_row(current,original,migrate(original),"heavy-build")
            is_original=config.exists()==was_present and config_current==config_original
            is_migrated=config.exists() and config_current==configure(config_original)
            if not (is_original or is_migrated): raise ValueError("machine.conf changed since migration; refusing to overwrite")
            if not is_original:
                if was_present: m.atomic(config,config_original,config_mode)
                else: config.unlink(missing_ok=True)
            if current!=restored: m.atomic(file,restored,mode)
            print("Local registry row and machine.conf restored; retain compatible code until leases drain.")
            return
        refuse_legacy_allocators(file.parent,"local")
        proposal=migrate(current); proposed_config=configure(config_current)
        for line in difflib.unified_diff(current.decode().splitlines(keepends=True),proposal.decode().splitlines(keepends=True),fromfile=str(file),tofile=str(file)+" (local dynamic)"):
            print("[MASKED LINE: registry field]" if re.search(r"password|passwd|secret|token|api_?key|credential|auth|key",line,re.I) else line,end="" if line.endswith("\n") else "\n")
        print("Add derived local capacity settings in machine.conf; legacy thresholds remain available for rollback.")
        if not args.apply: return
        if any(p.exists() for p in (backup,config_backup,existed)): raise ValueError("backup exists; refusing overwrite")
        m.exact_backup(backup,current); m.exact_backup(config_backup,config_current); m.exact_backup(existed,b"1" if config.exists() else b"0")
        try:
            m.atomic(config,proposed_config,config_mode); m.atomic(file,proposal,mode)
        except BaseException:
            _,_,was_present=m.local_backup_set(backup,config_backup,existed)
            m.atomic(file,current,mode)
            if was_present: m.atomic(config,config_current,config_mode)
            else: config.unlink(missing_ok=True)
            raise
        print("Applied independent local lane migration; exact backups: "+str(backup))


if __name__=="__main__":
    try: main()
    except (ValueError,OSError) as error:
        print("local migration: "+str(error),file=sys.stderr); sys.exit(2)
