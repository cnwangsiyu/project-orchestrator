import fs from 'node:fs';
import path from 'node:path';

// Supervisors and recovery stay independent of the task's disposable control connection.
const independent = new Set(['run', 'cleanup', 'reconnect', 'result', 'artifact-range', 'dead-slot']);
export function controlOptions(operation, state) {
  if (!state || independent.has(operation)) return ['-o', 'ControlMaster=no', '-o', 'ControlPath=none', '-o', 'ControlPersist=no'];
  // macOS's per-user TMPDIR plus %C exceeds OpenSSH's 104-byte socket limit.
  state.sshControlDir ||= fs.mkdtempSync('/tmp/devbox-ssh-');
  fs.chmodSync(state.sshControlDir, 0o700);
  const bulk = ['artifacts', 'fetch-artifact', 'artifact-range'].includes(operation);
  const socket = state.sshControlDir + (bulk ? '/bulk-%C' : '/control-%C');
  (state.sshControlPaths ||= new Set()).add(socket);
  return ['-o', 'ControlMaster=auto', '-o', 'ControlPath=' + socket, '-o', 'ControlPersist=60'];
}
