"""Exercise dispatch and return with fixture resources; no Xcode or signing identity needed."""
import importlib.util
import json
import os
from pathlib import Path
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
        self.root = Path(temp.name)
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

    def test_remote_bad_digest(self):
        def transfer(*_):
            remote = self.args.out / "mini2"
            (remote/"artifacts").mkdir(parents=True)
            (remote/"artifacts"/split.ARCHIVE).write_bytes(b"damaged")
            (remote/"summary.json").write_text(json.dumps(dict(clean=True, commit=self.commit,
                artifacts=[dict(path=split.ARCHIVE, sha256="0"*64)])))
        with patch.object(split, "wrapped", transfer), self.assertRaisesRegex(ValueError, "checksum"):
            split.compile_app(self.args, self.commit, "true")

    def test_refuses_unapproved_identity(self):
        with patch.object(split, "read", return_value={"identities": []}), self.assertRaisesRegex(
                ValueError, "not allowlisted"):
            split.sign(SimpleNamespace(identity="unknown"), {})


if __name__ == "__main__":
    unittest.main()
