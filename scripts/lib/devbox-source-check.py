"""Check npm configuration history and pending uploads. Emit only path/key diagnostics."""
import json
import os
import re
import subprocess
import sys

repo, commit, mode = sys.argv[1:]
os.chdir(repo)


def git(*args):
    return subprocess.check_output(["git", *args], stderr=subprocess.DEVNULL)


assignment = re.compile(rb"""^\s*(?:export\s+)?(?:[^\s=]*:)?["']?(_authToken|_auth|_password)["']?\s*[:=]\s*(.+?)\s*$""", re.I)
# Environment expansions in npm config are upper-case by convention; a JS template like `${token}` is not one.
expansion = re.compile(rb"\$\{([A-Z_][A-Z_0-9]*TOKEN[A-Z_0-9]*|TOKEN)\}")
NPM_CONFIG = {b".npmrc", b".yarnrc", b".yarnrc.yml"}


def npm_config(path):
    return os.path.basename(path).lower() in NPM_CONFIG


def check(stream, path):
    for line in stream:
        if line.lstrip().startswith((b"#", b";")):
            continue
        match = assignment.search(line)
        if match and match[2].strip() in (b"", b"''", b'""'):
            match = None
        match = match or expansion.search(line)
        if match:
            print(json.dumps([os.fsdecode(path), match[1].decode("ascii")]))
            sys.exit(1)


def check_blob(oid, path):
    with subprocess.Popen(["git", "cat-file", "blob", oid], stdout=subprocess.PIPE,
                          stderr=subprocess.DEVNULL) as child:
        try:
            check(child.stdout, path)
        finally:
            child.stdout.close()
        if child.wait():
            raise RuntimeError("blob unavailable")


# Full parent diffs include additions in merge commits and later-deleted versions.
def changes(args):
    records = git(*args).split(b"\0")
    for index in range(0, len(records) - 1, 2):
        header, path = records[index:index+2]
        _, new_mode, _, oid, _ = header.strip().split()
        if new_mode.startswith(b"100"):
            yield oid, path
        elif new_mode == b"120000" and os.path.basename(path).lower() == b".npmrc":
            sys.exit("symlinked npm configuration refused")


seen = set()
for oid, path in changes(["log", "--full-history", "-m", "--root", "--format=", "--raw", "-z",
                          "--no-renames", "--no-abbrev", commit, "--", ":(glob,icase)**/.npmrc"]):
    if oid not in seen:
        check_blob(oid, path)
        seen.add(oid)

if mode == "worktree":
    for oid, path in changes(["diff", "--cached", "--raw", "-z", "--no-renames", "--no-abbrev", "HEAD"]):
        if npm_config(path):
            check_blob(oid, path)
    changed = git("diff", "--name-only", "--no-renames", "-z", "HEAD").split(b"\0")
    extra = git("ls-files", "--others", "--exclude-standard", "-z").split(b"\0")
    for path in set(changed + extra) - {b""}:
        if os.path.islink(path) and os.path.basename(path).lower() == b".npmrc":
            sys.exit("symlinked npm configuration refused")
        if npm_config(path) and not os.path.islink(path) and os.path.isfile(path):
            with open(path, "rb") as stream:
                check(stream, path)
