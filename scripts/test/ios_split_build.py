"""Exercise dispatch and return with fixture resources; no Xcode or signing identity needed."""
import importlib.util
import json
import os
from pathlib import Path
import plistlib
import subprocess
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("split", Path(__file__).resolve().parents[1] /
                                              "lib/ios_split_build.py")
split = importlib.util.module_from_spec(spec)
spec.loader.exec_module(split)


class SplitBuild(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name).resolve()
        repo = self.root / "source"
        repo.mkdir()
        subprocess.run(["git", "init", "-q", repo], check=True)
        subprocess.run(["git", "-C", repo, "-c", "user.email=test@localhost", "-c", "user.name=test",
                        "commit", "--allow-empty", "-qm", "fixture"], check=True)
        self.args = SimpleNamespace(repo=repo, project="fixture", task="test", out=self.root/"out",
                                    allowlist=self.root/"list", local_control=False)
        self.args.out.mkdir()
        res = self.root / "res"
        res.write_text('''#!/bin/sh
echo "$@" >> "$JOURNAL"
case "$1" in
wait-build) echo paired ;;
claim-any) echo machine=main; echo build-lane=heavy-lane-1 ;;
return-build|mini2) exit 0 ;;
*) exit 2 ;;
esac
''')
        res.chmod(0o755)
        self.journal = self.root / "calls"
        env = patch.dict(os.environ, RES_COMMAND=str(res), JOURNAL=str(self.journal))
        env.start()
        self.addCleanup(env.stop)
        self.commit = split.capture("git", "-C", repo, "rev-parse", "HEAD")

    def check_return(self):
        calls = self.journal.read_text().splitlines()
        claim, = [s for s in calls if s.startswith("claim-any ")]
        self.assertIn("--need xcode-ios-device-compile-unsigned", claim)
        self.assertNotIn("--pin main", claim)
        self.assertEqual(1, sum(s.startswith("return-build ") for s in calls))

    def test_main_fallback(self):
        host, archive = split.compile_app(self.args, self.commit, "echo product > " + split.ARCHIVE)
        self.assertEqual((host, archive.read_text()), ("main", "product\n"))
        self.check_return()
        self.assertFalse((self.args.repo/split.ARCHIVE).exists())

    def test_failed_build_returns_claim(self):
        with self.assertRaisesRegex(ValueError, "compile failed"):
            split.compile_app(self.args, self.commit, "exit 23")
        self.check_return()

    def test_missing_signer_handoff(self):
        args = SimpleNamespace(unsigned_only=False, entry=None, identity="test", signer_command=None, verify_returned=False)
        build = {"app": "Demo.app", "sha256": "b" * 64}
        with patch.object(split, "sign", side_effect=AssertionError("unexpected signer")):
            self.assertEqual("awaiting-registered-signer", split.finish(args, build)["status"])

    def test_remote_bad_digest(self):
        def transfer(*_):
            remote = self.args.out / "mini2"
            (remote/"artifacts").mkdir(parents=True)
            (remote/"artifacts"/split.ARCHIVE).write_bytes(b"damaged")
            (remote/"summary.json").write_text(json.dumps(dict(clean=True, commit=self.commit,
                artifacts=[dict(path=split.ARCHIVE, sha256="0"*64)])))
        with patch.object(split, "wrapped", transfer), self.assertRaisesRegex(ValueError, "checksum"):
            split.compile_app(self.args, self.commit, "true")

    def signing_fixture(self):
        args = self.args
        app = args.out / "unsigned" / "Demo.app"
        app.mkdir(parents=True)
        args.bundle_id = "test.Demo"
        (app / "Info.plist").write_bytes(plistlib.dumps(dict(CFBundleExecutable="Demo",
            CFBundleIdentifier=args.bundle_id, DTPlatformName="iphoneos")))
        (app / "Demo").write_bytes(b"unsigned test artifact")
        m = split.manifest(args, app)
        manifest = args.out / "manifest.json"
        split.record(manifest, m)
        args.entry, args.identity, args.verify_returned = "demo", "test", False
        args.baseline = args.out / "baseline.json"
        baseline_receipt = self.root / "baseline-receipt.json"
        split.record(baseline_receipt, dict(certificate_sha1="A"*40, team="FIXTURE", result="PASS",
            output=str(app), bundle_sha256=m["bundleSHA256"], profile_uuid="fixture-profile"))
        split.record(args.baseline, {"commit": self.commit, "app": str(app), "receipt": str(baseline_receipt)})
        args.signer_command = args.out / "argv.json"
        build = dict(app=str(app), commit=self.commit, sha256=m["bundleSHA256"])
        entry = dict(input=dict(manifest_path=str(manifest), sha256_bundle="0"*64,
                                sha256_executable=m["preparedExecutableSHA256"]),
                     enabled=True, one_shot=dict(max_uses=1, expires_at="2099-01-01T00:00:00Z"))
        return args, build, entry

    def test_registered_hash_mismatch_never_invokes_signer(self):
        args, build, entry = self.signing_fixture()
        with patch.object(split, "allowed"), patch.object(split, "signature", return_value={
                "bundle": args.bundle_id}), patch.object(split, "wrapped") as signer:
            with self.assertRaisesRegex(ValueError, "registered manifest path or product hashes differ"):
                split.sign(args, build, entry)
            signer.assert_not_called()

    def test_project_signer_invocation_and_receipts(self):
        args, build, entry = self.signing_fixture()
        shared = self.root / "shared"
        receipt = shared / "user-signing/receipts/demo.json"
        receipt.parent.mkdir(parents=True)
        method_receipt = args.out / "signing/signing-receipt.json"
        method_receipt.parent.mkdir()
        signed = args.out / "signed/Demo.app"
        signed.parent.mkdir()
        cert = "A"*40
        entry["input"]["sha256_bundle"] = build["sha256"]
        # A fixture signer copies only our generated text package and fixture receipt.
        signer = self.root / "fixture-signer"
        signer.write_text('#!/bin/sh\nset -eu\ncp -R "$1" "$2"\ncp "$3" "$4"\ncp "$3" "$5"\n')
        signer.chmod(0o755)
        template = self.root / "template.json"
        split.record(template, dict(result="PASS", id=args.entry, output=str(signed),
            input=build["app"], input_executable_sha256=entry["input"]["sha256_executable"],
            profile_uuid="fixture-profile", input_bundle_sha256=build["sha256"], bundle_sha256=build["sha256"],
            certificate_sha1=cert, team="FIXTURE"))
        argv = [build["app"], str(signed), str(template), str(receipt), str(method_receipt)]
        args.signer_command.write_text(json.dumps([str(signer), *argv]))
        fake_verify = self.root / "codesign"
        fake_verify.write_text('#!/bin/sh\necho TeamIdentifier=FIXTURE\n')
        fake_verify.chmod(0o755)
        with patch.object(split, "allowed"), patch.object(split, "SHARED", shared), patch.object(
                split, "signature", return_value=dict(bundle=args.bundle_id, profileSHA256="fixture")
                ), patch.dict(os.environ, PATH=str(self.root) + os.pathsep + os.environ["PATH"]):
            entry["one_shot"]["expires_at"] = "2000-01-01T00:00:00Z"
            with self.assertRaisesRegex(ValueError, "permission is closed"):
                split.sign(args, build, entry)
            entry["one_shot"]["expires_at"] = "2099-01-01T00:00:00Z"
            result = split.sign(args, build, entry)
            with self.assertRaisesRegex(ValueError, "already exists"):
                split.sign(args, build, entry)
            entry["enabled"] = False
            args.verify_returned = True
            self.assertEqual(split.sign(args, build, entry)["status"], "signed-verified")
        self.assertEqual(result["sha256"], build["sha256"])
        self.assertTrue(method_receipt.is_file())
        calls = self.journal.read_text()
        self.assertIn("--need ios-sign", calls)
        self.assertIn("--profile light", calls)
        self.assertIn("--pin main", calls)
        self.assertIn("return-build", calls)

    def test_refuses_unapproved_identity(self):
        with patch.object(split, "read", return_value={"identities": []}), self.assertRaisesRegex(
                ValueError, "not allowlisted"):
            split.sign(SimpleNamespace(identity="unknown"), {}, {})


if __name__ == "__main__":
    unittest.main()
