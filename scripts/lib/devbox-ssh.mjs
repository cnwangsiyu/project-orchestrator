import fs from 'node:fs';
import path from 'node:path';

// Supervisors/recovery, the observed checkout failure, and file-input transfers
// use dedicated connections; small control calls amortize their SSH setup cost.
const independent = new Set(['run', 'cleanup', 'reconnect', 'result', 'artifact-range', 'dead-slot', 'cleanup-pending',
  'checkout', 'bundle', 'patch', 'upload', 'seed']);
// These diagnostics describe the local ControlMaster handshake/session setup.
export function muxFailure(result) {
  return result.code === 255 && /\bmm_send_fd\b|\bmux(?:_client_request_session|client)?[^\r\n]*(?:send fds failed|session request failed|master hello exchange failed)|\bControl socket connect\(/i.test(result.stderr);
}

export function muxRetrySafe(operation, started) {
  // Arbitrary commands use receipt recovery, including a lost start marker.
  return operation !== 'run' && (!started || ['checkout', 'submodule', 'bundle', 'upload', 'seed', 'inspect', 'inputs', 'inputs-ready', 'store', 'probe', 'metrics'].includes(operation));
}

export function controlOptions(operation, state) {
  if (!state || state.sshMux?.degraded || independent.has(operation)) return ['-o', 'ControlMaster=no', '-o', 'ControlPath=none', '-o', 'ControlPersist=no'];
  // macOS's per-user TMPDIR plus %C exceeds OpenSSH's 104-byte socket limit.
  state.sshControlDir ||= fs.mkdtempSync('/tmp/devbox-ssh-');
  fs.chmodSync(state.sshControlDir, 0o700);
  const bulk = ['artifacts', 'fetch-artifact', 'artifact-range'].includes(operation);
  const socket = state.sshControlDir + (bulk ? '/bulk-%C' : '/control-%C');
  (state.sshControlPaths ||= new Set()).add(socket);
  return ['-o', 'ControlMaster=auto', '-o', 'ControlPath=' + socket, '-o', 'ControlPersist=60'];
}
