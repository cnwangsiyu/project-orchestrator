// Input placement is local planning; res remains the lease and admission authority.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const identifier = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,100}$/;
const digest = /^(?:none|[a-f0-9]{64})$/;
export function duration(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 86400) return value;
  const match = /^(\d+(?:\.\d+)?)(s|m|h)$/.exec(value || '');
  if (!match) throw Error('input cost must be a duration such as 45s or 27m');
  const seconds = Number(match[1]) * { s: 1, m: 60, h: 3600 }[match[2]];
  if (seconds > 86400) throw Error('input cost exceeds one day');
  return seconds;
}
export function parseInput(value) {
  if (typeof value === 'string') {
    const fields=value.split(/,(?=[a-z]+=)/).map(field=>field.slice(0,field.indexOf('=')));
    if(new Set(fields).size!==fields.length) throw Error('duplicate input field');
  }
  const raw = typeof value === 'string' ? Object.fromEntries(value.split(/,(?=[a-z]+=)/).map(field => {
    const at = field.indexOf('='); if (at < 1) throw Error('input needs key=value fields');
    return [field.slice(0, at), field.slice(at + 1)];
  })) : value;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(key => !['name','hash','rebuildable','cost','size','seed','path'].includes(key))) throw Error('invalid input manifest');
  const { name, hash, seed, path: inputPath } = raw;
  if (!identifier.test(name || '') || name.startsWith('warm.')) throw Error('invalid input name');
  if (!digest.test(hash || '')) throw Error('input hash needs sha256 or none');
  if (!['yes','no',true,false].includes(raw.rebuildable)) throw Error('input rebuildable needs yes or no');
  const rebuildable = raw.rebuildable === 'yes' || raw.rebuildable === true;
  const costSec = duration(raw.cost), sizeGiB = Number(raw.size);
  if (!Number.isFinite(sizeGiB) || sizeGiB < 0 || sizeGiB > 65536) throw Error('input size needs non-negative GiB');
  if (seed !== undefined && (typeof seed !== 'string' || !seed.trim() || !rebuildable || hash === 'none' || sizeGiB <= 0)) throw Error('seeding requires rebuildable input and sha256');
  if (inputPath !== undefined && (typeof inputPath !== 'string' || !inputPath.startsWith('/') || inputPath.includes('\0') || inputPath.split('/').includes('..'))) throw Error('input path needs an absolute remote path');
  return { name, hash, rebuildable, costSec, sizeGiB, ...(seed ? { seed } : {}), ...(inputPath ? { path: inputPath } : {}) };
}
export function manifest(values) {
  const inputs = values.map(parseInput);
  if (new Set(inputs.map(input => input.name)).size !== inputs.length) throw Error('duplicate input name');
  return inputs;
}
export const inputKey = input => `${input.name}+${input.hash}`;
export const indexFile = (root, host) => path.join(root, 'devbox-inputs', `${host}.json`);
export function readIndex(root, host) {
  try {
    const value = JSON.parse(fs.readFileSync(indexFile(root, host), 'utf8'));
    if (value.version !== 1 || !value.inputs || typeof value.inputs !== 'object' || Array.isArray(value.inputs)) throw Error('invalid input index');
    return value;
  } catch (error) { if (error.code === 'ENOENT') return { version: 1, inputs: {} }; throw error; }
}
export function inputSettings(root) {
  const defaults = { enabled: true, ttlSec: 300, maxWaitSec: 2700, seedMaxSec: 300 };
  let text;
  try {
    const fd = fs.openSync(path.join(root, 'machine.conf'), fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    try { if (!fs.fstatSync(fd).isFile()) throw Error('machine.conf must be regular'); text = fs.readFileSync(fd,'utf8'); }
    finally { fs.closeSync(fd); }
  } catch (error) { if (error.code === 'ENOENT') return defaults; throw error; }
  if (!text.endsWith('\n')) throw Error('incomplete machine.conf');
  const names = { DEVBOX_REBUILD_PLACEMENT: 'enabled', DEVBOX_INPUT_TTL_SECONDS: 'ttlSec', DEVBOX_INPUT_WAIT_CAP_SECONDS: 'maxWaitSec', DEVBOX_INPUT_SEED_MAX_SECONDS: 'seedMaxSec' };
  const seen = new Set();
  for (const line of text.split('\n')) {
    const at = line.indexOf('='); const key = line.slice(0,at).trim(); if (!names[key]) continue;
    const value = line.slice(at+1).trim();
    if (seen.has(key) || !/^\d+$/.test(value) || (key === 'DEVBOX_REBUILD_PLACEMENT' ? Number(value)>1 : Number(value)<1 || Number(value)>86400)) throw Error(`invalid ${key}`);
    seen.add(key); defaults[names[key]] = key === 'DEVBOX_REBUILD_PLACEMENT' ? value === '1' : Number(value);
  }
  return defaults;
}
export function median(values) {
  const sorted = values.filter(value => Number.isFinite(value) && value >= 0).toSorted((a,b) => a-b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length/2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle-1]+sorted[middle])/2;
}
export function observedCost(input, history) {
  const samples = history?.inputs?.[inputKey(input)] || [];
  return samples.length >= 3 ? median(samples) : input.costSec;
}
export function warmCost(history, declared) {
  const cold = median(history?.cold || []), warm = median(history?.warm || []);
  if (declared !== undefined && ((history?.cold?.length || 0)<3 || (history?.warm?.length || 0)<3)) return declared;
  return cold !== null && warm !== null ? Math.max(0, cold - warm) : declared;
}
export function warmInput(project, repoId, affinity, costSec) {
  return { name: 'warm.' + createHash('sha256').update(JSON.stringify([project, repoId, affinity])).digest('hex'), hash: 'none', rebuildable: true, costSec, sizeGiB: 0, warm: true };
}
export function placement(rows, inputs, indices, history = {}, { now = Date.now()/1000, ttlSec = 300, maxWaitSec = 2700, holds = {}, durations = {} } = {}) {
  return rows.map(row => {
    const missing = inputs.filter(input => {
      const entry = indices[row.host]?.inputs?.[inputKey(input) + (input.warm ? '+' + row.slot : '')];
      return !entry || !Number.isFinite(entry.verifiedAt) || entry.verifiedAt > now || now-entry.verifiedAt >= ttlSec;
    });
    const hardReasons = missing.filter(input => !input.rebuildable).map(input => `missing non-rebuildable input ${input.name}`);
    const hold = holds[row.slot];
    const waitSec = hold ? Math.min(maxWaitSec, Math.max(60, (durations[row.slot] || hold.durationSec || 300) - Math.max(0,now-Number(hold.start || now)))) : 0;
    const rebuildSec = missing.reduce((sum,input) => sum+observedCost(input,history),0);
    return { slot: row.slot, host: row.host, waitSec, rebuildSec, totalSec: waitSec+rebuildSec, eligible: !hardReasons.length, hardReasons, missing: missing.map(input => input.name) };
  });
}
// Directories hash sorted relative UTF-8 names, file sizes and bytes; files hash their bytes.
export async function fingerprint(file) {
  const hash = createHash('sha256'); let bytes = 0; const files=[];
  const collect = (target, relative = '') => {
    if (path.resolve(target).split(path.sep).some(part => /^(?:login|cookies?|sessions?|\.netrc|\.npmrc|\.pypirc|\.ssh|\.aws|\.kube|\.env(?:\..*)?|\.git)$/i.test(part) || /\.(?:pem|p12|pfx|key|keystore)$/i.test(part))) throw Error('input path contains private state');
    const stat=fs.lstatSync(target);
    if(stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw Error('input must contain only regular files/directories');
    if(stat.isDirectory()) for(const name of fs.readdirSync(target)) collect(path.join(target,name),relative ? `${relative}/${name}` : name);
    else files.push({target,relative,size:stat.size});
  };
  collect(file);
  files.sort((a,b)=>Buffer.compare(Buffer.from(a.relative),Buffer.from(b.relative)));
  for(const item of files) {
    if(item.relative) hash.update(`${item.relative}\n${item.size}\n`);
    for await(const chunk of fs.createReadStream(item.target)){hash.update(chunk);bytes+=chunk.length;}
  }
  return {hash:hash.digest('hex'),bytes};
}

export const inputPython = `import hashlib
root=pathlib.Path(d['root'])
private={'login','cookies','cookie','session','sessions','.netrc','.npmrc','.pypirc','.ssh','.aws','.kube','.env','.git'}
def safe(p):
    p=pathlib.Path(p)
    if not p.is_absolute() or '..' in p.parts or any(part.lower() in private or part.lower().startswith('.env.') or part.lower().endswith(('.pem','.p12','.pfx','.key','.keystore')) for part in p.parts):
        raise RuntimeError('input path contains private state')
    # The workspace root itself may be a symlink (a relocated workspace); only refuse links below it.
    for parent in [p,*p.parents]:
        if parent==root: break
        if parent.is_symlink(): raise RuntimeError('input symlink refused: '+str(parent))
    return p
def fingerprint(p):
    h=hashlib.sha256(); size=0
    files=sorted(p.rglob('*'),key=lambda f:f.relative_to(p).as_posix()) if p.is_dir() else [p]
    for file in files:
        safe(file)
        if file.is_dir(): continue
        if not file.is_file(): raise RuntimeError('input contains special file')
        if p.is_dir(): h.update((file.relative_to(p).as_posix()+'\\n'+str(file.stat().st_size)+'\\n').encode())
        with file.open('rb') as stream:
            while True:
                chunk=stream.read(1048576)
                if not chunk: break
                h.update(chunk); size+=len(chunk)
    return h.hexdigest(),size
records=[]
for item in d['inputs']:
    target=safe(item['path']); valid=target.exists(); size=0
    if valid and item.get('warm'):
        meta=target/'.devbox-run.json'
        metadata=json.loads(meta.read_text()) if meta.is_file() else {}
        valid=(metadata.get('affinity')==d['affinity'] or not metadata.get('affinity') and item.get('legacyAffinityAt') and metadata.get('lastUsed',1e30)<=item['legacyAffinityAt']+1)
    elif valid and item['hash']!='none':
        actual,size=fingerprint(target); valid=actual==item['hash']
    elif valid:
        size=sum(f.stat().st_size for f in target.rglob('*') if f.is_file()) if target.is_dir() else target.stat().st_size
    if valid and not item.get('warm') and item['sizeGiB']>0:
        valid=size<=item['sizeGiB']*1073741824
    records.append({'key':item['key'],'present':valid,'path':str(target),'bytes':size})
print(json.dumps(records))
`;
export const seedPython = inputPython.slice(0,inputPython.indexOf('records=[]')) + `import tarfile, tempfile, shutil
root=pathlib.Path(d['root']); target=pathlib.Path(d['path'])
if not target.is_relative_to(root/'inputs') or target.is_symlink(): raise RuntimeError('seed destination outside input store')
target.parent.mkdir(parents=True,exist_ok=True)
with tempfile.TemporaryDirectory(dir=target.parent) as staging:
    staging=pathlib.Path(staging)
    with tarfile.open(fileobj=sys.stdin.buffer,mode='r|') as archive:
        for member in archive:
            parts=pathlib.PurePosixPath(member.name).parts
            if not parts or parts[0]!='content' or member.name.startswith('/') or '..' in parts or not (member.isfile() or member.isdir()):
                raise RuntimeError('seed archive member refused')
            archive.extract(member,staging)
    actual,size=fingerprint(staging/'content')
    if actual!=d['hash'] or size>d['sizeGiB']*1073741824: raise RuntimeError('seed hash/size mismatch')
    # BC-148: another shard may have seeded the same input meanwhile; an identical target is success.
    if target.exists():
        existing,_=fingerprint(target)
        if existing!=d['hash']: raise RuntimeError('seed target exists with different content; use a new hash')
    else:
        try: (staging/'content').rename(target)
        except OSError:
            existing,_=fingerprint(target)
            if existing!=d['hash']: raise
`;
