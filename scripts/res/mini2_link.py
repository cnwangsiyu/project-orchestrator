"""Read-only link observation for the main mini. No scheduler state or leases."""
import argparse
import datetime
import ipaddress
import json
import socket
import subprocess
import sys
from pathlib import Path


HOST = "Bytedances-Mac-mini.local"
INTERFACE = "en12"


class LinkFailure(Exception):
    def __init__(self, reason, link="UNKNOWN"):
        super().__init__(reason)
        self.link = link


def resolve():
    try:
        index = socket.if_nametoindex(INTERFACE)
        info = subprocess.run(["/sbin/ifconfig", INTERFACE], capture_output=True,
                              text=True, timeout=3, check=True)
    except (OSError, subprocess.SubprocessError) as error:
        raise LinkFailure("interface-unavailable") from error
    lines = {line.strip() for line in info.stdout.splitlines()}
    if "status: inactive" in lines:
        raise LinkFailure("interface-inactive", "DOWN")
    if "status: active" not in lines:
        raise LinkFailure("interface-status-unknown")

    try:
        answers = socket.getaddrinfo(HOST, 22, socket.AF_INET6, socket.SOCK_STREAM)
        addresses = set()
        for family, _, _, _, addr in answers:
            if family != socket.AF_INET6 or addr[3] != index:
                continue
            literal, _, zone = addr[0].partition("%")
            if zone and zone not in (INTERFACE, str(index)):
                continue
            ip = ipaddress.IPv6Address(literal)
            if ip.is_link_local:
                addresses.add(str(ip))
    except (OSError, ValueError) as error:
        raise LinkFailure("resolution-failed") from error
    if len(addresses) != 1:
        raise LinkFailure("ambiguous-answer" if addresses else "no-cable-answer")
    address = addresses.pop() + "%" + INTERFACE
    try:
        route = subprocess.run(["/sbin/route", "-n", "get", "-inet6", address],
                               capture_output=True, text=True, timeout=3, check=True)
        if "interface: " + INTERFACE not in {line.strip() for line in route.stdout.splitlines()}:
            raise LinkFailure("wrong-cable-route")
    except (OSError, subprocess.SubprocessError) as error:
        raise LinkFailure("route-unavailable") from error
    return address


def observation(mode):
    if mode != "probe":
        return {"link": mode.upper()}
    # Bound libc name resolution in a disposable process, including ifconfig.
    try:
        child = subprocess.run([sys.executable, str(Path(__file__).resolve()), "--resolve-en12"],
                               capture_output=True, text=True, timeout=8, check=True)
        result = json.loads(child.stdout)
    except subprocess.TimeoutExpired:
        return {"link": "UNKNOWN", "reason": "resolution-timeout"}
    except (OSError, ValueError, subprocess.SubprocessError):
        return {"link": "UNKNOWN", "reason": "resolver-failed"}
    if result["link"] != "RESOLVED":
        return result

    address = result["address"]
    args = ["/usr/bin/ssh", "-6", "-nTax", "-oBatchMode=yes", "-oConnectTimeout=10",
            "-oConnectionAttempts=1", "-oStrictHostKeyChecking=yes", "-oUpdateHostKeys=no",
            "-oHostKeyAlias=" + HOST, "-oHostname=" + address.replace("%", "%%"), "-oControlPath=none",
            "-oProxyCommand=none", "-oProxyJump=none", "-oClearAllForwardings=yes",
            "-oPermitLocalCommand=no", "bytedance@" + HOST,
            'test "$(hostname)" = Bytedances-Mac-mini.local && true && printf "mini2-link-ok\\n"']
    try:
        ssh = subprocess.run(args, capture_output=True, timeout=12)
    except subprocess.TimeoutExpired:
        return dict(link="UNKNOWN", address=address, reason="ssh-timeout")
    except OSError:
        return dict(link="UNKNOWN", address=address, reason="ssh-unavailable")
    if ssh.returncode or ssh.stdout != b"mini2-link-ok\n":
        reason = "ssh-failed"
        if any(msg in ssh.stderr.lower() for msg in (b"host key verification failed",
                                                      b"remote host identification has changed")):
            reason = "identity-check-failed"
        return dict(link="UNKNOWN", address=address, reason=reason)
    return dict(link="UP", address=address)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument("--probe", dest="mode", action="store_const", const="probe")
    modes.add_argument("--maintenance", dest="mode", action="store_const", const="maintenance")
    modes.add_argument("--resolve-en12", dest="mode", action="store_const", const="resolve",
                       help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.mode == "resolve":
        try:
            result = {"link": "RESOLVED", "address": resolve()}
        except LinkFailure as error:
            result = {"link": error.link, "reason": str(error)}
        print(json.dumps(result))
        return 0
    result = observation(args.mode or "disabled")
    result.update(host=HOST, interface=INTERFACE,
                  checked=datetime.datetime.now(datetime.timezone.utc).isoformat())
    print(json.dumps(result))
    return int(result["link"] in ("DOWN", "UNKNOWN"))


if __name__ == "__main__":
    sys.exit(main())
