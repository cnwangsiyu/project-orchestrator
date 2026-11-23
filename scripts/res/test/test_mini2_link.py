"""Offline cable and SSH fixtures. Run with python3 -B scripts/res/test/test_mini2_link.py."""
import json
from pathlib import Path
import socket
import subprocess
import sys
sys.dont_write_bytecode = True
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import mini2_link as probe


def answer(ip, idx=17):
    return (socket.AF_INET6, socket.SOCK_STREAM, 6, "", (ip, 22, 0, idx))


class ResolverTests(unittest.TestCase):
    def resolve(self, records, status="active", route="en7", reachable=(), observe=False):
        outputs = {"/usr/sbin/ioreg": "  +-o en7  <class IOEthernetInterface, ",
                   "/sbin/route": "\tinterface: " + route,
                   "/sbin/ifconfig": "\tstatus: " + status}

        def run(args, **kw):
            if args[0] == sys.executable:
                return subprocess.CompletedProcess([], 0, stdout=json.dumps(
                    {"link": "RESOLVED", "address": probe.resolve()}))
            if args[0] == "/usr/bin/ssh":
                return subprocess.CompletedProcess([], 0, b"mini2-link-ok\n", b"")
            return subprocess.CompletedProcess([], 0, stdout=outputs[args[0]])

        def connect(address):
            self.assertEqual(address[1:], (22, 0, 17))
            if address[0] not in reachable:
                raise ConnectionRefusedError()

        with patch.object(socket, "if_nametoindex", return_value=17), \
                patch.object(subprocess, "run", side_effect=run), \
                patch.object(socket, "getaddrinfo", return_value=records), \
                patch.object(socket, "socket") as sockets:
            sockets.return_value.__enter__.return_value.connect.side_effect = connect
            result = probe.observation("probe") if observe else probe.resolve()
            self.connections = sockets
            return result

    def test_only_unique_scoped_answer_and_fresh_lookup(self):
        records = [answer("fe80::a", 3), answer("fe80::a%en0"), answer("2001:db8::1"),
                   answer("fe80::a", 0), answer("fe80::2"), answer("fe80::2%17")]
        self.assertEqual(self.resolve(records), "fe80::2%en7")
        self.connections.assert_not_called()
        self.assertEqual(self.resolve([answer("fe80::3%en7")]), "fe80::3%en7")
        self.connections.assert_not_called()

    def test_multiple_answers_one_reachable_is_up(self):
        records = [answer("fe80::1"), answer("fe80::2"), answer("fe80::2%en7")]
        self.assertEqual(self.resolve(records, reachable=("fe80::2",), observe=True),
                         {"link": "UP", "address": "fe80::2%en7"})
        self.assertEqual(self.connections.call_count, 2)
        self.connections.assert_called_with(socket.AF_INET6, socket.SOCK_STREAM)
        connection = self.connections.return_value.__enter__.return_value
        self.assertEqual([call.args[0] for call in connection.connect.call_args_list],
                         [("fe80::1", 22, 0, 17), ("fe80::2", 22, 0, 17)])
        for call in connection.settimeout.call_args_list:
            self.assertGreater(call.args[0], 0)
            self.assertLessEqual(call.args[0], 2)

    def test_multiple_answers_two_or_none_reachable_stay_ambiguous(self):
        records = [answer("fe80::1"), answer("fe80::2")]
        for reachable in [("fe80::1", "fe80::2"), ()]:
            with self.subTest(reachable=reachable):
                with self.assertRaisesRegex(probe.LinkFailure, "ambiguous-answer") as fail:
                    self.resolve(records, reachable=reachable)
                self.assertEqual(fail.exception.link, "UNKNOWN")

    def test_connection_budget_exhausted_keeps_untested_answers_ambiguous(self):
        records = [answer("fe80::1"), answer("fe80::2")]
        with patch.object(probe.time, "monotonic", side_effect=[0, 0, 5]), \
                self.assertRaisesRegex(probe.LinkFailure, "ambiguous-answer"):
            self.resolve(records, reachable=("fe80::1",))

    def test_last_connection_timeout_uses_remaining_budget(self):
        records = [answer("fe80::1"), answer("fe80::2")]
        with patch.object(probe.time, "monotonic", side_effect=[0, 0, 4.5]):
            self.assertEqual(self.resolve(records, reachable=("fe80::2",)), "fe80::2%en7")
        connection = self.connections.return_value.__enter__.return_value
        self.assertEqual([call.args[0] for call in connection.settimeout.call_args_list], [2, 0.5])

    def test_non_usb_answer_and_changed_route(self):
        with self.assertRaisesRegex(probe.LinkFailure, "no-cable-answer"):
            self.resolve([answer("fe80::1", 3)])
        with self.assertRaisesRegex(probe.LinkFailure, "wrong-cable-route"):
            self.resolve([answer("fe80::1")], route="bridge0")

    def test_fail_closed(self):
        for records, status, link, reason in [
            ([answer("fe80::1")], "inactive", "DOWN", "interface-inactive"),
            ([answer("fe80::1")], "unknown", "UNKNOWN", "interface-status-unknown"),
            ([answer("fe80::1", 0)], "active", "UNKNOWN", "no-cable-answer"),
            ([answer("fe80::1"), answer("fe80::2")], "active", "UNKNOWN", "ambiguous-answer"),
        ]:
            with self.subTest(reason=reason), self.assertRaises(probe.LinkFailure) as fail:
                self.resolve(records, status)
            self.assertEqual((fail.exception.link, str(fail.exception)), (link, reason))


class ObservationTests(unittest.TestCase):
    @staticmethod
    def resolved():
        return subprocess.CompletedProcess([], 0, stdout=json.dumps(
            {"link": "RESOLVED", "address": "fe80::c%en7"}))

    def test_default_and_maintenance_do_no_io(self):
        for mode in ("disabled", "maintenance"):
            with patch.object(subprocess, "run") as run:
                self.assertEqual(probe.observation(mode)["link"], mode.upper())
                run.assert_not_called()

    def test_resolver_failure_prevents_ssh(self):
        for response, reason in [(subprocess.TimeoutExpired([], 8), "resolution-timeout"),
                                 (subprocess.CompletedProcess([], 0, stdout='{"link":"DOWN","reason":"interface-inactive"}'), "interface-inactive")]:
            with patch.object(subprocess, "run", side_effect=[response]) as run:
                self.assertEqual(probe.observation("probe")["reason"], reason)
                self.assertEqual(run.call_count, 1)
                self.assertEqual(run.call_args.kwargs["timeout"], 8)

    def test_read_only_ssh_over_resolved_route(self):
        with patch.object(subprocess, "run", side_effect=[self.resolved(),
                          subprocess.CompletedProcess([], 0, b"mini2-link-ok\n", b"")]) as run:
            self.assertEqual(probe.observation("probe"), {"link": "UP", "address": "fe80::c%en7"})
            args = run.call_args.args[0]
            for option in ["-oHostname=fe80::c%%en7", "-oHostKeyAlias=" + probe.HOST,
                           "-oStrictHostKeyChecking=yes", "-oProxyCommand=none", "-oControlPath=none"]:
                self.assertIn(option, args)
            self.assertEqual(run.call_args.kwargs["timeout"], 12)
            # Validate client option compatibility without connecting.
        config = subprocess.run([args[0], "-G", *args[1:]], capture_output=True)
        self.assertEqual(config.returncode, 0)
        self.assertIn(b"hostname fe80::c%en7\n", config.stdout)

    def test_ssh_timeout_identity_failure_and_bad_reply(self):
        for response, reason in [
            (subprocess.TimeoutExpired([], 12), "ssh-timeout"),
            (subprocess.CompletedProcess([], 255, b"", b"Host key verification failed."), "identity-check-failed"),
            (subprocess.CompletedProcess([], 0, b"", b""), "ssh-failed"),
        ]:
            with patch.object(subprocess, "run", side_effect=[self.resolved(), response]):
                self.assertEqual(probe.observation("probe"),
                                 dict(link="UNKNOWN", address="fe80::c%en7", reason=reason))


if __name__ == "__main__":
    unittest.main()
