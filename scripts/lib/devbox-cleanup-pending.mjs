export const cleanupEvidencePython = `import re, subprocess, shutil
root=pathlib.Path(d['root']); ctl=pathlib.Path(d['control']); run=ctl.name
if not re.fullmatch(r'[0-9a-f-]{36}',run) or ctl.parent!=root/'runs' or ctl.is_symlink() or not ctl.resolve().is_relative_to(root.resolve()/'runs'):
    raise RuntimeError('cleanup pending receipt outside runner root')
if not ctl.is_dir(): raise RuntimeError('cleanup pending receipt unavailable; cannot confirm')
count=0; units=0; deadline=time.monotonic()+5
for name in ['owner.json','group.json']:
    file=ctl/name
    if not file.exists(): continue
    record=json.loads(file.read_text())
    if record.get('run')!=run: raise RuntimeError('cleanup pending run identity mismatch')
    try:
        fields=pathlib.Path('/proc/'+str(record['pid'])+'/stat').read_text().rsplit(')',1)[1].split()
        if fields[0]!='Z' and fields[19]==record['start']: count+=1
    except FileNotFoundError: pass
listing=subprocess.run(['ps','-axo','pid=,state=,args='],capture_output=True,text=True,timeout=2)
if listing.returncode: raise RuntimeError('cleanup pending process probe unavailable')
pattern=re.compile(r'(?<![a-zA-Z0-9-])'+re.escape(run)+r'(?![a-zA-Z0-9-])')
for line in listing.stdout.splitlines():
    fields=line.strip().split(None,2)
    if len(fields)==3 and fields[0].isdigit() and int(fields[0])!=os.getpid() and not fields[1].startswith('Z') and pattern.search(fields[2]): count+=1
if shutil.which('systemctl') and pathlib.Path('/run/systemd/system').is_dir():
    scopes=[[]]
    if pathlib.Path('/run/user/'+str(os.getuid())+'/bus').exists(): scopes.append(['--user'])
    for scope in scopes:
        if time.monotonic()>=deadline: raise RuntimeError('cleanup pending probe deadline')
        result=subprocess.run(['systemctl',*scope,'list-units','--state=active,activating,deactivating','--no-pager','--plain','--no-legend'],capture_output=True,text=True,timeout=max(.01,min(2,deadline-time.monotonic())))
        if result.returncode: raise RuntimeError('cleanup pending unit probe unavailable')
        units+=sum(bool(pattern.search(line.split()[0])) for line in result.stdout.splitlines() if line.split())
print(json.dumps({'clean':count==0 and units==0,'count':count,'units':units,'run':run}))
`;
