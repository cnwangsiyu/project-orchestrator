import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { remoteScripts } from '../devbox-run.mjs';

// Run the production cleanup script against real groups. macOS supplies /proc
// stat fields from its process table; signalling and liveness remain real.
const scenario = String.raw`import os,sys,json,base64,tempfile,pathlib,subprocess,time,signal,shutil
source=base64.b64decode(sys.argv[1]).decode()
fixture=pathlib.Path(tempfile.mkdtemp(prefix='devbox-stop-group-'))
foreign=subprocess.Popen(['sleep','60'],start_new_session=True)
children=[]
class ProcessStat:
    def __init__(self,pid): self.pid=int(pid); self.parent=type('Parent',(),{'name':str(pid)})()
    def read_text(self):
        result=subprocess.run(['ps','-axo','pid=,pgid=,ppid=,stat='],capture_output=True,text=True,check=True)
        for line in result.stdout.splitlines():
            pid,pgid,ppid,state=line.split()
            if int(pid)==self.pid:
                fields=['0']*20; fields[0]=state[0]; fields[1]=ppid; fields[2]=pgid; fields[3]=pgid; fields[19]='100'
                return str(self.pid)+' (fixture) '+' '.join(fields)
        raise FileNotFoundError()
def process_stat(pid): return ProcessStat(pid)
def process_files():
    listing=subprocess.run(['ps','-axo','pid=,pgid='],capture_output=True,text=True,check=True)
    return [ProcessStat(int(line.split()[0])) for line in listing.stdout.splitlines() if int(line.split()[1])==group['pid']]
if sys.platform!='linux':
    source=source.replace("pathlib.Path('/proc/'+str(record['pid'])+'/stat')",'process_stat(record["pid"])')
    source=source.replace("pathlib.Path('/proc/'+str(pgid)+'/stat')",'process_stat(pgid)')
    source=source.replace("pathlib.Path('/proc').glob('[0-9]*/stat')",'process_files()')
    # Helpers are embedded for the cleanup child.
    helper=base64.b64decode(sys.argv[2]).decode()
    source=helper+'\n'+source
def start(pid):
    if sys.platform!='linux': return '100'
    return pathlib.Path('/proc/'+str(pid)+'/stat').read_text().rsplit(')',1)[1].split()[19]
def invoke(control):
    return subprocess.run(['python3','-c',source,base64.b64encode(json.dumps({'control':str(control)}).encode()).decode()],capture_output=True,text=True,timeout=30)
try:
    for resistant in (False,True):
        ctl=fixture/('resistant' if resistant else 'normal'); ctl.mkdir()
        ready=ctl/'ready'
        command=('trap "" TERM; ' if resistant else '')+'touch '+str(ready)+'; sleep 60 & wait'
        child=subprocess.Popen(['bash','-c',command],start_new_session=True); children.append(child)
        deadline=time.monotonic()+5
        while not ready.exists():
            if time.monotonic()>deadline: raise RuntimeError('group never ready')
            time.sleep(.01)
        record={'run':ctl.name,'pid':child.pid,'start':start(child.pid)}
        (ctl/'group.json').write_text(json.dumps(record))
        (ctl/'owner.json').write_text(json.dumps({'run':ctl.name,'pid':2147483647,'start':'100'}))
        began=time.monotonic(); result=invoke(ctl); elapsed=time.monotonic()-began
        assert result.returncode==0,(result.stdout,result.stderr)
        assert result.stdout.strip()=='group-gone'
        receipt=json.loads(next(line.split('=',1)[1] for line in result.stderr.splitlines() if line.startswith('DEVBOX_CLEANUP=')))
        assert receipt['pgid']==child.pid and receipt['count']==0 and not receipt['ownerAlive']
        child.wait(timeout=5)
        if resistant: assert elapsed>=2 and child.returncode==-signal.SIGKILL,(elapsed,child.returncode)
        assert foreign.poll() is None,'another group must survive'
    ctl=fixture/'reused'; ctl.mkdir()
    (ctl/'group.json').write_text(json.dumps({'run':ctl.name,'pid':foreign.pid,'start':'0'}))
    result=invoke(ctl); assert result.returncode==0,result.stderr
    assert foreign.poll() is None,'mismatched leader start time must never be signalled'
    print('PASS production TERM/KILL cleanup with dead supervisor, group descendant confirmation and unrelated/reused process preservation')
finally:
    for child in [*children,foreign]:
        if child.poll() is None:
            try: os.killpg(child.pid,signal.SIGKILL)
            except ProcessLookupError: pass
            except PermissionError: child.kill()
        child.wait()
    shutil.rmtree(fixture)
`;
const helpers = scenario.slice(scenario.indexOf('class ProcessStat:'), scenario.indexOf("if sys.platform!='linux':"));
const result = spawnSync('python3', ['-c', scenario, Buffer.from(remoteScripts.cleanup).toString('base64'),
  Buffer.from('import subprocess\n' + helpers).toString('base64')], { encoding: 'utf8', timeout: 70000 });
assert.equal(result.status, 0, result.stdout + result.stderr);
process.stdout.write(result.stdout);
