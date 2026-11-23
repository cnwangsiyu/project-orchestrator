#!/usr/bin/env python3
"""Owner-only atomic mini2 registry migration; default prints a proposal."""
import argparse
import difflib
import json
import os
from pathlib import Path
import re
import sys
import uuid

sys.path.insert(0,str(Path(__file__).resolve().parent/"res"))
from mini2_control import HOST, SLOT, guard


def migrate(content):
    lines = content.decode("utf-8").splitlines(keepends=True)
    matches = [i for i,line in enumerate(lines) if line.startswith(SLOT+"\t")]
    if len(matches)!=1: raise ValueError("mini2 row missing or duplicate")
    i = matches[0]
    row = lines[i].rstrip("\r\n")
    fields = row.split("\t")
    if len(fields)!=5 or fields[1]!="remote" or fields[3]!="-" or "bytedance@"+HOST not in fields[4]:
        raise ValueError("invalid mini2 row")
    if "dynamic-host" in fields[4].split(): raise ValueError("mini2 already dynamic")
    fields[4] = re.sub(r"\s+slots=1(?=\s|$)","",fields[4])+" dynamic-host"
    lines[i] = "\t".join(fields)+lines[i][len(row):]
    return "".join(lines).encode("utf-8")


def atomic(file,content,mode):
    temp=file.with_name(file.name+".mini2-"+str(uuid.uuid4()))
    try:
        with temp.open("xb") as stream:
            stream.write(content); stream.flush(); os.fsync(stream.fileno())
        temp.chmod(mode)
        os.replace(temp,file)
    finally:
        temp.unlink(missing_ok=True)


def derived_config(content):
    value=json.loads(content)
    if value.get("load5Limit")==6: value["load5Limit"]="derived"
    if value.get("minAvailableGiB")==16: value["minAvailableGiB"]="derived"
    return json.dumps(value).encode()


def exact_backup(file,content):
    with file.open("xb") as stream:
        os.fchmod(stream.fileno(),0o600)
        stream.write(content); stream.flush(); os.fsync(stream.fileno())


def restore_row(current,original,expected,id):
    def row(content):
        rows=[line for line in content.splitlines(keepends=True) if line.startswith((id+"\t").encode())]
        if len(rows)!=1: raise ValueError("missing or duplicate target registry row")
        return rows[0]
    old,target,now=row(original),row(expected),row(current)
    if now!=target: raise ValueError("target registry row changed since migration; refusing to overwrite")
    return b"".join(old if line==now else line for line in current.splitlines(keepends=True))


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--registry",required=True,type=Path)
    parser.add_argument("--backup",type=Path)
    actions=parser.add_mutually_exclusive_group()
    actions.add_argument("--apply",action="store_true")
    actions.add_argument("--rollback",action="store_true")
    args=parser.parse_args()
    file=args.registry.absolute()
    backup=args.backup or file.with_name(file.name+".pre-mini2-dynamic")
    if file.is_symlink() or backup.is_symlink() or file==backup.absolute(): raise ValueError("unsafe registry or backup")
    with guard(file.parent):
        current=file.read_bytes(); mode=file.stat().st_mode & 0o777
        config=file.parent/"mini2-config.json"
        config_backup=backup.with_name(backup.name+".config")
        if config.is_symlink() or config_backup.is_symlink(): raise ValueError("unsafe config or backup")
        config_current=config.read_bytes()
        config_mode=config.stat().st_mode & 0o777
        if args.rollback:
            original=backup.read_bytes()
            restored=restore_row(current,original,migrate(original),SLOT)
            config_original=config_backup.read_bytes()
            if config_current!=derived_config(config_original): raise ValueError("config changed since migration; refusing to overwrite")
            atomic(file,restored,mode)
            atomic(config,config_original,config_mode)
            print("Exact registry restored; keep compatible code until all mini2 leases return.")
            return
        proposal=migrate(current)
        for line in difflib.unified_diff(current.decode().splitlines(keepends=True),proposal.decode().splitlines(keepends=True),fromfile=str(file),tofile=str(file)+" (dynamic)"):
            if re.search(r"password|passwd|secret|token|api_?key|credential|auth|key",line,re.I):
                print("[MASKED LINE: registry field]")
            else: print(line,end="")
        if not args.apply: return
        if backup.exists() or config_backup.exists(): raise ValueError("backup exists; refusing to overwrite")
        config_proposal=derived_config(config_current)
        exact_backup(backup,current)
        exact_backup(config_backup,config_current)
        try:
            atomic(config,config_proposal,config_mode)
            atomic(file,proposal,mode)
        except BaseException:
            atomic(file,current,mode)
            atomic(config,config_current,config_mode)
            raise
        print("Applied; backup preserved at "+str(backup))


if __name__=="__main__":
    try: main()
    except (ValueError,OSError) as error:
        print("mini2 migration: "+str(error),file=sys.stderr); sys.exit(2)
