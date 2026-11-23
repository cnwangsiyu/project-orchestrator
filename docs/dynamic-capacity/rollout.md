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
    command=['node',str(code/'scripts/mini2-run.mjs'),'--repo',str(repo),'--allowlist',str(allow),'--project','mini2-smoke','--task','dynamic-light','--by',root.name+'-'+str(number),'--out',str(out),'--profile','light','--cores','1','--mem-gib','1','--disk-gib','1','--watch-pid',str(os.getpid()),'--timeout','2','--claim-timeout','1','--','sleep 20; true']
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

The smoke uses a bounded one-minute claim wait so queued fitting claims retain
FIFO order. The runner keeps its existing immediate-claim default unless
`--claim-timeout` is supplied; `--timeout` still bounds remote execution.

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

This one command restores the exact mini2 registry row and config bytes, preserving the local migration and other registry rows. Keep the new controller
until every mini2 hold and pending receipt has returned; it closes legacy
admission while dynamic IDs drain. Then, if no independently installed local
dynamic lanes need this controller, restore the prior code link:

```sh
capacity_previous_res=$(cat "$capacity_shared/tasks/R-mini2-dynamic/install-mini2/previous-res-target.txt")
ln -s "$capacity_previous_res" "$capacity_shared/.res-mini2-rollback-new"
mv -f "$capacity_shared/.res-mini2-rollback-new" "$capacity_shared/res"
```

If the target registry row or its owning config changed after migration, automatic rollback refuses to
overwrite those changes. Reconcile the owner's changes before retrying; the
original exact backups remain untouched. Code rollback comes last.

## Main-mini local install, independently after mini2

The compatible code link from the mini2 install already contains the local
controller and helper. Update local callers to use this checkout's
`scripts/heavy-build.sh` before migration; it accepts opaque lane IDs and uses
the dispatch binding contract. Let already-held legacy pairs finish normally.
Coordinate old queued callers at the switch. Preserve the 2026-11-19 memory
panic observation through 2026-11-26: the smoke below requests light work and
does not build an app or change security software.

```sh
cd "$capacity_code"
python3 -B scripts/res/test/test_local_control.py
node scripts/res/test/output-shapes.mjs
RES_TEST_SUITE=mini-build.mjs node scripts/res/test/run.mjs
RES_TEST_SUITE=build.mjs node scripts/res/test/run.mjs
python3 -B scripts/local-host-migrate.py --registry "$capacity_shared/resources.tsv"
python3 -B scripts/local-host-migrate.py --registry "$capacity_shared/resources.tsv" --apply
"$capacity_shared/res" status local --json
"$capacity_shared/res" pool-capacity local
"$capacity_shared/res" pool-capacity local-light
```

The local migration adds only `dynamic-local` to the `heavy-build` row and
missing `LOCAL_*` settings in machine.conf. It keeps the old build/lane rows and
legacy settings as aliases/fallback. Exact backups are
`resources.tsv.pre-local-dynamic`, `.machine` and `.machine-existed`; the mini2
backups and config are untouched. Configurable settings are load limit,
available-memory floor, free-disk floor, heavy/medium/light core and memory
costs, bypass budget and metric TTL. The first four hardware-dependent costs
and limits default to `derived`; they resolve against the current sample.
Claim CLI overrides: `--profile heavy|medium|light --cores N --mem-gib GiB
--disk-gib GiB`. Wrapper equivalents: `HEAVY_BUILD_PROFILE`,
`HEAVY_BUILD_CORES`, `HEAVY_BUILD_MEM_GIB`.

## Main-mini live smoke: three overlapping light lane holders

This driver acquires three light lanes with the driver's long-lived PID, holds
them together while running `true`, resolves their IDs, and returns every owned
ID in its `finally` block. It takes no resources if the native pressure/load or
memory gate closes. Do not inject test metrics for this live smoke.

```sh
python3 - "$capacity_shared/res" <<'PY'
import concurrent.futures,json,os,subprocess,sys,time,uuid
res=sys.argv[1]; by='local-light-smoke-'+str(uuid.uuid4()); acquired=[]
def claim(index):
    result=subprocess.run([res,'wait-lane','--by',by+'-'+str(index),'--project','local-smoke','--task','light','--for','true smoke','--pid',str(os.getpid()),'--profile','light','--wrapper','--timeout','0'],capture_output=True,text=True)
    if result.returncode: return index,None,result.stderr
    lane=dict(line.split('=',1) for line in result.stdout.splitlines() if '=' in line)['lane']
    acquired.append((index,lane))
    return index,lane,None
try:
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
        results=list(pool.map(claim,range(1,4)))
    if len(acquired)!=3: raise RuntimeError('native gate closed; '+str([(index,error) for index,lane,error in results if error]))
    assert len({lane for index,lane in acquired})==3
    for index,lane in acquired:
        value=json.loads(subprocess.check_output([res,'slot-host',lane],text=True))
        assert value['slot']==lane
    subprocess.run(['true'],check=True)
    time.sleep(3)
    print('PASS three overlapping light lanes:',[lane for index,lane in acquired])
finally:
    for index,lane in acquired:
        subprocess.run([res,'return',lane,'--by',by+'-'+str(index)],check=True)
PY
"$capacity_shared/res" status local --json
```

Full local builds use the same one-process wrapper, for example:

```sh
HEAVY_BUILD_BY=<unique-holder> HEAVY_BUILD_PROJECT=<project> HEAVY_BUILD_TASK=<task> \
  RES_COMMAND="$capacity_shared/res" HEAVY_BUILD_PROFILE=heavy \
  "$capacity_code/scripts/heavy-build.sh" --watch-pid <long-lived-worker-pid> -- <local-build-command>
```

The wrapper returns its own acquired pair even when interrupted. Do not return
another holder's resources or remove uncertain pending work. A dead controlled
unbound hold is reclaimed on the next claim; dispatched work retains its budget
until checkout/process evidence proves it has ended, or its owning wrapper
finishes normal cleanup.

## Main-mini local rollback

```sh
cd "$capacity_code"
python3 -B scripts/local-host-migrate.py --registry "$capacity_shared/resources.tsv" --rollback
"$capacity_shared/res" status local --json
```

This restores the exact original local row and owning machine.conf state while
preserving mini2's current row/config. Keep compatible code until all dynamic
local holds return; new dynamic claims close during drain. Either registry
migration can be rolled back first. Restore the previous code symlink only
after both migrations are rolled back and all corresponding dynamic holds and
pending receipts are gone. Publishing `global-rules.md` version 2026-11-22.4 is
an owner step after the corresponding install; the worker edits only its task
branch's source file, within the existing digest line budget.
