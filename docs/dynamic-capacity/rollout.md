# Owner rollout

These are owner commands. The implementation worker does not modify live state
or contact mini2. Install mini2 first; the later local-lane migration is separate.
Use the committed task worktree or an integrated checkout containing the same
files. The remote Python helper is sent by the runner on each operation; no
remote daemon or separate remote helper installation is required.

## Mini2 install and migration

```sh
capacity_code=/Users/bytedance/.claude/orchestrator/_shared/tasks/R-mini2-dynamic/worktree
capacity_shared=/Users/bytedance/.claude/orchestrator/_shared
cd "$capacity_code"
node scripts/test/mini2-scenarios.mjs
node scripts/res/test/dynamic-leases.mjs
node scripts/res/test/dynamic-fifo.mjs
mkdir "$capacity_shared/tasks/R-mini2-dynamic/install-mini2"
readlink "$capacity_shared/res" > "$capacity_shared/tasks/R-mini2-dynamic/install-mini2/previous-res-target.txt"
ln -s "$capacity_code/scripts/res/res" "$capacity_shared/.res-mini2-dynamic-new"
mv -f "$capacity_shared/.res-mini2-dynamic-new" "$capacity_shared/res"
python3 -B scripts/mini2-host-migrate.py --registry "$capacity_shared/resources.tsv"
python3 -B scripts/mini2-host-migrate.py --registry "$capacity_shared/resources.tsv" --apply
"$capacity_shared/res" status mini2 --json
"$capacity_shared/res" slot-host mini2-exec-1
"$capacity_shared/res" pool-capacity mini2
```

Coordinate the code switch with callers; existing holders can finish, and old
unweighted holds close parallel admission until their normal receipt return.
The migration keeps existing enabled/policy/caps/maintenance settings. It backs
up `resources.tsv` and `mini2-config.json` into
`resources.tsv.pre-mini2-dynamic` and its `.config` sibling (mode 600), then uses
temp-file renames under the same host guard. No local-lane registry marker is
changed. The dry run shows the registry diff; old numeric 6/16 overrides are
converted to derived during apply.

## Mini2 live smoke: three concurrent light runners

Run the following only after normal fresh-link/capability health is established.
It creates a tracked-source-only fixture and three owned runners, each with a
separate output directory and watched driver PID. The runner itself refreshes
metrics, acquires its lease, validates cleanup and returns its exact ID.

```sh
python3 - "$capacity_code" "$capacity_shared/tasks/R-mini2-dynamic" <<'PY'
import concurrent.futures,json,os,pathlib,subprocess,tempfile
code=pathlib.Path(__import__('sys').argv[1])
root=pathlib.Path(tempfile.mkdtemp(prefix='live-mini2-',dir=__import__('sys').argv[2]))
repo=root/'fixture'; repo.mkdir()
(repo/'README.md').write_text('Mini2 concurrent admission fixture.\n')
subprocess.run(['git','init',str(repo)],check=True,stdout=subprocess.DEVNULL)
subprocess.run(['git','-C',str(repo),'add','README.md'],check=True)
subprocess.run(['git','-C',str(repo),'-c','user.name=Mini2 fixture','-c','user.email=fixture@example.invalid','commit','-m','Fixture'],check=True,stdout=subprocess.DEVNULL)
allow=root/'allowlist.json'; allow.write_text(json.dumps(['README.md']))
def run(number):
    out=root/str(number)
    command=['node',str(code/'scripts/mini2-run.mjs'),'--repo',str(repo),'--allowlist',str(allow),'--project','mini2-smoke','--task','dynamic-light','--by',root.name+'-'+str(number),'--out',str(out),'--profile','light','--cores','1','--mem-gib','1','--disk-gib','1','--watch-pid',str(os.getpid()),'--timeout','2','--','sleep 20; true']
    result=subprocess.run(command)
    if result.returncode: raise RuntimeError('runner failed; inspect named masked logs in '+str(out))
    summary=json.loads((out/'summary.json').read_text())
    intent=json.loads((out/'intent.json').read_text())
    assert summary['clean'] and summary['receipt']['exit']==0
    return intent['slot'],intent['runId']
with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
    values=list(pool.map(run,range(1,4)))
assert len({value[0] for value in values})==3,values
assert len({value[1] for value in values})==3,values
print('PASS three distinct leases and workspaces, all returned; evidence:',root)
PY
"$capacity_shared/res" status mini2 --json
```

Successful smoke requires three different overlapping lease IDs, different run
UUIDs, exit zero and clean summaries for all three; no residual owned holds.
An admission or transport failure stops the smoke and retains its evidence.
For an unconfirmed run, use the exact owner ID from its intent:
`node scripts/mini2-run.mjs reconcile --out <that-output-dir> --by <that-by>`.
Do not remove holds/pending directories without the generation/run-matched
cleanup receipt. Existing source allowlist restrictions remain effective.

## Mini2 rollback

```sh
cd "$capacity_code"
python3 -B scripts/mini2-host-migrate.py --registry "$capacity_shared/resources.tsv" --rollback
"$capacity_shared/res" status mini2 --json
```

This one command restores exact registry/config bytes. Keep the new controller
until every mini2 hold and pending receipt has returned; it closes legacy
admission while dynamic IDs drain. Then, if no independently installed local
dynamic lanes need this controller, restore the prior code link:

```sh
capacity_previous_res=$(cat "$capacity_shared/tasks/R-mini2-dynamic/install-mini2/previous-res-target.txt")
ln -s "$capacity_previous_res" "$capacity_shared/.res-mini2-rollback-new"
mv -f "$capacity_shared/.res-mini2-rollback-new" "$capacity_shared/res"
```

If registry/config changed after migration, automatic rollback refuses to
overwrite those changes. Reconcile the owner's changes before retrying; the
original exact backups remain untouched. Code rollback comes last.
