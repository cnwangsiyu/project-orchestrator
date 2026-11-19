import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export async function fileDigest(file) {
  const hash = createHash('sha256');
  for await (const bytes of fs.createReadStream(file)) hash.update(bytes);
  return hash.digest('hex');
}

export function artifactName(name) {
  return typeof name === 'string' && name.length > 0 && !path.posix.isAbsolute(name)
    && !name.includes('\\') && !/[\x00-\x1f\x7f]/.test(name)
    && name.split('/').every(part => part && part !== '.' && part !== '..');
}

export function readArtifactManifest(file, name, rows) {
  const receipt = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (receipt.version !== 1 || !/^[0-9a-f-]{36}$/.test(receipt.run || '')
      || !/^[a-f0-9]{40,64}$/.test(receipt.commit || '') || !Array.isArray(receipt.artifacts)
      || !receipt.control?.startsWith('/') || receipt.control.includes('\0')
      || receipt.control.split('/').includes('..') || !receipt.control.endsWith('/runs/' + receipt.run))
    throw Error('invalid artifact manifest');
  const row = rows.find(row => row.slot === receipt.slot && row.host === receipt.host);
  if (!row?.target) throw Error('artifact host/slot is no longer registered and open');
  if (!artifactName(name)) throw Error('invalid artifact name');
  const selected = receipt.artifacts.filter(item => item.name === name);
  if (selected.length !== 1 || !Number.isSafeInteger(selected[0].size) || selected[0].size < 0
      || !/^[a-f0-9]{64}$/.test(selected[0].sha256 || '')) throw Error('artifact is missing or invalid in manifest');
  return { receipt, artifact: selected[0], row };
}

export const retainedArtifactPython = `import hashlib, stat
root=pathlib.Path(d['root']).resolve(); ctl=pathlib.Path(d['control'])
if ctl.parent!=pathlib.Path(d['root'])/'runs' or ctl.name!=d['run'] or ctl.is_symlink() or not ctl.resolve().is_relative_to(root/'runs'):
    raise RuntimeError('artifact receipt outside runner root')
receipt=json.loads((ctl/'artifact-manifest.json').read_text())
if receipt['run']!=d['run'] or receipt['commit']!=d['commit'] or receipt['slot']!=d['slot']:
    raise RuntimeError('artifact receipt identity mismatch')
matches=[item for item in receipt['artifacts'] if item['name']==d['artifact']['name']]
if len(matches)!=1 or matches[0]!=d['artifact']: raise RuntimeError('artifact receipt differs from requested manifest')
name=d['artifact']['name']; parts=name.split('/')
if name.startswith('/') or any(part in ('','..','.') for part in parts): raise RuntimeError('invalid artifact name')
target=ctl/'artifacts'
for part in parts:
    target=target/part
    if target.is_symlink(): raise RuntimeError('artifact symlink refused')
fd=os.open(target,os.O_RDONLY|os.O_NOFOLLOW)
with os.fdopen(fd,'rb') as stream:
    info=os.fstat(stream.fileno())
    if not stat.S_ISREG(info.st_mode) or info.st_size!=d['artifact']['size']: raise RuntimeError('artifact size/type changed')
    h=hashlib.sha256()
    while True:
        chunk=stream.read(1048576)
        if not chunk: break
        h.update(chunk); sys.stdout.buffer.write(chunk)
    if h.hexdigest()!=d['artifact']['sha256']: raise RuntimeError('artifact digest changed')
`;

export const artifactRangePython = `import stat
root=pathlib.Path(d['root']).resolve(); ctl=pathlib.Path(d['control'])
if ctl.parent!=pathlib.Path(d['root'])/'runs' or ctl.is_symlink() or not ctl.resolve().is_relative_to(root/'runs'):
    raise RuntimeError('archive receipt outside runner root')
receipt=json.loads((ctl/'artifact-archive.json').read_text())
if receipt['run']!=ctl.name or receipt['commit']!=d['commit'] or receipt['slot']!=d['slot'] or receipt['sha256']!=d['sha256']:
    raise RuntimeError('archive receipt identity mismatch')
offset=d['offset']; length=d['length']
if not isinstance(offset,int) or not isinstance(length,int) or offset<0 or length<=0 or offset+length>receipt['size']:
    raise RuntimeError('archive range outside file')
fd=os.open(ctl/'artifact-archive.tar',os.O_RDONLY|os.O_NOFOLLOW)
with os.fdopen(fd,'rb') as stream:
    info=os.fstat(stream.fileno())
    if not stat.S_ISREG(info.st_mode) or info.st_size!=receipt['size']: raise RuntimeError('archive size/type changed')
    stream.seek(offset)
    while length:
        chunk=stream.read(min(length,1048576))
        if not chunk: raise RuntimeError('archive truncated')
        sys.stdout.buffer.write(chunk); length-=len(chunk)
`;
