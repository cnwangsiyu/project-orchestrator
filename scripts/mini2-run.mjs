#!/usr/bin/env node
// Cable-only Darwin execution. Remote work never acquires a main-mini lane.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execute, snapshot, makeBundle } from './devbox-run.mjs';
import { redactLogFile } from './lib/log-redaction.mjs';
import { checkAllowlist, checkWorktree } from './lib/mini2-source.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
const digest = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const shared = () => process.env.RES_DIR || process.env.RULES_SHARED || path.join(os.homedir(), '.claude/orchestrator/_shared');
const remoteSource = () => fs.readFileSync(path.join(here, 'res/dynamic_capacity.py'), 'utf8') + '\n' + fs.readFileSync(path.join(here, 'lib/mini2_remote.py'), 'utf8');
const control = path.join(here, 'res/mini2_control.py');
const write = (file, value) => {
  const temp = file + '.' + randomUUID();
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); fs.renameSync(temp, file);
};

export function sshArgs(address, command, cableInterface) {
  if (!/^en[0-9]+$/.test(cableInterface) || !/^fe80:[0-9a-f:]+%en[0-9]+$/i.test(address) || address.split('%')[1] !== cableInterface) throw Error('invalid cable endpoint');
  return ['-6', '-Tax', '-oBatchMode=yes', '-oConnectTimeout=10', '-oConnectionAttempts=1',
    '-oStrictHostKeyChecking=yes', '-oUpdateHostKeys=no', '-oHostKeyAlias=Bytedances-Mac-mini.local',
    '-oHostname=' + address.replace('%', '%%'), '-oControlPath=none', '-oProxyCommand=none',
    '-oProxyJump=none', '-oClearAllForwardings=yes', '-oPermitLocalCommand=no',
    '-oServerAliveInterval=10', '-oServerAliveCountMax=2', 'bytedance@Bytedances-Mac-mini.local', command];
}

export async function remote(operation, data, options = {}) {
  const link = await execute('python3', ['-B', path.join(here, 'res/mini2_link.py'), '--probe'], { timeout: 25000 });
  const observation = JSON.parse(link.stdout);
  if (link.code || observation.link !== 'UP') throw Error('mini2 link unavailable: ' + observation.reason);
  const command = '. "$HOME/.mini2-env.sh" && exec /usr/bin/python3 -c ' + quote(remoteSource()) + ' ' + quote(operation) + ' ' + quote(JSON.stringify(data));
  const result = await execute('/usr/bin/ssh', sshArgs(observation.address, command, observation.interface), { timeout: 120000, ...options });
  if (options.errorFile && result.stderr) {
    fs.appendFileSync(options.errorFile, result.stderr, { mode: 0o600 });
    redactLogFile(options.errorFile, { force: true });
  }
  if (result.code) throw Error(`mini2 ${operation} failed (exit ${result.code}); inspect named masked operation log`);
  return options.outputFile ? result : result.stdout;
}

export async function refresh({ observeLink=true }={}) {
  const result = JSON.parse(await remote('metrics', {}));
  if (result.host !== 'Bytedances-Mac-mini.local' || result.arch !== 'arm64') throw Error('mini2 identity mismatch');
  write(path.join(shared(), 'mini2-metrics.json'), result);
  // Facts require actual tool execution on the same strictly verified cable path.
  const facts = JSON.parse(await remote('facts', {}));
  write(path.join(shared(), 'mini2-facts.json'), facts);
  if (observeLink) {
    const observation = await execute('python3', ['-B', path.join(here, 'res/mini2_monitor.py'), '--once'], { timeout: 35000 });
    if (observation.code) throw Error('mini2 link monitor refresh failed');
  }
  return { result, facts };
}

export function args(argv) {
  const opts = { ref: 'HEAD', profile: '', timeout: 10, claimTimeout: 0, artifacts: [], need:'cmake-native' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') { opts.command = argv.slice(i+1).join(' '); break; }
    if (arg === '--help') return { help: true };
    if (!['--repo', '--ref', '--project', '--task', '--out', '--by', '--qualification', '--allowlist', '--artifact', '--timeout', '--claim-timeout', '--disk-gib', '--profile', '--watch-pid', '--need', '--cores', '--mem-gib'].includes(arg)) throw Error('unknown option ' + arg);
    const value = argv[++i]; if (!value) throw Error('missing value ' + arg);
    if (arg === '--artifact') opts.artifacts.push(value);
    else opts[arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value;
  }
  for (const required of ['repo', 'project', 'task', 'out', 'by', 'command', 'allowlist']) if (!opts[required]) throw Error('--' + required + ' required');
  if (/(?:^|[\s"'])\/[^\s"']*\bxcodebuild\b/.test(opts.command) || /-derivedDataPath\b/.test(opts.command)) {
    throw Error('Xcode commands must use the task xcodebuild wrapper through PATH');
  }
  opts.diskGiB ??= opts.profile==='heavy' || opts.need.split(',').some(cap=>cap!=='cmake-native') ? 16 : 8;
  for (const field of ['timeout', 'diskGiB', ...['cores','memGib'].filter(name=>opts[name]!==undefined)]) if (!Number.isFinite(+opts[field]) || +opts[field] <= 0) throw Error('invalid ' + field);
  if (+opts.timeout > 120) throw Error('mini2 timeout capped at two hours');
  if (!Number.isFinite(+opts.claimTimeout) || +opts.claimTimeout<0 || +opts.claimTimeout>120) throw Error('invalid claim timeout');
  opts.repo = fs.realpathSync(opts.repo); opts.out = path.resolve(opts.out);
  return opts;
}

export async function main(argv) {
  if (argv[0] === 'reconcile') return reconcile(argv.slice(1));
  const opts = args(argv);
  if (opts.help) { console.log('mini2-run.mjs --repo PATH --allowlist JSON --project NAME --task NAME --by HOLDER --out DIR [--ref worktree] [--artifact FILE] [--qualification FILE] -- COMMAND'); return 0; }
  fs.mkdirSync(opts.out, { recursive: true });
  const temp = fs.mkdtempSync(path.join(opts.out, 'snapshot-'));
  const state = { cancel: 0, children: new Set(), values: [] }, runId = randomUUID();
  let lease, clean = false, prepared = false, watch;
  const stop = () => { state.cancel = 143; for (const child of state.children) child('SIGTERM'); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop); process.on('SIGHUP', stop);
  if (opts.watchPid) {
    const pid = Number(opts.watchPid); if (!Number.isInteger(pid) || pid <= 1) throw Error('invalid watched PID');
    watch = setInterval(() => { try { process.kill(pid, 0); } catch { stop(); } }, 1000);
  }
  const ctl = async input => {
    const result = await execute('python3', ['-B', control, ...input], { state, timeout: input[0]==='wait-pool' ? Math.max(30000,(+opts.claimTimeout*60+5)*1000) : 30000,
      cancellable: !['return', 'retain-remote'].includes(input[0]) });
    if (result.code) throw Error(result.stderr || 'mini2 controller failed');
    return result.stdout;
  };
  const evidence = { runId, at: new Date().toISOString(), host: 'Bytedances-Mac-mini.local' };
  const operation = (name, data, options={}) => remote(name,data,{errorFile:path.join(opts.out,'operation-error.log'),...options});
  try {
    // Names first: do not inspect, package or read a sensitive-looking source.
    const git=async arguments_ => {
      const result=await execute('git',['-C',opts.repo,...arguments_],{state});
      if(result.code) throw Error('mini2 source inventory failed');
      return result.stdout;
    };
    const commit=(await git(['rev-parse','--verify','--end-of-options',`${opts.ref==='worktree'?'HEAD':opts.ref}^{commit}`])).trim();
    const entries=(await git(['ls-tree','-rz','--full-tree',commit])).split('\0').filter(Boolean).map(line=>{
      const tab=line.indexOf('\t'); return {name:line.slice(tab+1),mode:line.slice(0,6)};
    });
    const history=(await git(['log','--format=','--name-only','--no-renames','-z',commit])).split('\0').map(name=>name.replace(/^\n+/, '')).filter(Boolean);
    const untracked=opts.ref==='worktree'?(await git(['ls-files','--others','--exclude-standard','-z'])).split('\0').filter(Boolean):[];
    const allowed=JSON.parse(fs.readFileSync(opts.allowlist,'utf8'));
    checkAllowlist(allowed,entries,history,untracked);
    if (opts.ref==='worktree') {
      const index=(await git(['ls-files','--stage','-z'])).split('\0').filter(Boolean).map(line=>{
        const tab=line.indexOf('\t'); return {name:line.slice(tab+1),mode:line.slice(0,6)};
      });
      const changed=(await git(['diff','--name-only','-z','--no-ext-diff','--no-textconv','HEAD'])).split('\0').filter(Boolean);
      checkAllowlist(allowed,index,changed);
      checkWorktree(opts.repo,[...new Set([...index.map(row=>row.name),...changed])]);
    }
    const source = await snapshot(opts, temp, state);
    if (source.extra || source.modules.length) throw Error('Darwin qualification supports tracked source and tracked worktree patches only');
    const bundle = await makeBundle(source, [], state);
    const uploads = { 'source.bundle': bundle, ...(source.patchFile ? { 'worktree.patch': source.patchFile } : {}) };
    evidence.commit = source.commit;
    evidence.uploads = Object.fromEntries(Object.entries(uploads).map(([name,file]) => [name, { bytes: fs.statSync(file).size, sha256: digest(file) }]));
    write(path.join(opts.out, 'upload-list.json'), evidence.uploads);
    await refresh();
    lease = JSON.parse(await ctl(['wait-pool', 'mini2', '--by', opts.by, '--project', opts.project, '--task', opts.task,
      '--for', 'unsigned Darwin build', '--pid', String(process.pid), ...(opts.profile?['--profile', opts.profile]:[]), '--disk-gib', String(opts.diskGiB),
      '--timeout',String(opts.claimTimeout),
      '--need', opts.need, ...['cores','memGib'].flatMap(name=>opts[name]===undefined?[]:[name==='cores'?'--cores':'--mem-gib',String(opts[name])]), ...(opts.qualification ? ['--qualification', opts.qualification] : [])])).lease;
    await ctl(['bind', lease.slot, '--by', opts.by, '--generation', lease.generation, '--run-id', runId]);
    const data = { runId, slot: lease.slot, dynamic: lease.dynamic, limits: lease.limits, cores: lease.weights[0], commit: source.commit, command: opts.command, diskGiB: +opts.diskGiB, timeoutSec: +opts.timeout*60,
      uploads: Object.fromEntries(Object.entries(evidence.uploads).map(([name, value]) => [name, value.sha256])) };
    write(path.join(opts.out, 'intent.json'), { ...data, lease });
    const syncStart = performance.now();
    prepared = true; // Lost prepare replies must retain the hold too.
    await operation('prepare', data, { state });
    for (const [file, inputFile] of Object.entries(uploads)) await operation('receive', { ...data, file }, { state, inputFile, timeout: 600000 });
    evidence.syncSec = (performance.now()-syncStart)/1000;
    const operationLog = path.join(opts.out, 'operation.log');
    try { await operation('execute', data, { state, outputFile: operationLog, timeout: (+opts.timeout*60+90)*1000 }); }
    finally { if (fs.existsSync(operationLog)) redactLogFile(operationLog, { force: true }); }
    const terminal = JSON.parse(await operation('collect', { runId, artifacts: [] }));
    evidence.receipt = terminal.receipt;
    const result = terminal.receipt.exit === 0 ? JSON.parse(await operation('collect', { runId, artifacts: opts.artifacts })) : terminal;
    evidence.artifacts = result.artifacts;
    const log = path.join(opts.out, 'build.log');
    try { await operation('fetch', { runId, file: 'build.log' }, { outputFile: log }); }
    finally { if (fs.existsSync(log)) redactLogFile(log, { force: true }); }
    for (const artifact of result.artifacts) {
      const file = path.join(opts.out, 'artifacts', artifact.path);
      if (path.relative(path.join(opts.out, 'artifacts'), file).startsWith('..')) throw Error('invalid retained artifact');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      await operation('fetch', { runId, file: 'work/' + artifact.path }, { outputFile: file, strictOutput: false });
      if (fs.statSync(file).size !== artifact.size || digest(file) !== artifact.sha256) throw Error('artifact identity mismatch');
    }
    const receipt = JSON.parse(await operation('clean', { runId, artifactsVerified: true }));
    if (receipt.runId !== runId || receipt.clean !== true) throw Error('cleanup receipt mismatch');
    write(path.join(opts.out, 'clean.json'), { ...receipt, generation: lease.generation });
    await ctl(['return', lease.slot, '--by', opts.by, '--receipt', path.join(opts.out, 'clean.json')]);
    clean = true;
    return evidence.receipt.exit;
  } catch (error) {
    evidence.error = error.message;
    console.error('mini2-run: ' + error.message);
    return 1;
  } finally {
    if (lease && !clean && !evidence.receipt) {
      try {
        const receipt = prepared ? JSON.parse(await remote('clean', { runId, artifactsVerified: false })) : { runId, clean: true, neverDispatched: true };
        if (receipt.runId !== runId || !receipt.clean) throw Error('cleanup mismatch');
        write(path.join(opts.out, 'clean.json'), { ...receipt, generation: lease.generation });
        await ctl(['return', lease.slot, '--by', opts.by, '--receipt', path.join(opts.out, 'clean.json')]);
        clean = true;
      } catch { /* Remote intent remains owned until explicit reconciliation. */ }
    }
    if (lease && !clean) {
      // Even a missing launch/receipt remains owned. No timeout reclaims it.
      await ctl(['retain-remote', lease.slot, '--by', opts.by, '--note', `run=${runId} prepared=${prepared}; cleanup unconfirmed`]).catch(() => {});
    }
    evidence.clean = clean; write(path.join(opts.out, 'summary.json'), evidence);
    clearInterval(watch); process.off('SIGTERM', stop); process.off('SIGINT', stop); process.off('SIGHUP', stop);
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

export async function reconcile(argv) {
  if (argv.length !== 4 || argv[0] !== '--out' || argv[2] !== '--by') throw Error('reconcile --out DIR --by HOLDER required');
  const out=path.resolve(argv[1]), by=argv[3];
  const intent=JSON.parse(fs.readFileSync(path.join(out,'intent.json'),'utf8'));
  const summary=JSON.parse(fs.readFileSync(path.join(out,'summary.json'),'utf8'));
  if (intent.lease.by !== by || intent.runId !== summary.runId) throw Error('reconciliation identity mismatch');
  const terminal=JSON.parse(await remote('collect',{runId:intent.runId,artifacts:[]}));
  const log=path.join(out,'build.log');
  try { await remote('fetch',{runId:intent.runId,file:'build.log'},{outputFile:log}); }
  finally { if(fs.existsSync(log)) redactLogFile(log,{force:true}); }
  if (terminal.receipt.exit === 0) {
    if (!Array.isArray(summary.artifacts)) throw Error('artifact retention incomplete');
    for (const artifact of summary.artifacts) {
      const file=path.resolve(out,'artifacts',artifact.path);
      if (!file.startsWith(path.join(out,'artifacts')+path.sep) || digest(file)!==artifact.sha256) throw Error('artifact retention mismatch');
    }
  }
  const receipt=JSON.parse(await remote('reconcile',{runId:intent.runId,artifactsVerified:true}));
  if(receipt.runId!==intent.runId || receipt.clean!==true) throw Error('cleanup receipt mismatch');
  const file=path.join(out,'reconciled.json'); write(file,{...receipt,generation:intent.lease.generation});
  const result=await execute('python3',['-B',control,'return',intent.lease.slot || 'mini2-exec-1','--by',by,'--receipt',file]);
  if(result.code) throw Error('lease return failed');
  write(path.join(out,'summary.json'),{...summary,clean:true,reconciled:true});
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(error => { console.error(error.message); process.exitCode=1; });
}
