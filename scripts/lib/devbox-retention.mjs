// Only runner-owned artifact payloads are retired; source worktrees and run logs remain.
export const retentionPython = `import fcntl, hashlib, math, re, shutil
def artifact_control(root,run):
    root=pathlib.Path(root); ctl=root/'runs'/run
    if not re.fullmatch(r'[0-9a-f-]{36}',run) or ctl.is_symlink() or not ctl.resolve().is_relative_to(root.resolve()/'runs'):
        raise RuntimeError('invalid artifact receipt root/UUID')
    return ctl
def payload_bytes(ctl):
    total=0
    for target in [ctl/'artifacts',ctl/'artifact-archive.tar']:
        if target.is_symlink(): raise RuntimeError('retained payload symlink refused')
        files=target.rglob('*') if target.is_dir() else [target]
        for file in files:
            if file.is_symlink(): raise RuntimeError('retained payload symlink refused')
            if file.is_file(): total+=file.stat().st_size
    return total
def retention_record(ctl):
    record={}
    for name in ['artifact-retention.json','artifact-manifest.json','artifact-archive.json']:
        file=ctl/name
        if file.is_symlink(): raise RuntimeError('retained receipt symlink refused')
        if file.is_file():
            record=json.loads(file.read_text()); break
    if record.get('run',ctl.name)!=ctl.name: raise RuntimeError('retained UUID mismatch')
    created=record.get('createdAt',ctl.stat().st_mtime)
    expires=record.get('expiresAt',created+24*3600)
    if not all(isinstance(v,(int,float)) and math.isfinite(v) for v in [created,expires]): raise RuntimeError('invalid retention expiry')
    return {**record,'run':ctl.name,'createdAt':created,'expiresAt':expires,'bytes':payload_bytes(ctl)}
def retained_inventory(root):
    runs=pathlib.Path(root)/'runs'
    return [retention_record(artifact_control(root,ctl.name)) for ctl in sorted(runs.iterdir())
            if re.fullmatch(r'[0-9a-f-]{36}',ctl.name) and ctl.is_dir()] if runs.is_dir() else []
def active_receipt(ctl):
    for name in ['owner.json','group.json']:
        file=ctl/name
        if not file.exists(): continue
        record=json.loads(file.read_text())
        if record.get('run')!=ctl.name: raise RuntimeError('retirement owner UUID mismatch')
        try:
            fields=pathlib.Path('/proc/'+str(record['pid'])+'/stat').read_text().rsplit(')',1)[1].split()
            if fields[0]!='Z' and fields[19]==record['start']: return True
        except FileNotFoundError: pass
    return False
def retire_payload(ctl):
    with (ctl/'.artifacts.lock').open('a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX)
        if active_receipt(ctl): raise RuntimeError('retained receipt still has live processes')
        total=payload_bytes(ctl)
        target=ctl/'artifacts'
        if target.exists(): shutil.rmtree(target)
        for name in ['artifact-archive.tar','artifact-archive.json','artifact-manifest.json','artifact-retention.json']:
            (ctl/name).unlink(missing_ok=True)
        return total
def expire_payloads(root):
    total=0
    for record in retained_inventory(root):
        if record['expiresAt']>time.time(): continue
        ctl=artifact_control(root,record['run'])
        if active_receipt(ctl): continue
        total+=retire_payload(ctl)
    return total
def begin_retention(d):
    ctl=artifact_control(d['root'],pathlib.Path(d['control']).name)
    hours=d.get('retainHours',24)
    if not isinstance(hours,(int,float)) or not 0<hours<=72: raise RuntimeError('retention must be >0 and <=72 hours')
    created=time.time()
    record={'version':1,'run':ctl.name,'slot':d['slot'],'host':d['host'],'commit':d['commit'],
            'createdAt':created,'expiresAt':created+hours*3600,'retainHours':hours}
    file=ctl/'artifact-retention.json'; temporary=ctl/'artifact-retention.tmp'
    temporary.write_text(json.dumps(record)); temporary.replace(file)
    return record
`;
