"""Owner-only migration of the main mini capability row. Use during registry maintenance."""
import argparse
import hashlib
import os
from pathlib import Path
import re
import shutil
import tempfile

CAPS = {"cmake-native", "xcode-ios-sim-compile", "xcode-ios-device-compile-unsigned",
        "ios-sign", "device:iphone8", "device:iphone11", "device:s21", "user-keychain"}


def migrated(data):
    lines = data.decode().splitlines(keepends=True)
    indices = [i for i,line in enumerate(lines) if line.startswith("heavy-build\t")]
    if len(indices) != 1: raise ValueError("expected one heavy-build row")
    i = indices[0]
    body = lines[i].rstrip("\r\n")
    fields = body.split("\t")
    if len(fields) != 5 or fields[1:4] != ["slot", "open", "-"]: raise ValueError("invalid main row")
    matches = re.findall(r"(?:^|\s)caps=(\S+)", fields[4])
    if len(matches) > 1: raise ValueError("ambiguous caps")
    caps = CAPS | (set(matches[0].split(",")) if matches else set())
    fields[4] = re.sub(r"(?:^|\s)caps=\S+", "", fields[4]) + " caps=" + ",".join(sorted(caps))
    lines[i] = "\t".join(fields) + lines[i][len(body):]
    return "".join(lines).encode()


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("action", choices=["apply", "rollback"])
    p.add_argument("--registry", required=True, type=Path)
    args = p.parse_args()
    path = args.registry
    if path.is_symlink() or not path.is_file(): p.error("expected regular registry")
    backup = path.with_suffix(".pre-place.tsv")
    current = path.read_bytes()
    if args.action == "apply":
        target = migrated(current)
        if target == current: return
        with backup.open("xb") as stream: stream.write(current)
    else:
        target = backup.read_bytes()
        if migrated(target) != current: p.error("registry changed since migration")
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as tmp: tmp.write(target)
    try:
        shutil.copymode(path, tmp.name)
        if path.read_bytes() != current: p.error("registry changed during migration")
        os.replace(tmp.name, path)
    finally: Path(tmp.name).unlink(missing_ok=True)
    print(args.action, hashlib.sha256(target).hexdigest())


if __name__ == "__main__": main()
