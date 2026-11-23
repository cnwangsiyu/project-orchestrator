"""Read-only link observation for the main mini. No scheduler state or leases."""
import argparse
import datetime
import ipaddress
import json
import re
import socket
import subprocess
import sys
sys.dont_write_bytecode = True
import time
from pathlib import Path


HOST = "Bytedances-Mac-mini.local"


class LinkFailure(Exception):
    def __init__(self, reason, link="UNKNOWN"):
        super().__init__(reason)
        self.link = link


def resolve():
    # Darwin can renumber both ends of the USB network link after a reboot.
    # Intersect hardware-backed interface names with scoped peer answers.
    try:
        cables = {}
        for driver in ("AppleUSBNCMData", "AppleUSBDeviceNCM11Data"):
            tree = subprocess.run(["/usr/sbin/ioreg", "-r", "-c", driver, "-w0"],
                                  capture_output=True, text=True, timeout=3, check=True)
            for name in re.findall(r"^  \+-o (en[0-9]+)\s+<class IOEthernetInterface,", tree.stdout, re.M):
                cables[socket.if_nametoindex(name)] = name
    except (OSError, subprocess.SubprocessError) as error:
        raise LinkFailure("interface-unavailable") from error
    if not cables:
        raise LinkFailure("interface-unavailable")

    try:
        addresses = set()
        for family, _, _, _, addr in socket.getaddrinfo(HOST, 22, socket.AF_INET6, socket.SOCK_STREAM):
            index = addr[3]
            interface = cables.get(index)
            if family != socket.AF_INET6 or not interface:
                continue
            literal, _, zone = addr[0].partition("%")
            ip = ipaddress.IPv6Address(literal)
            if ip.is_link_local and zone in ("", interface, str(index)):
                addresses.add((str(ip), interface))
    except (OSError, ValueError) as error:
        raise LinkFailure("resolution-failed") from error
    if not addresses:
        raise LinkFailure("no-cable-answer")
    if len(addresses) > 1:
        # mDNS may also advertise the peer's Thunderbolt bridge on the USB
        # interface. Only disambiguate when exactly one candidate accepts SSH.
        deadline = time.monotonic() + 5
        reachable = set()
        indices = {interface: index for index, interface in cables.items()}
        for literal, interface in sorted(addresses):
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                # Untested candidates could still be reachable.
                raise LinkFailure("ambiguous-answer")
            try:
                with socket.socket(socket.AF_INET6, socket.SOCK_STREAM) as connection:
                    connection.settimeout(min(2, remaining))
                    connection.connect((literal, 22, 0, indices[interface]))
                reachable.add((literal, interface))
            except OSError:
                continue
        if len(reachable) != 1:
            raise LinkFailure("ambiguous-answer")
        addresses = reachable
    literal, interface = addresses.pop()
    address = literal + "%" + interface
    try:
        info = subprocess.run(["/sbin/ifconfig", interface], capture_output=True,
                              text=True, timeout=3, check=True)
    except (OSError, subprocess.SubprocessError) as error:
        raise LinkFailure("interface-unavailable") from error
    lines = {line.strip() for line in info.stdout.splitlines()}
    if "status: inactive" in lines:
        raise LinkFailure("interface-inactive", "DOWN")
    if "status: active" not in lines:
        raise LinkFailure("interface-status-unknown")
    try:
        route = subprocess.run(["/sbin/route", "-n", "get", "-inet6", address],
                               capture_output=True, text=True, timeout=3, check=True)
        if "interface: " + interface not in {line.strip() for line in route.stdout.splitlines()}:
            raise LinkFailure("wrong-cable-route")
    except (OSError, subprocess.SubprocessError) as error:
        raise LinkFailure("route-unavailable") from error
    return address


def observation(mode):
    if mode != "probe":
        return {"link": mode.upper()}
    # Bound libc name resolution in a disposable process, including ifconfig.
    try:
        child = subprocess.run([sys.executable, "-B", str(Path(__file__).resolve()), "--resolve-usb"],
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
    modes.add_argument("--resolve-usb", dest="mode", action="store_const", const="resolve",
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
    result.update(host=HOST, interface=result.get("address", "").partition("%")[2] or None,
                  checked=datetime.datetime.now(datetime.timezone.utc).isoformat())
    print(json.dumps(result))
    return int(result["link"] in ("DOWN", "UNKNOWN"))


if __name__ == "__main__":
    sys.exit(main())
