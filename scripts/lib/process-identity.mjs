import { execFileSync } from 'node:child_process';

// `comm` deliberately omits arguments. We retain it solely to make PID reuse
// fail closed; callers may print only the PID and this basename.
export const processIdentity = (pid, { exec = execFileSync } = {}) => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    const line = String(exec('/bin/ps', ['-p', String(pid), '-o', 'stat=', '-o', 'lstart=', '-o', 'comm='], { encoding: 'utf8', timeout: 1000 }))
      .trim().replace(/\s+/g, ' ');
    // A zombie has exited and only awaits its parent's wait(); it is not a live owner of the PID.
    const match = /^(\S+) (\S+ \S+ \d+ [\d:]+ \d{4}) (.+)$/.exec(line);
    if (!match || match[1].startsWith('Z')) return null;
    return { pid, started: match[2], name: match[3].split('/').at(-1).replace(/ <defunct>$/, '').slice(0, 120) };
  } catch { return null; }
};

export const sameProcessIdentity = (record, probe = processIdentity) => {
  if (!record || !Number.isSafeInteger(record.pid) || typeof record.started !== 'string' || typeof record.name !== 'string') return false;
  const current = probe(record.pid);
  return current !== null && current.started === record.started && current.name === record.name;
};

export const processAlive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
};
