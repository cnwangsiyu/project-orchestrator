#!/usr/bin/env node
// Owner entry point; normal workers never run this against a live devbox.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execute, readRegistry } from './devbox-run.mjs';
import { treeSettings, treePython } from './lib/devbox-trees.mjs';

const shared = () => process.env.RES_DIR || process.env.RULES_SHARED || path.join(os.homedir(), '.claude/orchestrator/_shared');
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
const header = 'import os,sys,json,pathlib,time,base64\nd=json.loads(base64.b64decode(sys.argv[1]))\n';
const checked = (result, label) => { if (result.code) throw Error(`${label} failed (${result.code}): ${result.stderr}`); return result.stdout; };

export async function evict(target, root, primaryTarget = 73) {
  const match = /^([A-Za-z_][A-Za-z0-9_.-]*)@((?:\d{1,3}\.){3}\d{1,3})$/.exec(target || '');
  if (!match || !Number.isFinite(primaryTarget) || primaryTarget < 53) throw Error('usage: devbox-evict.mjs USER@HOST ROOT [TARGET_FREE_GIB>=53]');
  const host = match[2], config = treeSettings(shared())[host];
  if (!config) throw Error('tree eviction is not enabled for this host');
  const facts = JSON.parse(fs.readFileSync(path.join(process.env.DEVBOX_CACHE_DIR || shared(), 'devbox-hosts.json'), 'utf8'))[host];
  if (facts?.user !== match[1] || facts.root !== root) throw Error('primary root differs from registered runner facts');
  const rows = [...readRegistry(shared(), 'devbox-cn'), ...readRegistry(shared(), 'devbox-cn-light')].filter(row => row.target === target);
  if (!rows.length) throw Error('host has no open registered slots');
  const controller = process.env.RES_COMMAND || path.join(shared(), 'res');
  const state = { children: new Set(), cancel: 0, values: [] };
  const stop = () => { state.cancel = 143; for (const child of state.children) child('SIGTERM'); };
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, stop);
  const parent = process.ppid;
  const watch = setInterval(() => { try { process.kill(parent, 0); } catch { stop(); } }, 1000);
  const remote = async (op, data) => {
    const code = header + treePython + (op === 'list' ? String.raw`
trees=tree_list(d); roots=[]
for root,floor in tree_roots(d):
    ancestor=root
    while not ancestor.exists(): ancestor=ancestor.parent
    disk=os.statvfs(ancestor)
    roots.append({'root':str(root),'floorGiB':floor,'freeGiB':disk.f_bavail*disk.f_frsize/TREE_GIB})
print(json.dumps({'trees':trees,'roots':roots}))
` : 'print(json.dumps(tree_evict(d)))\n');
    const command = `# devbox-evict:${op}\npython3 -c ${quote(code)} ${quote(Buffer.from(JSON.stringify(data)).toString('base64'))}`;
    return JSON.parse(checked(await execute('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', target, command], { state, timeout: 120000, rawCapture: false, strictOutput: false }), 'eviction SSH'));
  };
  const held = slot => fs.existsSync(path.join(shared(), 'locks', slot + '.d'));
  const data = { root, treeConfig: config, slots: rows.map(row => row.slot) };
  const deleted = [];
  try {
    const log = path.join(shared(), 'reports/devbox-evictions/evictions.tsv');
    fs.mkdirSync(path.dirname(log), { recursive: true });
    if (!fs.existsSync(log)) fs.writeFileSync(log, 'time\thost\tpath\tsize_mb\tdir_mtime\tfree_before_gib\tfree_after_gib\n');
    fs.accessSync(log, fs.constants.W_OK);
    const inventory = await remote('list', data);
    const pressure = new Set(inventory.roots.filter(row => row.freeGiB < row.floorGiB).map(row => row.root));
    for (const tree of inventory.trees.toSorted((a, b) => a.lastUsed - b.lastUsed)) {
      if (state.cancel) throw Error('eviction cancelled');
      if (!rows.some(row => row.slot === tree.slot) || held(tree.slot)) continue;
      const by = `devbox-evict-${process.pid}-${randomUUID()}`;
      const common = ['--by', by, '--project', 'devbox-run', '--task', 'evict', '--for', 'registered cold tree eviction', '--pid', String(process.pid)];
      const release = async () => checked(await execute(controller, ['return', tree.slot, '--by', by], { state, cancellable: false, timeout: 30000, rawCapture: false }), 'eviction return');
      const mine = () => {
        try {
          const info = Object.fromEntries(fs.readFileSync(path.join(shared(), 'locks', tree.slot + '.d', 'info'), 'utf8').trim().split('\n').map(line => line.split('\t')));
          return info.by === by && info.pid === String(process.pid);
        } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
      };
      const take = await execute(controller, ['take', tree.slot, ...common, '--maintenance'], { state, timeout: 30000, rawCapture: false });
      if (take.code) {
        if (mine()) await release();
        if (take.code === 2 || take.code === 3) continue;
        checked(take, 'eviction take');
      }
      let confirmed = true;
      try {
        if (state.cancel || !mine()) throw Error('eviction slot ownership unconfirmed');
        // Unknown SSH completion must not make a deleting slot reclaimable.
        checked(await execute(controller, ['retain-remote', tree.slot, '--by', by, '--pid', String(process.pid)],
          { state, timeout: 30000, rawCapture: false }), 'eviction cleanup protection');
        confirmed = false;
        const result = await remote('evict', { ...data, ...tree, heldSlots: rows.filter(row => row.slot !== tree.slot && held(row.slot)).map(row => row.slot),
          targetFreeGiB: tree.treeRoot === root && pressure.has(root) ? Math.max(primaryTarget, config.primaryFloorGiB) : tree.floorGiB });
        confirmed = true;
        if (!result.path) { console.log(JSON.stringify({ slot: tree.slot, ...result })); continue; }
        console.log(JSON.stringify(result));
        fs.appendFileSync(log, [new Date().toISOString(), host, result.path, result.bytes / 1048576, new Date(result.lastUsed * 1000).toISOString(), result.freeBeforeGiB, result.freeAfterGiB].join('\t') + '\n');
        deleted.push(result);
      } finally {
        if (confirmed) await release();
        else console.error(`BLOCKED: eviction completion unconfirmed; retaining protected ${tree.slot} for owner recovery`);
      }
    }
    return deleted;
  } finally { clearInterval(watch); for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.removeListener(signal, stop); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  try {
    if (args[0] === '--enabled' && args.length === 2) console.log(treeSettings(shared())[args[1].split('@')[1]] ? 'enabled' : 'disabled');
    else if (args.length >= 2 && args.length <= 3) await evict(args[0], args[1], args[2] === undefined ? 73 : Number(args[2]));
    else throw Error('usage: devbox-evict.mjs USER@HOST ROOT [TARGET_FREE_GIB]');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
