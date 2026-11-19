"""Bounded process evidence for dead local build holders; never print arguments."""
import json
import os
import re
import subprocess
import sys
import time


def probe(hold):
    paths = set()
    for key in ('checkout_paths', 'checkouts'):
        try:
            values = json.loads(hold.get(key, '[]'))
            if not isinstance(values, list): return None, ''
            for value in values:
                if not isinstance(value, str): return None, ''
                if value.startswith('repo:'):
                    value = value[5:]
                    if value.endswith('/.git'): value = value[:-5]
                if os.path.isabs(value):
                    paths.add(value.rstrip('/') or '/')
                    canonical = os.path.realpath(value).rstrip('/') or '/'
                    paths.add(canonical)
                    if sys.platform == 'darwin' and canonical.startswith(('/private/var/', '/private/tmp/')):
                        paths.add(canonical[8:])
        except (TypeError, ValueError): return None, ''
        if paths: break  # Exact roots take precedence over common repository identities.
    if not paths: return 0, ''  # Legacy identity-only holds retain their behavior.
    deadline = time.monotonic() + 4
    try:
        result = subprocess.run(['ps', '-axo', 'pid=,ppid=,pgid=,sess=,state=,args='],
                                capture_output=True, text=True, timeout=2)
        if result.returncode: return None, sorted(paths)[0]
        table = {}
        for line in result.stdout.splitlines():
            fields = line.strip().split(None, 5)
            if len(fields) == 6 and fields[0].isdigit() and fields[1].isdigit():
                table[int(fields[0])] = fields[1:]
        ignored = set()
        ancestor = os.getpid()
        while ancestor and ancestor not in ignored:
            ignored.add(ancestor)
            ancestor = int(table.get(ancestor, ['0'])[0])
        cwd = {}
        if sys.platform == 'darwin':
            listing = subprocess.run(['lsof', '-w', '-a', '-d', 'cwd', '-Fpn'],
                                     capture_output=True, text=True, timeout=2)
            if listing.returncode not in (0, 1): return None, sorted(paths)[0]
            current = None
            for line in listing.stdout.splitlines():
                if line.startswith('p') and line[1:].isdigit(): current = int(line[1:])
                elif line.startswith('n') and current: cwd[current] = line[1:]
        else:
            for pid in table:
                if time.monotonic() > deadline: return None, sorted(paths)[0]
                try: cwd[pid] = os.readlink('/proc/%d/cwd' % pid)
                except FileNotFoundError: pass
                except PermissionError: pass  # ps argument evidence still covers these processes.
        found = set()
        matched = ''
        for pid, (_, pgid, session, state, args) in table.items():
            if pid in ignored or state.startswith('Z'): continue
            grouped = (hold.get('pgid') not in (None, '', '0', '1') and pgid == hold['pgid'] or
                       hold.get('session') not in (None, '', '0', '1') and session == hold['session'] or
                       pgid == hold.get('pid'))
            for checkout in paths:
                under = cwd.get(pid, '') == checkout or cwd.get(pid, '').startswith(checkout + '/')
                argument = re.search(r'(?<![\w/.-])' + re.escape(checkout) + r'(?=/|[\s\x00\x22\x27]|$)', args)
                if grouped or under or argument:
                    found.add(pid); matched = checkout; break
        return len(found), matched or sorted(paths)[0]
    except (OSError, subprocess.TimeoutExpired):
        return None, sorted(paths)[0]


if __name__ == '__main__':
    with open(sys.argv[1]) as stream:
        hold = dict(line.rstrip('\n').split('\t', 1) for line in stream if '\t' in line)
    count, checkout = probe(hold)
    print('unknown' if count is None else count, checkout, sep='\t')
    sys.exit(0 if count == 0 else 1)
