"""Entrypoints must not leave Python caches in a source checkout."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import unittest

sys.dont_write_bytecode = True


class BytecodeTests(unittest.TestCase):
    def test_scratch_commands_and_migrations_leave_no_bytecode(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = Path(__file__).resolve().parents[2]
            copied = root / "scripts"
            shutil.copytree(source / "res", copied / "res",
                            ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
            for name in ("local-host-migrate.py", "mini2-host-migrate.py"):
                shutil.copy2(source / name, copied / name)
            state = root / "state"
            state.mkdir()
            (state / "resources.tsv").write_text(
                "heavy-build\tslot\topen\t-\tFull build dynamic-local\n")
            (state / "machine.conf").write_text("# scratch\n")
            (state / "sample.json").write_text(json.dumps(dict(
                at=time.time(), host=os.uname().nodename, cores=14, totalGiB=64,
                load5=0, availableGiB=64, pressure=1, freeGiB=1000,
                swapGiB=0, compressorGiB=0)))
            env = {**os.environ, "HOME": str(root / "home"), "RES_DIR": str(state),
                   "RULES_SHARED": str(state), "RES_TEST_LOCAL_SAMPLE": str(state / "sample.json")}
            env.pop("PYTHONDONTWRITEBYTECODE", None)
            res = str(copied / "res/res")
            commands = [[res, "help"], [res, "pool-capacity", "local"],
                        [res, "pool-capacity", "local-light"], [res, "status", "local", "--json"],
                        [sys.executable, str(copied / "local-host-migrate.py"), "--help"],
                        [sys.executable, str(copied / "mini2-host-migrate.py"), "--help"]]
            for command in commands:
                result = subprocess.run(command, env=env, cwd=copied, capture_output=True,
                                        text=True, timeout=15)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(list(copied.rglob("__pycache__")), [], command)
                self.assertEqual(list(copied.rglob("*.pyc")), [], command)


if __name__ == "__main__":
    unittest.main()
