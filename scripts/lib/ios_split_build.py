"""Place an unsigned device build, then dispatch only its registered signing method."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import plistlib
import shlex
import signal
import subprocess
import sys
import tarfile
import tempfile
import time

SCRIPTS = Path(__file__).resolve().parents[1]
SHARED = Path.home() / ".claude/orchestrator/_shared"
ARCHIVE = ".ios-split-product.tar"
FLAGS = ["CODE_SIGNING_ALLOWED=NO", "CODE_SIGNING_REQUIRED=NO", "CODE_SIGN_IDENTITY="]


def require(ok, message):
    if not ok:
        raise ValueError(message)


def read(path):
    return json.loads(Path(path).read_bytes())


def record(path, data):
    with path.open("x") as file:
        json.dump(data, file, indent=2)


def digest(path):
    result = hashlib.sha256()
    with path.open("rb") as file:
        for block in iter(lambda: file.read(1024 * 1024), b""):
            result.update(block)
    return result.hexdigest()


def capture(*args):
    return subprocess.check_output(args, stderr=subprocess.DEVNULL).decode().strip()


def relative(value):
    p = Path(value)
    require(not p.is_absolute() and value == p.as_posix() and ".." not in p.parts and p.parts,
            "expected a relative checkout path")
    return p


def arguments():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("project", "task", "repo", "ref", "allowlist", "product", "identity",
                 "bundle-id", "out"):
        parser.add_argument("--" + name, required=True)
    parser.add_argument("--entry", help="owner-registered iOS package ID")
    parser.add_argument("--signer-command", type=Path, help="JSON argv of the approved project signer")
    group = parser.add_mutually_exclusive_group(required=True)
    for name in ("workspace", "xcode-project", "command"):
        group.add_argument("--" + name)
    parser.add_argument("--scheme")
    parser.add_argument("--configuration", default="Debug")
    parser.add_argument("--local-control", action="store_true", help="pin main for a same-ref timing control")
    parser.add_argument("--baseline", help="owner-attested JSON with commit and local signed app path")
    mode = parser.add_mutually_exclusive_group()
    for name in ("dry-run", "unsigned-only", "resume-sign", "verify-returned"):
        mode.add_argument("--" + name, action="store_true")
    args = parser.parse_args()
    require(args.configuration.lower() != "release", "only own development test packages")
    require(not args.local_control or args.unsigned_only, "--local-control requires --unsigned-only")
    require(args.command or args.scheme, "supply the workspace/project scheme")
    args.product = relative(args.product)
    require(args.product.suffix in (".app", ".xcarchive"), "expected .app or .xcarchive")
    args.repo = Path(args.repo).resolve(strict=True)
    args.allowlist = Path(args.allowlist).resolve(strict=True)
    args.out = Path(args.out).resolve()
    require(not args.out.is_relative_to(args.repo), "output must be outside the source repo")
    return args


def command(args):
    if args.command:
        # An explicit project command must honor the exported signing overrides.
        build = args.command
    else:
        selector = ["-workspace", str(relative(args.workspace))] if args.workspace else [
            "-project", str(relative(args.xcode_project))]
        archive = args.product.suffix == ".xcarchive"
        action = ["archive", "-archivePath", str(args.product)] if archive else ["build"]
        products = '' if archive else ' CONFIGURATION_BUILD_DIR="$PWD/split-products"'
        build = shlex.join(["xcodebuild", *selector, "-scheme", args.scheme, "-configuration",
                            args.configuration, "-sdk", "iphoneos", "-destination",
                            "generic/platform=iOS", *FLAGS, "-disableAutomaticPackageResolution",
                            "-skipPackageUpdates", *action]) + products
    version = capture("xcrun", "xcodebuild", "-version")
    sdk = capture("xcrun", "--sdk", "iphoneos", "--show-sdk-version")
    # Both probes use xcrun for metadata. Compilation uses the runner's PATH wrapper.
    cmd = f'''set -eu
test "$(xcrun xcodebuild -version)" = {shlex.quote(version)}
test "$(xcrun --sdk iphoneos --show-sdk-version)" = {shlex.quote(sdk)}
export COCOA_PODS_ENV=development {shlex.join(FLAGS)}
{build}
'''
    product = shlex.quote(str(args.product))
    # Block the upload before tar opens any signing material, links or special files.
    cmd += f'''p={product}
test -d "$p"
test "$(cd "$p" && pwd -P)" = "$(pwd -P)/$p"
invalid=$(find "$p" \\( ! -type f ! -type d -o -iname '*.mobileprovision' -o -iname '*.p12' -o -iname '*.pem' -o -iname '*.key' -o -name _CodeSignature \\) -print -quit)
test -z "$invalid"
test ! -e {ARCHIVE}
COPYFILE_DISABLE=1 tar -cf {ARCHIVE} -C "$(dirname "$p")" "$(basename "$p")"
'''
    return cmd


def wrapped(args, env, argv, phase):
    # The wrapper owns the claim and its process group, including signal cleanup.
    child = subprocess.Popen([SCRIPTS / "heavy-build.sh", "--watch-pid", str(os.getpid()),
                              "--", *argv], cwd=args.out, env=env)
    try:
        require(child.wait() == 0, phase + " failed; see the phase log in " + str(args.out))
    finally:
        if child.poll() is None:
            child.terminate()
        child.wait()


def environment(args, need, profile):
    env = {k: v for k, v in os.environ.items() if not k.startswith("HEAVY_BUILD_")}
    env.update(HEAVY_BUILD_PLACE="auto", HEAVY_BUILD_NEED=need, HEAVY_BUILD_PROFILE=profile,
               HEAVY_BUILD_TASK=args.task, HEAVY_BUILD_PROJECT=args.project,
               HEAVY_BUILD_BY=f"ios-split-{os.getpid()}-{profile}")
    return env


def compile_app(args, commit, cmd):
    remote = args.out / "mini2"
    archive = args.out / ARCHIVE
    env = environment(args, "xcode-ios-device-compile-unsigned", "heavy")
    env.update(HEAVY_BUILD_MINI2_REPO=str(args.repo), HEAVY_BUILD_MINI2_REF=commit,
               HEAVY_BUILD_MINI2_ALLOWLIST=str(args.allowlist), HEAVY_BUILD_MINI2_COMMAND=cmd,
               HEAVY_BUILD_MINI2_ARTIFACT=ARCHIVE, HEAVY_BUILD_MINI2_OUT=str(remote),
               HEAVY_BUILD_LOG=str(args.out / "build.log"), HEAVY_BUILD_MINI2_TIMEOUT="120")
    # Only the selected main branch creates a checkout or invokes a compiler here.
    if args.local_control:
        env = {k: v for k, v in env.items() if not k.startswith("HEAVY_BUILD_MINI2_")}
    with tempfile.TemporaryDirectory(dir=args.out) as scratch:
        local = '''set -eu
git clone -q --no-checkout --local -- "$1" "$2/src"
cd "$2/src"
git -c advice.detachedHead=false checkout -q --detach "$3"
mkdir "$2/bin"
printf '%s\\n' '#!/bin/sh' 'exec /usr/bin/xcodebuild "$@" -derivedDataPath "$SPLIT_DD"' > "$2/bin/xcodebuild"
chmod +x "$2/bin/xcodebuild"
export SPLIT_DD="$2/DerivedData" PATH="$2/bin:$PATH"
bash -ec "$4"
mv .ios-split-product.tar "$5"
'''
        wrapped(args, env, ["bash", "-c", local, "local", str(args.repo), scratch, commit,
                            cmd, str(archive)], "unsigned compile")
    if remote.exists():
        summary = read(remote / "summary.json")
        require(summary["clean"] and summary["commit"] == commit, "remote receipt mismatch")
        artifact, = summary["artifacts"]
        require(artifact["path"] == ARCHIVE, "remote product mismatch")
        archive = remote / "artifacts" / ARCHIVE
        require(digest(archive) == artifact["sha256"], "returned checksum mismatch")
        return "mini2", archive
    return "main", archive


def unpack(archive, args):
    target = args.out / "unsigned"
    target.mkdir()
    with tarfile.open(archive) as tar:
        for member in tar:
            name = relative(member.name.rstrip("/"))
            require(name.parts[0] == args.product.name and (member.isdir() or member.isreg()),
                    "invalid product archive")
        tar.extractall(target, filter="data")
    app = target / args.product.name
    if app.suffix == ".xcarchive":
        app, = (app / "Products/Applications").glob("*.app")
    require(not any(app.rglob("*.appex")) and not any(app.rglob("*.app")),
            "nested app/extension needs a separate signing plan")
    return app


def info(app):
    with (app / "Info.plist").open("rb") as file:
        value = plistlib.load(file)
    exe = value["CFBundleExecutable"]
    require(str(relative(exe)) == Path(exe).name, "invalid executable name")
    require(value.get("DTPlatformName") == "iphoneos", "expected iPhoneOS product")
    return value, app / exe


def bundle_files(app, sealed_profile=None):
    rows = []
    require(app.resolve() == app, "unsigned app path changed")
    for root, dirs, files in os.walk(app):
        require(all(not (Path(root)/name).is_symlink() for name in dirs + files),
                "links in unsigned product are unsupported")
        # Registered manifests traverse sorted directory entries depth-first.
        for name in files:
            file = Path(root) / name
            name = str(file.relative_to(app))
            if file.suffix.lower() == ".mobileprovision":
                require(name == "embedded.mobileprovision" and sealed_profile,
                        "unexpected provisioning file in product")
                sha = sealed_profile
            else:
                sha = digest(file)
            rows.append({"path": name, "sha256": sha})
    rows.sort(key=lambda row: Path(row["path"]).parts)
    tree = hashlib.sha256(json.dumps(rows, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()
    return rows, tree


def manifest(args, app):
    value, exe = info(app)
    require(value["CFBundleIdentifier"] == args.bundle_id, "unsigned bundle ID mismatch")
    rows, tree = bundle_files(app)
    return dict(task=args.task, path=str(app), bundleId=args.bundle_id, files=rows,
                bundleSHA256=tree, preparedExecutableSHA256=digest(exe))


def verified_manifest(args, build):
    app = Path(build["app"])
    prepared = manifest(args, app)
    require(prepared == read(args.out / "manifest.json") and prepared["bundleSHA256"] == build["sha256"],
            "unsigned artifact changed after build")
    return prepared


def allowed(identity):
    identities = read(SHARED / "user-signing/identities.json")["identities"]
    require(any(row["id"] == identity and row.get("approved") and row.get("platform") == "ios"
                for row in identities), "signing identity is not allowlisted")


def signature(app):
    subprocess.run(["codesign", "--verify", "--deep", "--strict", app], check=True)
    value, exe = info(app)
    ent = plistlib.loads(subprocess.check_output(
        ["codesign", "-d", "--entitlements", "-", "--xml", app], stderr=subprocess.DEVNULL))
    # The verified resource seal contains the embedded profile's digest.
    with (app / "_CodeSignature/CodeResources").open("rb") as file:
        profile = plistlib.load(file)["files2"]["embedded.mobileprovision"]["hash2"].hex()
    return dict(profileSHA256=profile, entitlementsSHA256=hashlib.sha256(
        plistlib.dumps(ent, sort_keys=True)).hexdigest(), architectures=sorted(capture(
            "lipo", "-archs", exe).split()), entitlementNames=sorted(ent), bundle=value["CFBundleIdentifier"],
        version=value["CFBundleVersion"], marketingVersion=value.get("CFBundleShortVersionString"))


def sign(args, build, entry):
    allowed(args.identity)
    base = read(args.baseline)
    require(base["commit"] == build["commit"], "baseline must attest the same source commit")
    expected = signature(Path(base["app"]))
    require(expected["bundle"] == args.bundle_id, "baseline bundle mismatch")
    app = Path(build["app"])
    method = entry["method"]
    signed = Path(entry["output"]["path"])
    require(entry["input"]["path"] == str(app) and entry["output"]["bundle_id"] == args.bundle_id
            and signed.resolve() == args.out / "signed" / app.name,
            "registered input, fresh output or bundle mismatch")
    prepared = verified_manifest(args, build)
    source = entry["input"]["hash_source"]
    registered = read(source["path"])
    require(registered[source["additional_path_field"]] == str(app)
            and registered[source["additional_sha256_field"]] == prepared["bundleSHA256"]
            and registered[source["sha256_field"]] == prepared["preparedExecutableSHA256"],
            "registered manifest mismatch")
    argv = [method["script"], *method["argv"]]
    if not args.verify_returned:
        require(read(args.signer_command) == argv, "command differs from registered signer")
    # The live entry must pin the product independently of our newly written manifest.
    pins = [argv[i+1] for i in range(len(argv)-1) if argv[i] == "--bundle-sha256"]
    pinned = entry["input"].get("bundle_sha256") or (pins[0] if len(pins) == 1 else None)
    require(pinned == prepared["bundleSHA256"], "owner must pin the full unsigned bundle hash")
    receipt = SHARED / "user-signing/receipts" / (args.entry + ".json")
    require(Path(entry["receipt"]) == receipt, "shared receipt path mismatch")
    signed_sec = None
    if not args.verify_returned:
        require(not signed.exists() and not receipt.exists() and not Path(entry["method_receipt"]).exists(),
                "signing requires fresh output and receipt paths")
        env = environment(args, "ios-sign", "light")
        env["HEAVY_BUILD_LOG"] = str(args.out / "sign.log")
        started = time.monotonic()
        wrapped(args, env, argv, "registered signing")
        signed_sec = time.monotonic() - started
    check = time.monotonic()
    result = read(receipt)
    require(result["result"] == "PASS" and result["input_bundle_sha256"] == prepared["bundleSHA256"]
            and result["output"] == str(signed) and result["id"] == args.entry
            and result["certificate_sha1"] == entry["expected_certificate"]["sha1"]
            and result["team"] == entry["expected_certificate"]["team"], "signing receipt mismatch")
    certificate = entry["expected_certificate"]["sha1"]
    require(len(certificate) == 40 and all(c in "0123456789abcdefABCDEF" for c in certificate),
            "invalid registered certificate SHA-1")
    subprocess.run(["codesign", "--verify", "--strict", "-R",
                    f'=certificate leaf = H"{certificate}"', signed], check=True)
    display = subprocess.check_output(["codesign", "-dv", "--verbose=4", signed],
                                      stderr=subprocess.STDOUT).decode().splitlines()
    require("TeamIdentifier=" + entry["expected_certificate"]["team"] in display, "signed team mismatch")
    actual = signature(signed)
    require(expected == actual, "signed bundle differs from local baseline")
    _, signed_hash = bundle_files(signed, actual["profileSHA256"])
    require(signed_hash == result["bundle_sha256"], "signed bundle differs from its receipt")
    return dict(artifact=str(signed), sha256=result["bundle_sha256"], signSec=signed_sec,
                verifySec=time.monotonic()-check, verified=actual)


def finish(args, build):
    if args.unsigned_only:
        return {**build, "status": "unsigned-verified"}
    registration = SHARED / "user-signing/registry.json"
    rows = read(registration)["entries"] if args.entry and registration.is_file() else []
    entries = [row for row in rows if row["id"] == args.entry and row["enabled"]
               and row["kind"] == "ios-app" and row.get("identity_id") == args.identity]
    if not entries or not (args.signer_command or args.verify_returned):
        print("Unsigned product returned and verified. The project orchestrator must register "
              f"{build['app']} with bundle SHA-256 {build['sha256']} and supply --entry and "
              "--signer-command for that enabled entry.")
        return {**build, "status": "awaiting-registered-signer"}
    require(len(entries) == 1 and args.baseline, "unique registration and --baseline required")
    result = {**build, **sign(args, build, entries[0])}
    record(args.out / "verification.json", result)
    return result


def main():
    args = arguments()
    commit = capture("git", "-C", args.repo, "rev-parse", "--verify", "--end-of-options",
                     args.ref + "^{commit}")
    allowed(args.identity)
    # Apply the same exact-path/history gate to the main fallback.
    gate = """
import fs from 'node:fs'; import {execFileSync} from 'node:child_process';
const [module, repo, commit, file] = process.argv.slice(1);
const {checkAllowlist} = await import(module);
const git = args => execFileSync('git', ['-C',repo,...args], {encoding:'utf8',maxBuffer:128*1024*1024});
const rows = git(['ls-tree','-rz',commit]).split('\\0').filter(Boolean).map(row =>
  ({mode:row.slice(0,6),name:row.slice(row.indexOf('\\t')+1)}));
const history = git(['log','--format=','--name-only','--no-renames','-z',commit])
  .split('\\0').map(name=>name.replace(/^\\n+/, '')).filter(Boolean);
checkAllowlist(JSON.parse(fs.readFileSync(file)),rows,history);
"""
    subprocess.run(["node", "--input-type=module", "-e", gate,
                    (SCRIPTS / "lib/mini2-source.mjs").as_uri(), args.repo, commit,
                    args.allowlist], check=True)
    cmd = command(args)
    if args.dry_run:
        print(f"claim-any unsigned {commit} -> checksum -> main light ios-sign {args.entry} -> compare baseline\n{cmd}")
        return
    if args.resume_sign or args.verify_returned:
        build = read(args.out / "build.json")
        require(build["commit"] == commit and build["project"] == args.project
                and build["task"] == args.task and Path(build["app"]).resolve().is_relative_to(
                    args.out / "unsigned"), "resume source or task mismatch")
        verified_manifest(args, build)
    else:
        args.out.mkdir(parents=True, exist_ok=False)
        started = time.monotonic()
        machine, archive = compile_app(args, commit, cmd)
        compile_sec = time.monotonic() - started
        check = time.monotonic()
        app = unpack(archive, args)
        state = subprocess.run(["codesign", "-d", app], capture_output=True, env={**os.environ, "LC_ALL": "C"})
        require(state.returncode != 0 and b"not signed at all" in state.stderr,
                "expected an unsigned iPhoneOS app")
        prepared = manifest(args, app)
        record(args.out / "manifest.json", prepared)
        timings = {}
        if machine == "mini2":
            summary = read(args.out / "mini2/summary.json")
            timings = {"uploadSec": summary["syncSec"], "remoteBuildSec": summary["receipt"]["wallSec"]}
        build = dict(**timings, machine=machine, commit=commit, project=args.project, task=args.task,
                     app=str(app), sha256=prepared["bundleSHA256"], transportSHA256=digest(archive),
                     compileAndTransferSec=compile_sec, unpackAndHashSec=time.monotonic()-check)
        record(args.out / "build.json", build)
    result = finish(args, build)
    print("IOS_SPLIT_RESULT " + json.dumps(result, separators=(",", ":")))


if __name__ == "__main__":
    for sig in (signal.SIGTERM, signal.SIGHUP):
        signal.signal(sig, lambda *_: sys.exit(143))
    try:
        main()
    except (ValueError, KeyError, OSError, subprocess.SubprocessError) as error:
        sys.exit(f"ios-split-build: {error}")
