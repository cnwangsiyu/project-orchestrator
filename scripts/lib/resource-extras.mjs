export const HUB_PORTS = [47321, 47322, 47323, 47324];
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
export function parseHubListeners(text, { exitCode = 0, stderr = '' } = {}) {
  const unknown = (error) => ({ state: 'UNKNOWN', complete: false, ports: HUB_PORTS.map((port) => ({ port, state: 'UNKNOWN', pids: [] })), error,
    source: 'read-only lsof TCP LISTEN snapshot; port liveness, not authenticated application health' });
  // lsof returns 1 (with no diagnostics) when no sockets match. Permission/other errors are not outages.
  if (![0, 1].includes(exitCode) || stderr.trim()) return unknown('listener probe failed/denied (output omitted)');
  const found = new Map(HUB_PORTS.map((port) => [port, new Set()])); let pid = null;
  for (const line of String(text).split('\n').filter(Boolean)) {
    if (/^p[1-9]\d*$/.test(line)) { pid = +line.slice(1); continue; }
    if (/^f\d+$/.test(line) && pid) continue; // lsof emits descriptor delimiters even with -Fpn.
    const m = line.match(/^n[^\n]*:(4732[1-4])$/);
    if (!m || !pid) return unknown('unparseable listener probe (output omitted)');
    found.get(+m[1]).add(pid);
  }
  const ports = HUB_PORTS.map((port) => ({ port, state: found.get(port).size ? 'LISTENING' : 'NOT_LISTENING', pids: [...found.get(port)] }));
  const missingPorts = ports.filter((p) => p.state === 'NOT_LISTENING').map((p) => p.port);
  return { state: !missingPorts.length ? 'ALL_LISTENING' : missingPorts.length === 4 ? 'ALL_MISSING' : 'PARTIAL', complete: true, ports, missingPorts,
    source: 'read-only lsof -iTCP:47321-47324 -sTCP:LISTEN; port liveness only, no request/session injection' };
}

export function parseCcacheStats(text, { exitCode = 0, scope = 'shared vesdk ccache' } = {}) {
  const unknown = (reason) => ({ available: exitCode === 'ENOENT' ? false : null, complete: false, scope, error: reason });
  if (exitCode !== 0) return unknown('ccache -s unavailable/failed (output omitted)');
  const primary = String(text).split(/^(?:Local|Remote) storage:/m)[0];
  const count = (pattern) => { const m = primary.match(pattern); const n = m ? Number(m[1].replaceAll(',', '')) : null; return Number.isSafeInteger(n) && n >= 0 ? n : null; };
  const directHits = count(/^\s*(?:Direct:|cache hit \(direct\))\s+([\d,]+)/mi);
  const preprocessedHits = count(/^\s*(?:Preprocessed:|cache hit \(preprocessed\))\s+([\d,]+)/mi);
  const modernHits = count(/^\s*Hits:\s+([\d,]+)/mi);
  const hits = modernHits ?? (directHits !== null && preprocessedHits !== null ? directHits + preprocessedHits : null);
  const misses = count(/^\s*(?:Misses:|cache miss)\s+([\d,]+)/mi);
  const cacheableCalls = count(/^\s*Cacheable calls:\s+([\d,]+)/mi);
  if (hits === null && misses === null && /^Local storage:\s*\n\s*Cache size \(GiB\):\s+[\d.]+\s*\//m.test(String(text))) return {
    available: true, complete: false, scope, hits: null, misses: null, hitRatePct: null, countersPresent: false,
    error: 'ccache -s is available but has no hit/miss counters yet; hit rate UNKNOWN', source: 'ccache -s storage-only output; no inferred cache calls',
  };
  if (hits === null || misses === null || !Number.isSafeInteger(hits + misses) || cacheableCalls !== null && cacheableCalls !== hits + misses || directHits !== null && preprocessedHits !== null && directHits + preprocessedHits !== hits) return unknown('ccache hit/miss counters invalid/inconsistent (output omitted)');
  const requests = hits + misses;
  return { available: true, complete: true, scope, hits, misses, directHits, preprocessedHits, cacheableCalls: requests,
    hitRatePct: requests ? +(hits / requests * 100).toFixed(2) : null, source: 'ccache -s cumulative counters; shared cache, not per-project attribution' };
}

export function reviewExtras(samples, { since, maxGapMs, record }) {
  let hubMinutes = 0, outageMinutes = 0, partialMinutes = 0, cacheMinutes = 0, hits = 0, misses = 0, resets = 0;
  const transitions = [];
  const outageObservations = samples.filter((s) => s.t >= since && s.hubs?.complete && s.hubs.state !== 'ALL_LISTENING').map((s) => ({ at: s.at ?? new Date(s.t).toISOString(), state: s.hubs.state, missingPorts: s.hubs.missingPorts }));
  for (let i = 0; i + 1 < samples.length; i++) {
    const a = samples[i], b = samples[i + 1], gap = b.t - a.t, span = b.t - Math.max(a.t, since);
    if (gap <= 0 || gap > maxGapMs || span <= 0) continue;
    if (a.hubs?.complete && b.hubs?.complete) {
      hubMinutes += span / 60000;
      if (a.hubs.state !== b.hubs.state || (a.hubs.missingPorts ?? []).join(',') !== (b.hubs.missingPorts ?? []).join(',')) transitions.push({
        from: a.hubs.state, to: b.hubs.state, earliestAt: a.at ?? new Date(a.t).toISOString(), latestAt: b.at ?? new Date(b.t).toISOString(), missingPortsAtEnd: b.hubs.missingPorts,
      });
      if (a.hubs.state === 'ALL_MISSING' && b.hubs.state === 'ALL_MISSING') {
        outageMinutes += span / 60000;
        record('hub_outage', '47321-47324', a, b.t, 'all four hub TCP listener ports absent at both endpoints; sampled outage, daemon cause unverified; report only, never restart', []);
      } else {
        const missing = (a.hubs.missingPorts ?? []).filter((p) => b.hubs.missingPorts?.includes(p));
        if (missing.length) {
          partialMinutes += span / 60000;
          record('hub_partial_outage', missing.join(','), a, b.t, `hub TCP ports ${missing.join(',')} absent at both endpoints; listener state is not authenticated application health`, []);
        }
      }
    }
    if (a.ccache?.complete && b.ccache?.complete && typeof a.ccache.scope === 'string' && a.ccache.scope.length > 0 && a.ccache.scope === b.ccache.scope) {
      const dh = b.ccache.hits - a.ccache.hits, dm = b.ccache.misses - a.ccache.misses;
      if (dh < 0 || dm < 0) { resets++; continue; }
      if (!finite(dh) || !finite(dm)) continue;
      // Clipped boundary intervals cannot assign cache calls to either side of the boundary.
      if (a.t < since) continue;
      cacheMinutes += span / 60000;
      hits += dh; misses += dm;
    }
  }
  const latest = samples.filter((s) => s.t >= since && s.ccache?.complete).at(-1);
  const latestObservation = samples.filter((s) => s.t >= since && s.ccache).at(-1);
  return {
    hubs: { ports: HUB_PORTS, observedMinutes: hubMinutes, allMissingMinutes: hubMinutes ? outageMinutes : null, partialMissingMinutes: hubMinutes ? partialMinutes : null, outageObservations, transitions,
      note: 'Outage durations require two adjacent complete probes <=10 min apart with common absent ports; isolated observations have no invented duration. Outage onset/recovery is bounded by probes. Denied/failed probes are UNKNOWN.' },
    ccache: { observedMinutes: cacheMinutes, sampledHits: cacheMinutes ? hits : null, sampledMisses: cacheMinutes ? misses : null,
      windowHitRatePct: hits + misses > 0 ? +(hits / (hits + misses) * 100).toFixed(2) : null, counterResetIntervals: resets,
      latest: latest ? { at: latest.at ?? new Date(latest.t).toISOString(), ...latest.ccache } : null,
      latestObservation: latestObservation ? { at: latestObservation.at ?? new Date(latestObservation.t).toISOString(), ...latestObservation.ccache } : null,
      note: 'Cumulative hit rate is distinct from window counter deltas. No calls means UNKNOWN, not 0% hits. Reset/decrease, missing scope, gaps and clipped boundary deltas are omitted. Shared Android/host CMake cache stats do not establish Xcode or full APK acceptance.' },
  };
}
