const phases = ['slotWaitAdmission', 'sourceTransferIn', 'inputPreparation', 'remoteCommand', 'artifactCollection', 'transferOut', 'cleanup'];

export function attemptTiming(now = () => performance.now()) {
  const start = now(), data = { seconds: Object.fromEntries(phases.map(phase => [phase, 0])), inputs: {}, bytesIn: 0, bytesOut: 0 };
  let phase = 'slotWaitAdmission', since = start, finished = false;
  const input = name => data.inputs[name] ||= { verifySec: 0, seedSec: 0, rebuildSec: 0 };
  return {
    data,
    phase(next) {
      if (finished) return;
      if (!phases.includes(next)) throw Error('unknown attempt phase');
      const time = now(); data.seconds[phase] += Math.max(0, time - since) / 1000; since = time; phase = next;
    },
    addInput(name, kind, seconds) {
      if (!['verifySec', 'seedSec', 'rebuildSec'].includes(kind) || !Number.isFinite(seconds) || seconds < 0) return;
      input(name)[kind] = (input(name)[kind] || 0) + seconds;
    },
    missingRebuild(name) { input(name).rebuildSec = null; input(name).rebuildInRemoteCommand = true; },
    addBytes(incoming = 0, outgoing = 0) { data.bytesIn += incoming; data.bytesOut += outgoing; },
    artifact(seconds) {
      if (!Number.isFinite(seconds) || seconds < 0) return;
      this.phase('transferOut');
      const measured = Math.min(seconds, data.seconds.transferOut);
      data.seconds.transferOut -= measured; data.seconds.artifactCollection += measured;
    },
    finish() {
      if (!finished) { this.phase(phase); data.totalSec = Object.values(data.seconds).reduce((sum, seconds) => sum + seconds, 0); finished = true; }
      return data;
    },
  };
}

export function timingLine(data) {
  return Object.entries(data.seconds).map(([phase, seconds]) => `${phase}=${seconds.toFixed(3)}s`).join(' ')
    + ` totalSec=${data.totalSec.toFixed(3)}s bytesIn=${data.bytesIn} bytesOut=${data.bytesOut} inputs=${JSON.stringify(data.inputs)}`;
}
