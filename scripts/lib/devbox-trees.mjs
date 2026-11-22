import fs from 'node:fs';
import path from 'node:path';

// Runner-only settings: res ignores these forward-compatible machine.conf names.
export function treeSettings(dir) {
  let text;
  try {
    const fd = fs.openSync(path.join(dir, 'machine.conf'), fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    try {
      if (!fs.fstatSync(fd).isFile()) throw Error('machine.conf must be regular');
      text = fs.readFileSync(fd, 'utf8');
    } finally { fs.closeSync(fd); }
  } catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
  const fields = new Map();
  for (const line of text.split('\n')) {
    if (!/^\s*DEVBOX_(?:TREE_|EXTRA_ROOTS)/.test(line)) continue;
    const match = /^\s*(DEVBOX_(?:TREE_PLACEMENT|EXTRA_ROOTS|TREE_PRIMARY_FLOOR_GIB|TREE_SECONDARY_FLOOR_GIB|TREE_RESERVE_GIB|TREE_COLD_DAYS)\.([0-9.]+))\s*=\s*(.*?)\s*$/.exec(line);
    if (!match || fields.has(match[1])) throw Error('invalid or duplicate devbox tree setting');
    fields.set(match[1], match[3]);
  }
  if (!fields.size) return {};
  if (!text.endsWith('\n')) throw Error('incomplete devbox tree settings');
  const result = {};
  for (const [name, value] of fields) {
    if (!name.startsWith('DEVBOX_TREE_PLACEMENT.')) continue;
    if (!['0', '1'].includes(value)) throw Error('invalid DEVBOX_TREE_PLACEMENT');
    if (value === '0') continue;
    const host = name.slice('DEVBOX_TREE_PLACEMENT.'.length);
    if (!/^(?:\d{1,3}\.){3}\d{1,3}$/.test(host) || host.split('.').some(n => Number(n) > 255)) throw Error('invalid tree host');
    const number = (key, fallback, min = 0) => {
      const raw = fields.get(`DEVBOX_TREE_${key}.${host}`);
      const n = raw === undefined ? fallback : Number(raw);
      if (raw === '' || !Number.isFinite(n) || n < min || n > 65536) throw Error(`invalid DEVBOX_TREE_${key}`);
      return n;
    };
    const raw = fields.get(`DEVBOX_EXTRA_ROOTS.${host}`);
    const roots = raw ? raw.split(',') : [];
    if (roots.length > 8 || new Set(roots).size !== roots.length || roots.some(root => !/^\/[A-Za-z0-9_./-]+$/.test(root)
        || root === '/' || path.posix.normalize(root) !== root || root.split('/').some(part => ['.', '..', '.ssh', '.claude', '.env'].includes(part))))
      throw Error('invalid DEVBOX_EXTRA_ROOTS');
    result[host] = { extraRoots: roots, primaryFloorGiB: Math.max(53, number('PRIMARY_FLOOR_GIB', 53)),
      secondaryFloorGiB: number('SECONDARY_FLOOR_GIB', 20, 1), reserveGiB: number('RESERVE_GIB', 20), coldDays: number('COLD_DAYS', 3, 1) };
  }
  return result;
}

export function treePreference(rows, inventory, project, store, preferredHost) {
  const candidates = rows.filter(row => !preferredHost || row.host === preferredHost).map(row => {
    const trees = inventory[row.host] || [];
    const own = trees.filter(tree => tree.slot === row.slot);
    const warm = own.filter(tree => tree.project === project && tree.store === store);
    return { ...row, rank: warm.length ? 0 : own.length ? 2 : 1,
      lastUsed: Math.max(0, ...(warm.length ? warm : own).map(tree => tree.lastUsed)) };
  });
  candidates.sort((a, b) => a.rank - b.rank || (a.rank === 0 ? b.lastUsed - a.lastUsed : a.lastUsed - b.lastUsed)
    || a.slot.localeCompare(b.slot, undefined, { numeric: true }));
  const best = candidates[0];
  return best && { slot: best.slot, host: best.host, reason: best.rank === 0 ? 'warm project/repository tree (newest first)'
    : best.rank === 1 ? 'empty slot tree inventory' : 'least recently used slot', lastUsed: best.lastUsed };
}

// Shared by opt-in runner operations and the owner-only eviction entry point.
export const treePython = String.raw`
import fcntl, re, subprocess, tempfile, math
TREE_GIB=1073741824
def tree_roots(d):
    primary=pathlib.Path(d['root']); config=d['treeConfig']
    roots=[(primary,config['primaryFloorGiB'])]+[(pathlib.Path(p),config['secondaryFloorGiB']) for p in config['extraRoots']]
    for p,floor in roots:
        if not p.is_absolute() or '..' in p.parts or str(p)=='/' or p.resolve()!=p: raise RuntimeError('unsafe registered tree root')
    for i,(p,_) in enumerate(roots):
        if any(p==q or p.is_relative_to(q) or q.is_relative_to(p) for q,_ in roots[:i]): raise RuntimeError('overlapping registered tree roots')
    return roots

def tree_scope(root,ws):
    try: parts=ws.relative_to(root).parts
    except ValueError: return False
    return (len(parts)==4 and parts[0]=='wt' and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,100}',parts[1])
            and re.fullmatch(r'id-[A-Za-z0-9_.-]+',parts[2]) and re.fullmatch(r'devbox-cn-(?:[0-9]+|light(?:-[0-9]+)?|[A-Za-z0-9][A-Za-z0-9_.-]*-[1-9][0-9]*)',parts[3])
            and ws.resolve()==ws and not any(p.is_symlink() for p in [ws,*ws.parents]))

def tree_list(d):
    rows=[]; primary=pathlib.Path(d['root'])
    for root,floor in tree_roots(d):
        for meta in (root/'wt').glob('*/id-*/*/.devbox-run.json'):
            ws=meta.parent
            if not tree_scope(root,ws) or meta.is_symlink() or not (ws/'.git').is_file() or (ws/'.git').is_symlink(): continue
            if d.get('slots') is not None and ws.name not in d['slots']: continue
            try:
                row=json.loads(meta.read_text()); project,store=ws.parts[-3:-1]
                repository=primary/'repos'/project/store
                used=row.get('lastUsed')
                if row.get('slot')!=ws.name or row.get('repository')!=str(repository) or not isinstance(used,(int,float)) or not math.isfinite(used) or used<0 or used>time.time()+1: continue
                rows.append({'slot':ws.name,'project':project,'store':store,'workspace':str(ws),'repository':str(repository),
                             'treeRoot':str(root),'floorGiB':floor,'lastUsed':used})
            except (OSError,ValueError,TypeError): continue
    return rows

def tree_map_read(primary):
    file=primary/'wt-map.json'
    if file.is_symlink(): raise RuntimeError('tree map symlink')
    if not file.exists(): return {'version':1,'slots':{}}
    record=json.loads(file.read_text())
    if record.get('version')!=1 or not isinstance(record.get('slots'),dict): raise RuntimeError('invalid tree map')
    return record

def tree_map_write(primary,record):
    fd,name=tempfile.mkstemp(prefix='.wt-map-',suffix='.tmp',dir=primary)
    try:
        with os.fdopen(fd,'w') as output:
            json.dump(record,output); output.flush(); os.fsync(output.fileno())
        os.replace(name,primary/'wt-map.json')
    finally:
        if os.path.exists(name): os.unlink(name)

def tree_lock(file):
    fd=os.open(file,os.O_WRONLY|os.O_CREAT|os.O_NOFOLLOW,0o600)
    stream=os.fdopen(fd,'w'); fcntl.flock(stream,fcntl.LOCK_EX)
    return stream

def tree_backing_device(root):
    # Probe an existing ancestor; new secondary runner directories need not exist yet.
    while not root.exists(): root=root.parent
    dev=root.stat().st_dev
    device=pathlib.Path('/sys/dev/block/%s:%s'%(os.major(dev),os.minor(dev))).resolve()
    if (device/'partition').exists(): device=device.parent
    return device if (device/'stat').is_file() else None

def tree_disk_sample(roots):
    devices={}; before={}
    for root,_ in roots:
        try:
            device=tree_backing_device(root); devices[str(root)]=device
            if device is not None: before[str(device)]=int((device/'stat').read_text().split()[9])
        except (OSError,ValueError,IndexError): devices[str(root)]=None
    if not before: return {}
    started=time.monotonic(); time.sleep(1); elapsed=time.monotonic()-started; result={}
    for root,_ in roots:
        device=devices.get(str(root))
        if device is None: continue
        try:
            delta=int((device/'stat').read_text().split()[9])-before[str(device)]
            if delta>=0: result[str(root)]={'device':device.name,'busyMs':delta,'sampleSec':elapsed,'busyFraction':min(1,delta/(elapsed*1000))}
        except (OSError,ValueError,IndexError,KeyError): pass
    return result

def tree_filesystem(root):
    while not root.exists(): root=root.parent
    return root.stat().st_dev

def tree_scores(d):
    roots=tree_roots(d); io=tree_disk_sample(roots); rows=[]
    devices={str(root):tree_filesystem(root) for root,_ in roots}
    floors={}; reservations={}
    for root,floor in roots:
        device=devices[str(root)]
        floors[device]=max(floors.get(device,0),floor)
        reservations[device]=reservations.get(device,0)+d.get('treeReservations',{}).get(str(root),0)
    # If any backing device is unknown, compare all roots using space alone.
    complete=all(str(root) in io for root,_ in roots)
    for root,floor in roots:
        ancestor=root
        while not ancestor.exists(): ancestor=ancestor.parent
        disk=os.statvfs(ancestor); free=disk.f_bavail*disk.f_frsize/TREE_GIB
        floor=floors[devices[str(root)]]; reserved=reservations[devices[str(root)]]
        surplus=max(0,free-floor-reserved); headroom=1-io[str(root)]['busyFraction'] if complete else 1
        rows.append({'root':str(root),'freeGiB':free,'floorGiB':floor,'reserveGiB':d['treeConfig']['reserveGiB'],
                     'reservedGiB':reserved,'surplusGiB':surplus,'io':io.get(str(root)),'ioHeadroom':headroom,'score':surplus*headroom,
                     'eligible':free-floor-reserved>=d['treeConfig']['reserveGiB'],'scoreMode':'space-io' if complete else 'space'})
    return rows

def tree_place(d):
    primary=pathlib.Path(d['root']); roots=tree_roots(d); store=d['store']; project=d['project']; slot=d['slot']
    if not re.fullmatch(r'id-[A-Za-z0-9_.-]+',store): raise RuntimeError('tree placement requires identity store (legacy store left unchanged)')
    repo=primary/'repos'/project/store
    if repo.resolve()!=repo: raise RuntimeError('tree repository symlink')
    repo.parent.mkdir(parents=True,exist_ok=True)
    with tree_lock(str(repo)+'.lock'), tree_lock(primary/'wt-map.json.lock'):
        record=tree_map_read(primary); identity=project+'/'+store
        old=record['slots'].get(slot,{}).get(identity); existing=[]
        owner=d.get('heldTreeOwners',{}).get(slot)
        for entry in record['slots'].get(slot,{}).values():
            if owner and entry.get('owner')!=owner: entry['reserveGiB']=0; entry['reserveUntil']=0
        if old and old.get('treeRoot') not in [str(root) for root,_ in roots]: raise RuntimeError('recorded tree root is no longer registered; restore owner configuration')
        for root,_ in roots:
            ws=root/'wt'/project/store/slot
            if not tree_scope(root,ws): raise RuntimeError('unsafe tree workspace')
            if (ws/'.git').exists():
                meta=ws/'.devbox-run.json'
                if (ws/'.git').is_symlink() or not meta.is_file() or meta.is_symlink(): raise RuntimeError('unowned existing tree')
                receipt=json.loads(meta.read_text())
                if receipt.get('slot')!=slot or receipt.get('repository')!=str(repo): raise RuntimeError('foreign existing tree receipt')
                common=subprocess.check_output(['git','-C',str(ws),'rev-parse','--path-format=absolute','--git-common-dir'],text=True).strip()
                if pathlib.Path(common).resolve()!=repo: raise RuntimeError('foreign existing git worktree')
                existing.append((root,ws))
            elif ws.exists(): raise RuntimeError('unowned partial tree; owner inspection required')
        scores=[]
        if existing:
            mapped=[item for item in existing if old and str(item[0])==old.get('treeRoot')]
            if len(existing)>1 and not mapped: raise RuntimeError('ambiguous existing trees; no tree moved')
            root,ws=(mapped or existing)[0]; state='warm'
        else:
            # A delayed SSH request can carry an older hold inventory. Recently
            # published reserves remain until explicit release, even if absent
            # from that snapshot; known replaced owners no longer reserve.
            reservations={}; holders=d.get('heldTreeOwners',{})
            for other,entries in record['slots'].items():
                if other==slot: continue
                for entry in entries.values():
                    live=other in holders and (holders[other] is None or holders[other]==entry.get('owner'))
                    pending=other not in holders and entry.get('reserveUntil',0)>time.time()
                    if live or pending:
                        p=entry['treeRoot']; reservations[p]=reservations.get(p,0)+entry.get('reserveGiB',0)
            d['treeReservations']=reservations
            scores=tree_scores(d); admitted=[row for row in scores if row['eligible']]
            if not admitted: print('DEVBOX_TREE_DISK_GUARD',file=sys.stderr); sys.exit(72)
            choice=max(admitted,key=lambda row:row['score']); root=pathlib.Path(choice['root']); ws=root/'wt'/project/store/slot; state='cold-new'
            ws.parent.mkdir(parents=True,exist_ok=True)
        entry={'treeRoot':str(root),'lastUsed':time.time(),'reserveGiB':d['treeConfig']['reserveGiB'] if state=='cold-new' else 0,
               'owner':d.get('heldTreeOwners',{}).get(slot),'reserveUntil':time.time()+14400 if state=='cold-new' else 0}
        record['slots'].setdefault(slot,{})[identity]=entry; tree_map_write(primary,record)
        return {'treeRoot':str(root),'workspace':str(ws),'treeState':state,'placementScores':scores,
                'floorGiB':max(floor for p,floor in roots if tree_filesystem(p)==tree_filesystem(root))}

def tree_release(d):
    primary=pathlib.Path(d['root']); tree_roots(d)
    with tree_lock(primary/'wt-map.json.lock'):
        record=tree_map_read(primary); count=0
        for entry in record['slots'].get(d['slot'],{}).values():
            if entry.get('owner')==d['owner']:
                entry['reserveGiB']=0; entry['reserveUntil']=0; count+=1
        if count: tree_map_write(primary,record)
        return {'released':count}

def tree_guard(d):
    if not d.get('treeConfig'): return
    primary=pathlib.Path(d['root']); selected=pathlib.Path(d.get('treeRoot',d['root']))
    roots=dict(tree_roots(d))
    if selected not in roots: raise RuntimeError('unregistered selected tree root')
    ws=pathlib.Path(d['workspace'])
    if not tree_scope(selected,ws): raise RuntimeError('tree guard outside slot scope')
    for root in {primary,selected}:
        disk=os.statvfs(root)
        if disk.f_bavail*disk.f_frsize<roots[root]*TREE_GIB:
            print('DEVBOX_LAUNCH_DISK_GUARD',file=sys.stderr); sys.exit(72)

def tree_process_live(ws):
    # Unknown process evidence preserves the tree. Do not read argv/environment.
    for process in pathlib.Path('/proc').glob('[0-9]*'):
        try:
            if process.stat().st_uid!=os.getuid(): continue
            cwd=(process/'cwd').resolve(strict=True)
            if cwd==ws or cwd.is_relative_to(ws): return True
        except (FileNotFoundError,ProcessLookupError): continue
        except OSError: return True
    return False

def tree_evict(d):
    primary=pathlib.Path(d['root']); ws=pathlib.Path(d['workspace']); root=pathlib.Path(d['treeRoot'])
    registered=tree_roots(d)
    roots={p:max(floor for peer,floor in registered if tree_filesystem(peer)==tree_filesystem(p)) for p,_ in registered}
    repo=pathlib.Path(d['repository']); slot=d['slot']
    if slot in d.get('heldSlots',[]) or root not in roots or not tree_scope(root,ws) or ws.name!=slot: raise RuntimeError('eviction outside leased tree scope')
    expected=primary/'repos'/ws.parts[-3]/ws.parts[-2]
    if repo!=expected or repo.resolve()!=repo: raise RuntimeError('eviction foreign repository')
    with tree_lock(str(repo)+'.lock'), tree_lock(primary/'wt-map.json.lock'):
        candidates=[row for row in tree_list(d) if row['workspace']==str(ws)]
        if not candidates: return {'skipped':'not a runner tree'}
        row=candidates[0]; disk=os.statvfs(root); free=disk.f_bavail*disk.f_frsize/TREE_GIB
        below=not d.get('coldOnly') and free<max(d.get('targetFreeGiB',roots[root]),roots[root]); cold=row['lastUsed']<time.time()-d.get('days',d['treeConfig']['coldDays'])*86400
        if not below and not cold: return {'skipped':'warm and above floor'}
        if tree_process_live(ws): return {'skipped':'live or unknown process'}
        # Preserve edits and any private/symlink state rather than treating it as rebuildable.
        for parent,dirs,files in os.walk(ws,followlinks=False):
            for name in dirs+files:
                p=pathlib.Path(parent)/name
                if p.is_symlink() or re.search(r'^(?:\.env(?:\..*)?|\.ssh|\.netrc|\.npmrc|login|cookies?|sessions?)$|\.(?:pem|p12|pfx|key|keystore)$',name,re.I): return {'skipped':'private or symlink state'}
        common=subprocess.check_output(['git','-C',str(ws),'rev-parse','--path-format=absolute','--git-common-dir'],text=True).strip()
        if pathlib.Path(common).resolve()!=repo: return {'skipped':'foreign git worktree'}
        dirty=subprocess.check_output(['git','-C',str(ws),'status','--porcelain','--untracked-files=all'],text=True)
        if dirty: return {'skipped':'uncommitted edits'}
        size=int(subprocess.check_output(['du','-sk',str(ws)],text=True).split()[0])*1024
        record=tree_map_read(primary)
        subprocess.run(['git','--git-dir='+str(repo),'worktree','remove','--force',str(ws)],check=True)
        identity=row['project']+'/'+row['store']; mapped=record['slots'].get(slot,{})
        if mapped.get(identity,{}).get('treeRoot')==str(root): mapped.pop(identity,None)
        tree_map_write(primary,record)
        after=os.statvfs(root); after=after.f_bavail*after.f_frsize/TREE_GIB
        return {'path':str(ws),'bytes':size,'treeRoot':str(root),'lastUsed':row['lastUsed'],'freeBeforeGiB':free,'freeAfterGiB':after,'reason':'below-floor-lru' if below else 'cold'}
`;

// Absent configuration returns the exact old script, not an equivalent rewrite.
export function treeScript(operation, legacy, header, data) {
  if (!data.treeConfig) return legacy;
  const body = code => header + treePython + code;
  if (operation === 'tree-list') return body('print(json.dumps(tree_list(d)))\n');
  if (operation === 'tree-place') return body('print(json.dumps(tree_place(d)))\n');
  if (operation === 'tree-release') return body('print(json.dumps(tree_release(d)))\n');
  if (operation === 'tree-evict') return body('print(json.dumps(tree_evict(d)))\n');
  if (operation === 'gc') return body("d['coldOnly']=True\nprint(json.dumps(tree_evict(d)))\n");
  if (operation === 'inventory') return body("print(json.dumps([row for row in tree_list(d) if row['lastUsed']<time.time()-d['days']*86400]))\n");
  if (operation === 'recent') return body("rows=tree_list(d); recent={}\nfor row in rows:\n    if row['project']==d['project']: recent[row['slot']]=max(recent.get(row['slot'],0),row['lastUsed'])\nprint(json.dumps(recent))\n");
  if (operation === 'workspaces' || operation === 'warm-path') return body(String.raw`
record=pathlib.Path(d['root'])/'store-index'/d['key']; store=record.read_text() if record.is_file() else d['key']
rows=[row for row in tree_list(d) if row['project']==d['project'] and row['store']==store]
if 'slots' in d: print(json.dumps([row['slot'] for row in rows if row['slot'] in d['slots']]))
else:
    rows=[row for row in rows if row['slot']==d['slot']]
    if d.get('affinity'): rows=[row for row in rows if json.loads((pathlib.Path(row['workspace'])/'.devbox-run.json').read_text()).get('affinity')==d['affinity']]
    print(json.dumps(rows[0]['workspace'] if rows else None))
`);
  if (!legacy) throw Error(`unsupported tree operation ${operation}`);
  let source = legacy;
  if (operation === 'dead-slot') return source.replace("paths=list((root/'wt').glob('*/*/'+d['slot']))",
    "paths=[p for tree_root,_ in tree_roots(d) for p in (tree_root/'wt').glob('*/*/'+d['slot'])]")
    .replace(header, () => header + treePython);
  if (operation === 'inspect' || operation === 'checkout') source = source.replaceAll("'affinity':d.get('affinity')}", "'affinity':d.get('affinity'),'treeRoot':d.get('treeRoot'),'treeState':d.get('treeState'),'placementScores':d.get('placementScores',[])}");
  if (['run', 'inspect', 'input-map', 'inputs-ready'].includes(operation) && data.workspace) source = source.replace(header, () => header + treePython + 'tree_guard(d)\n');
  return source;
}
