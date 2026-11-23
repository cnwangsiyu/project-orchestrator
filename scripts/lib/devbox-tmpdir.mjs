import fs from 'node:fs';

// Shared by the remote supervisor and its independent cleanup connection.
export const runTmpdirPython = fs.readFileSync(new URL('./owned_rmtree.py', import.meta.url), 'utf8') + `
import re, tempfile
def chromium_socket_bytes(tmpdir):
    socket=str(tmpdir)+'/.org.chromium.Chromium.XXXXXX/SingletonSocket'
    size=len(os.fsencode(socket))
    if size>107:
        raise RuntimeError('devbox-run: Chromium SingletonSocket path is '+str(size)+' bytes; maximum is 107 bytes (TMPDIR='+str(tmpdir)+')')
    return size
def create_run_tmpdir(ctl):
    if ctl.is_symlink(): raise RuntimeError('TMPDIR control symlink refused')
    directory=pathlib.Path(tempfile.mkdtemp(prefix='dr-',dir='/tmp'))
    try:
        chromium_socket_bytes(directory)
        directory_fd=os.open(directory,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
        try:
            os.fchmod(directory_fd,0o700)
            info=os.fstat(directory_fd)
        finally: os.close(directory_fd)
        if not re.fullmatch(r'dr-[a-z0-9_]{8}',directory.name): raise RuntimeError('invalid run TMPDIR name')
        record={'run':ctl.name,'path':str(directory),'dev':info.st_dev,'ino':info.st_ino}
        fd=os.open(ctl/'tmpdir.json',os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
        with os.fdopen(fd,'w') as output: json.dump(record,output)
        return str(directory)
    except BaseException:
        directory.rmdir()
        raise
def cleanup_run_tmpdir(ctl):
    if ctl.is_symlink(): raise RuntimeError('TMPDIR control symlink refused')
    try: fd=os.open(ctl/'tmpdir.json',os.O_RDONLY|os.O_NOFOLLOW)
    except FileNotFoundError: return
    with os.fdopen(fd) as source: record=json.load(source)
    directory=pathlib.Path(record['path'])
    if record.get('run')!=ctl.name or directory.parent!=pathlib.Path('/tmp') or not re.fullmatch(r'dr-[a-z0-9_]{8}',directory.name):
        raise RuntimeError('TMPDIR receipt outside run scope')
    parent=os.open('/tmp',os.O_RDONLY|os.O_DIRECTORY)
    try:
        try: info=os.stat(directory.name,dir_fd=parent,follow_symlinks=False)
        except FileNotFoundError: return
        if info.st_uid!=os.geteuid(): raise RuntimeError('TMPDIR owner mismatch')
        remove_owned_tree(parent,directory.name,(record['dev'],record['ino']),'TMPDIR')
    finally: os.close(parent)
`;
