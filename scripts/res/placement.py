"""Cross-host compute placement. Controllers retain ownership of admission and FIFO."""
import argparse
import json
import math
import os
import platform
import re
import shlex
import subprocess
import sys
import time
from pathlib import Path

import local_control as local
import mini2_control as mini

RES = str(Path(__file__).resolve().with_name("res"))
WAITABLE = {"open", "load", "load5", "memory", "disk", "pressure", "fifo", "checkout-held",
            "max-claims", "io-pressure", "held", "held-or-pending"}


def tags(description):
    return dict(word.split("=", 1) for word in description.split() if "=" in word)


def candidate(machine, reason, spare=None):
    return dict(machine=machine, eligible=reason in WAITABLE, reason=reason,
                spareCores=round(spare, 4) if spare is not None else None,
                waitSeconds=0 if reason == "open" else None)


def devbox_rows(candidates, rank):
    # One representative per host, preserving the pool's preference tiers and affinity.
    result = {}
    for slot, box, reason, spare, description in sorted(candidates, key=lambda r: (
            r[2] != "open", r[2] not in WAITABLE, r[2] == "pool", rank(r[0]))):
        result.setdefault(box, dict(candidate("devbox:" + box, reason, spare),
                                    tags=tags(description)))
    return list(result.values())


def constraint(args, machine, fields):
    if args.pin and args.pin != machine.split(":")[0]: return "pin"
    if args.must_local_reason and machine != "main": return "must-local"
    for name in ("os", "arch"):
        if getattr(args, name) and getattr(args, name) != fields.get(name): return name
    missing = set(filter(None, args.need.split(","))) - set(fields.get("caps", "").split(","))
    if missing: return "missing-cap:" + ",".join(sorted(missing))


def darwin(root, args, machine):
    try:
        main = machine == "main"
        row = local.registry(root) if main else mini.registry_row(root)
        fields = tags(row[4])
        if main:
            fields.setdefault("os", sys.platform)
            fields.setdefault("arch", platform.machine())
        reason = constraint(args, machine, fields)
        if reason or row[2] != "open": return candidate(machine, reason or "policy")
        details = {}
        if main:
            if not local.activated(root): return candidate(machine, "unmigrated-local")
            cfg, parsed = local.configuration(root)
            sample = local.measured(root, parsed)
            _, cost = local.cost_for(args, cfg, sample)
            reason = local.gate(root, cfg, sample, cost, details)
            if reason == "open" and any(v.get("build") and v.get("checkout") in
                    (None, local.checkout_identity(args)) for _, v in local.claims(root)):
                reason = "checkout-held"
        else:
            dynamic = mini.dynamic_row(row)
            cost = mini.weights(mini_args(args))
            reason = mini.admission(root, mini.config(root), time.time(), cost[2],
                                    args.need.split(",") if args.need else [],
                                    cost=cost if dynamic else None, details=details)
            if reason == "open" and not dynamic and mini.lease_holds(root): reason = "held"
        # A queued caller can only establish its actual position under the controller guard.
        queue = root / ("local-waiters" if main else "mini2-waiters")
        if reason == "open" and any(queue.glob("*.json")): reason = "fifo"
        charged = details.get("chargedCores")
        spare = details["limits"][0] - charged - cost[0] if charged is not None else None
        return candidate(machine, reason, spare)
    except (OSError, ValueError, TypeError, KeyError, subprocess.SubprocessError):
        return candidate(machine, "invalid-registry-config-or-metrics")


def mini_args(args):
    if args.profile != "medium": return args
    values = vars(args).copy()
    values.update(profile="heavy", cores=args.cores or 2, mem_gib=args.mem_gib or 4,
                  disk_gib=8 if args.disk_gib is None else args.disk_gib)
    return argparse.Namespace(**values)


def costs(args):
    flags = []
    for name in ("cores", "mem_gib", "disk_gib"):
        value = getattr(args, name)
        if value is not None: flags.extend(["--" + name.replace("_", "-"), format(value, "f").rstrip("0").rstrip(".")])
    return flags


def calculate(root, args):
    macs = [darwin(root, args, host) for host in ("main", "mini2")]
    pool = "devbox-cn-light" if args.profile == "light" else "devbox-cn"
    result = subprocess.run([RES, "place-devboxes", pool, args.need, "--project", args.project,
                             *costs(args)], capture_output=True, text=True)
    if result.returncode: raise ValueError(result.stderr.strip() or "devbox placement unavailable")
    boxes = json.loads(result.stdout)
    for row in boxes:
        reason = constraint(args, row["machine"], row.pop("tags"))
        if reason: row.update(candidate(row["machine"], reason, row["spareCores"]))
    for row in macs + boxes:
        machine = row["machine"]
        if machine == "main":
            cmd = ["wait-build", "--profile", args.profile, *costs(args)]
        elif machine == "mini2":
            request = mini_args(args)
            cmd = ["wait-pool", "mini2", "--profile", request.profile, *costs(request)]
        else:
            cmd = ["wait-pool", pool, *costs(args)]
            others = [v["machine"][7:] for v in boxes if v is not row]
            if others: cmd += ["--hard-exclude-host", ",".join(others)]
        if args.need: cmd += ["--need", args.need]
        row["argv"] = cmd
    # Merge the ordered devbox stream with the two Darwin hosts; sorting all hosts
    # by CPU again would discard the devbox tier/affinity decision.
    def order(row):
        return (row["reason"] != "open", not row["eligible"],
                -(row["spareCores"] if row["spareCores"] is not None else -math.inf))
    ranked = []
    while macs or boxes:
        choices = macs + boxes[:1]
        best = min(choices, key=order)
        if best["machine"] == "main" and best["reason"] == "open" and best["spareCores"] is not None:
            close = [r for r in choices if r is not best and r["reason"] == "open" and
                     r["spareCores"] is not None and r["spareCores"] >= .8 * best["spareCores"]]
            if close: best = min(close, key=order)
        (macs if best in macs else boxes).remove(best)
        ranked.append(best)
    return ranked


def parser():
    p = argparse.ArgumentParser(description=__doc__)
    for name in ("need", "os", "arch", "project", "must-local-reason"):
        p.add_argument("--" + name, default="")
    p.add_argument("--profile", choices=("heavy", "medium", "light"), default="heavy")
    p.add_argument("--pin", choices=("main", "mini2", "devbox"))
    for name in ("cores", "mem-gib", "disk-gib"):
        p.add_argument("--" + name, type=float)
    p.add_argument("--json", action="store_true")
    p.set_defaults(checkout="", action="wait-build", resource="")
    return p


def main():
    args = parser().parse_args()
    if args.need and not re.fullmatch(r"[\w.:-]+(?:,[\w.:-]+)*", args.need): raise ValueError("invalid --need")
    for value, minimum in ((args.cores, .25), (args.mem_gib, .25), (args.disk_gib, 0)):
        if value is not None and not (minimum <= value <= 65536): raise ValueError("invalid cost")
    rows = calculate(mini.root_dir(), args)
    for row in rows:
        row["command"] = shlex.join(["res", *row.pop("argv")]) + ' --by "$holder" --project ' + (
            shlex.quote(args.project) if args.project else '"$project"') + ' --task "$task" --for "$purpose" --pid "$$" --timeout 60'
    chosen = next((r["machine"] for r in rows if r["eligible"]), None)
    if args.json: print(json.dumps(dict(chosen=chosen, candidates=rows)))
    else: print("chosen=" + (chosen or "none") + " " + " | ".join(
        f"{r['machine']}={r['reason']} spareCores={r['spareCores']} wait={r['waitSeconds'] if r['waitSeconds'] is not None else 'unknown'} [{r['command']}]" for r in rows))


if __name__ == "__main__":
    try: main()
    except (ValueError, OSError) as error:
        sys.exit("res place: " + str(error))

