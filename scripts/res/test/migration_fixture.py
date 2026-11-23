"""Offline migration state tests; process recognition has separate regressions."""
import runpy
import subprocess
import sys
sys.dont_write_bytecode = True
from unittest.mock import patch


check_output=subprocess.check_output


def fixture_processes(command,*args,**kwargs):
    if command==["/bin/ps","-axww","-o","pid=,comm=,args="]: return ""
    return check_output(command,*args,**kwargs)


if __name__=="__main__":
    sys.argv=sys.argv[1:]
    with patch.object(subprocess,"check_output",side_effect=fixture_processes):
        runpy.run_path(sys.argv[0],run_name="__main__")
