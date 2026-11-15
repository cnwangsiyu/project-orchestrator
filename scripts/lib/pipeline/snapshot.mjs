import { VERSION, EFFORTS, array, object, idOK, modelId, familyOf, compare, unique, nonnegative, finite, clone, freeze, fingerprint, reason } from './common.mjs';

export const FRESHNESS = freeze({ cacheMs: 600000, telemetryMs: 1800000, quotaMs: 1800000 });
// A frozen object alone is not proof that the normalization boundary ran.
// This also accepts retained JSON snapshots without changing their diagnostics.
export function isNormalizedSnapshot(s) {
  const obs = (o) => object(o) && ['KNOWN', 'UNKNOWN'].includes(o.status);
  if (!object(s) || s.schemaVersion !== VERSION || !s.id || !s.contentHash || !nonnegative(s.decisionAt)
    || !['accounts', 'models', 'lanes', 'approvals', 'health', 'qualityRelations', 'etaHistory', 'diagnostics'].every((k) => Array.isArray(s[k]) && s[k].every(object))
    || !obs(s.resources) || !obs(s.dependencies)) return false;
  if (!s.accounts.every((a) => ['auth', 'transport', 'health', 'catalog', 'providerDenied', 'denialResetAt', 'burn'].every((k) => obs(a[k]))
    && Array.isArray(a.quota) && object(a.capabilities) && (a.catalog.status !== 'KNOWN' || Array.isArray(a.catalog.value)))
    || !s.models.every((m) => Array.isArray(m.efforts) && object(m.qualityProfiles) && object(m.capabilities))
    || !s.lanes.every((l) => ['efforts', 'readyAt', 'position', 'drainPerMin', 'progressAt', 'loadPercent'].every((k) => obs(l[k]))
      && Array.isArray(l.costs) && (l.efforts.status !== 'KNOWN' || Array.isArray(l.efforts.value)))
    || !s.approvals.every((a) => Array.isArray(a.scopes))) return false;
  const { id, contentHash, ...content } = s;
  return id === `snapshot:${contentHash}` && fingerprint(content) === contentHash;
}
// Values must already be sanitized by the acquisition adapter. This module never
// imports state.mjs: analyze() performs I/O and cannot run in replay/shadow.
export function observation(raw, { now, collectedThrough = now, sampledAt = null, receivedAt = null, maxAgeMs = FRESHNESS.cacheMs, source = 'injected', check = () => true } = {}) {
  const wrapped = object(raw) && Object.hasOwn(raw, 'status');
  const value = wrapped ? raw.value : raw;
  const sample = wrapped ? raw.sampledAt : sampledAt, receive = wrapped ? raw.receivedAt : receivedAt;
  const ttl = wrapped && nonnegative(raw.maxAgeMs) ? Math.min(maxAgeMs, raw.maxAgeMs) : maxAgeMs;
  let code = null;
  if (wrapped && raw.status !== 'KNOWN') code = 'OBSERVATION_UNKNOWN';
  else if (value === undefined || value === null || !check(value)) code = 'OBSERVATION_MALFORMED';
  else if (![now, collectedThrough, sample, receive].every(nonnegative) || receive < sample) code = 'OBSERVATION_TIME_UNKNOWN';
  else if (sample > collectedThrough || receive > collectedThrough || collectedThrough > now) code = 'OBSERVATION_FUTURE';
  else if (now - sample > ttl) code = 'OBSERVATION_STALE';
  return { status: code ? 'UNKNOWN' : 'KNOWN', value: code ? null : clone(value), sampledAt: nonnegative(sample) ? sample : null,
    receivedAt: nonnegative(receive) ? receive : null, ageMs: nonnegative(sample) && finite(now) ? now - sample : null,
    maxAgeMs: ttl, source: wrapped && typeof raw.source === 'string' ? raw.source : source, diagnosticCode: code };
}
const strings = (x) => Array.isArray(x) && x.every(idOK);
const bool = (x) => typeof x === 'boolean';
const usageOK = (q) => object(q) && nonnegative(q.used) && finite(q.limit) && q.limit > 0 && nonnegative(q.resetsAt);
export function createSnapshot(raw, options = {}) {
  raw = object(raw) ? raw : {};
  const decisionAt = options.now ?? raw.decisionAt;
  const collectedFrom = raw.collectedFrom ?? raw.sampledAt ?? null, collectedThrough = raw.collectedThrough ?? raw.sampledAt ?? null;
  const diagnostics = [];
  const diag = (path, code) => diagnostics.push(reason('snapshot', code, `${path}: ${code}`, [path]));
  const unsupported = raw.schemaVersion !== undefined && raw.schemaVersion !== VERSION;
  if (unsupported) diag('schemaVersion', 'SNAPSHOT_VERSION_UNKNOWN');
  if (!nonnegative(decisionAt) || !nonnegative(collectedFrom) || !nonnegative(collectedThrough) || collectedFrom > collectedThrough || collectedThrough > decisionAt)
    diag('collection', 'COLLECTION_TIME_UNKNOWN');
  const invalidTime = diagnostics.some((d) => d.code === 'COLLECTION_TIME_UNKNOWN');
  const obs = (value, path, check, ttl = FRESHNESS.cacheMs, sample = collectedThrough) => {
    const o = observation(unsupported || invalidTime ? undefined : value, { now: decisionAt, collectedThrough, sampledAt: sample,
      receivedAt: collectedThrough, maxAgeMs: ttl, check });
    if (o.status === 'UNKNOWN') diag(path, o.diagnosticCode);
    return o;
  };
  const caps = (v, prefix) => Object.fromEntries(Object.entries(object(v) ? v : {}).sort(([a], [b]) => compare(a, b))
    .map(([k, val]) => [k, obs(val, `${prefix}.${k}`, bool)]));
  const rows = (v, path) => { if (!Array.isArray(v)) diag(path, 'ARRAY_UNKNOWN'); return array(v).filter(object); };
  const byId = (xs, path) => {
    const groups = new Map();
    for (const x of xs) { if (!groups.has(x.id)) groups.set(x.id, []); groups.get(x.id).push(x); }
    return [...groups].sort(([a], [b]) => compare(a, b)).flatMap(([id, group]) => {
      if (!idOK(id)) { diag(path, 'ID_UNKNOWN'); return []; }
      if (group.length > 1 && new Set(group.map(fingerprint)).size > 1) { diag(`${path}.${id}`, 'CONTRADICTORY_ID'); return []; }
      return [group[0]];
    });
  };
  const models = byId(rows(raw.models, 'models').map((m) => {
    const id = modelId(m.id);
    const efforts = obs(m.efforts, `models.${id}.efforts`, (x) => strings(x) && x.every((e) => EFFORTS.includes(e)));
    return { id, family: familyOf(id), efforts: efforts.value ? unique(efforts.value) : [], effortsStatus: efforts.status,
      capabilities: caps(m.capabilities, `models.${id}.capabilities`), qualityProfiles: Object.fromEntries(EFFORTS.map((e) => [e, `${id}:${e}`])),
      // These declarations narrow fit. They never override binding fit rules.
      visionOnly: m.visionOnly === true, largeOutput: obs(m.largeOutput, `models.${id}.largeOutput`, bool) };
  }), 'models');
  const accounts = byId(rows(raw.accounts, 'accounts').map((a) => {
    const id = a.id, prefix = `accounts.${id}`;
    const catalog = obs(a.catalog, `${prefix}.catalog`, strings);
    if (catalog.value) catalog.value = unique(catalog.value.map(modelId));
    const quota = rows(a.quota ?? [], `${prefix}.quota`).map((q) => ({ bucketId: q.bucketId, unit: q.unit,
      authoritative: q.authoritative === true, usage: obs(q.usage, `${prefix}.quota.${q.bucketId}.usage`, usageOK, FRESHNESS.quotaMs),
      priority: obs(q.priority, `${prefix}.quota.${q.bucketId}.priority`, (v) => ['available', 'depleted', 'bucket-free'].includes(v), FRESHNESS.quotaMs) })).sort((a, b) => compare(a.bucketId, b.bucketId));
    // Optional legacy cards/windows cannot erase independently good auth/catalog.
    for (const key of ['resets', 'windows']) if (a[key] !== undefined) {
      const good = key === 'resets' ? object(a.resets) && Array.isArray(a.resets.credits) && nonnegative(a.resets.count)
        && a.resets.credits.every((c) => object(c) && idOK(c.id) && nonnegative(c.expiresAt))
        : Array.isArray(a.windows) && a.windows.every((w) => object(w) && nonnegative(w.used) && nonnegative(w.resetsAt));
      if (!good) diag(`${prefix}.${key}`, 'OPTIONAL_QUOTA_UNKNOWN');
    }
    return { id, kind: ['ttadk', 'trae', 'chatgpt', 'claude'].includes(a.kind) ? a.kind : 'UNKNOWN',
      company: ['ttadk', 'trae'].includes(a.kind), auth: obs(a.auth, `${prefix}.auth`, bool), transport: obs(a.transport, `${prefix}.transport`, bool),
      health: obs(a.health ?? (Array.isArray(raw.health) && raw.health.every((h) => object(h) && idOK(h.accountId) && typeof h.restricted === 'boolean') ? true : undefined), `${prefix}.health`, bool), catalog,
      capabilities: caps(a.capabilities, `${prefix}.capabilities`), quota,
      workerClass: 'ordinary',
      providerDenied: obs(a.providerDenied, `${prefix}.providerDenied`, bool),
      denialResetAt: obs(a.denialResetAt, `${prefix}.denialResetAt`, nonnegative),
      burn: obs(a.burn, `${prefix}.burn`, (v) => object(v) && nonnegative(v.projectedAtReset) && nonnegative(v.resetsAt), FRESHNESS.telemetryMs),
      budget: obs(a.budget, `${prefix}.budget`, object),
    };
  }), 'accounts');
  const lanes = byId(rows(raw.lanes, 'lanes').map((l) => {
    const prefix = `lanes.${l.id}`;
    const modeEvidence = obs(l.modeEvidence ?? l.mode, `${prefix}.mode`, (m) => ['standard', 'priority', 'low-priority', 'bucket-free'].includes(m), FRESHNESS.quotaMs);
    return { id: l.id, accountId: l.accountId, modelId: modelId(l.modelId), harness: idOK(l.harness) ? l.harness : 'UNKNOWN',
      efforts: obs(l.efforts, `${prefix}.efforts`, (x) => strings(x) && x.every((e) => EFFORTS.includes(e))),
      mode: modeEvidence.value ?? 'UNKNOWN', modeEvidence, selectable: l.selectable === true, evidenced: l.evidenced === true,
      readyAt: obs(l.readyAt, `${prefix}.readyAt`, nonnegative, FRESHNESS.telemetryMs),
      capabilities: caps(l.capabilities, `${prefix}.capabilities`),
      position: obs(l.position, `${prefix}.position`, nonnegative, FRESHNESS.telemetryMs),
      drainPerMin: obs(l.drainPerMin, `${prefix}.drainPerMin`, nonnegative, FRESHNESS.telemetryMs),
      queueState: obs(l.queueState ?? l.state, `${prefix}.queueState`, (v) => ['queued', 'waiting', 'ready'].includes(v), FRESHNESS.telemetryMs),
      progressAt: obs(l.progressAt, `${prefix}.progressAt`, (v) => nonnegative(v) && v <= decisionAt && decisionAt - v <= FRESHNESS.telemetryMs, FRESHNESS.telemetryMs),
      loadPercent: obs(l.loadPercent, `${prefix}.loadPercent`, (v) => nonnegative(v) && v <= 100, FRESHNESS.telemetryMs),
      loadSource: ['model', 'family', 'account'].includes(l.loadSource) ? l.loadSource : 'UNKNOWN',
      familyQueue:obs(l.familyQueue,`${prefix}.familyQueue`,object,FRESHNESS.telemetryMs),
      bucketIds: unique(array(l.bucketIds).filter(idOK)), costs: rows(l.costs ?? [], `${prefix}.costs`).map((c) => ({
        bucketId: c.bucketId, unit: c.unit, amount: nonnegative(c.amount) ? c.amount : null,
        normalizedShare: obs(c.normalizedShare, `${prefix}.costs.${c.bucketId}`, nonnegative).value, prioritySpend: typeof c.prioritySpend === 'boolean' ? c.prioritySpend : null,
      })).sort((a, b) => compare(a.bucketId, b.bucketId)),
    };
  }), 'lanes');
  // Restrictions persist beyond ordinary telemetry TTL. A clear requires matching
  // generation evidence, never a successful old attempt or an elapsed deadline.
  const health = rows(raw.health, 'health').map((h) => {
    const evidence = obs(h.evidence, `health.${h.accountId}.evidence`, bool);
    const cleared = h.recovery === 'cleared' && evidence.value === true && h.probe?.generation === h.generation
      && h.probe?.claimed === true && h.probe?.due === true && h.probe?.success === true
      && nonnegative(h.until) && nonnegative(h.probe.startedAt) && h.probe.startedAt >= h.until
      && nonnegative(h.probe.completedAt) && h.probe.completedAt >= h.probe.startedAt && h.probe.completedAt <= decisionAt;
    return { accountId: h.accountId, modelId: h.modelId ? modelId(h.modelId) : null, family: h.family ?? null,
      generation: h.generation ?? 'UNKNOWN', restricted: !cleared && h.restricted !== false, until: nonnegative(h.until) ? h.until : null,
      recovery: cleared ? 'cleared' : h.recovery === 'not-due' ? 'not-due' : 'awaiting-probe', evidence };
  }).sort((a, b) => compare(fingerprint(a), fingerprint(b)));
  const approvals = rows(raw.approvals ?? [], 'approvals').map(cloneApproval).filter(Boolean).sort((a, b) => compare(a.id, b.id));
  const snapshot = { schemaVersion: VERSION, collectedFrom, collectedThrough, decisionAt: nonnegative(decisionAt) ? decisionAt : null,
    policyVersion: raw.policyVersion ?? VERSION, policyHash: raw.policyHash ?? VERSION, catalogVersion: raw.catalogVersion ?? VERSION,
    capabilityVersion: raw.capabilityVersion ?? VERSION, qualityRelationVersion: raw.qualityRelationVersion ?? VERSION,
    qualityRelations: rows(raw.qualityRelations ?? [], 'qualityRelations').map((r) => ({ from: r.from, to: r.to, version: r.version, evidenceId: r.evidenceId })),
    accounts, models, lanes, approvals, health,
    resources: obs(raw.resources, 'resources', object), dependencies: obs(raw.dependencies, 'dependencies', strings), rotationState: 0,
    etaHistory: rows(raw.etaHistory ?? [], 'etaHistory').filter((h) => idOK(h.attemptId) && nonnegative(h.minutes) && h.minutes > 0
      && (!h.sampledAt || h.sampledAt <= decisionAt)).map((h) => ({ attemptId: h.attemptId, category: h.category, modelId: modelId(h.modelId), accountId: h.accountId,
        effort: h.effort, minutes: h.minutes, cause: h.cause ?? null })).sort((a, b) => compare(a.attemptId, b.attemptId)),
    reviewHistory: rows(raw.reviewHistory ?? [], 'reviewHistory').map((r) => ({ t: r.t, project: r.project, name: r.name, category: r.category, role: r.role ?? 'primary', reviewOverride:r.reviewOverride??null, requestId:r.requestId??null })),
    outcomes: rows(raw.outcomes ?? [], 'outcomes').map((r) => ({ t: r.t, category: r.category, modelId: modelId(r.modelId), result: r.result })),
    projectProfiles: clone(object(raw.projectProfiles) ? raw.projectProfiles : {}),
    diagnostics: diagnostics.sort((a, b) => compare(`${a.subjects}:${a.code}`, `${b.subjects}:${b.code}`)) };
  snapshot.contentHash = fingerprint(snapshot); snapshot.id = `snapshot:${snapshot.contentHash}`;
  return freeze(snapshot);
}
function cloneApproval(a) {
  if (!idOK(a.id) || !idOK(a.userDecisionRef) || !nonnegative(a.grantedAt) || !nonnegative(a.expiresAt) || typeof a.revoked !== 'boolean' || !Array.isArray(a.scopes)) return null;
  const scopes = a.scopes.filter((s) => object(s) && idOK(s.taskId) && idOK(s.constraintHash) && typeof s.action === 'string'
    && ['roles', 'accounts', 'models', 'efforts', 'origins', 'apps'].every((k) => Array.isArray(s[k]) && s[k].every((v) => typeof v === 'string')))
    .map((s) => ({ taskId: s.taskId, constraintHash: s.constraintHash, action: s.action, roles: unique(s.roles), accounts: unique(s.accounts),
      models: unique(s.models.map(modelId)), efforts: unique(s.efforts), artifactHash: s.artifactHash ?? null, origins: unique(s.origins), apps: unique(s.apps),
      allowPersonalWithCompany: s.allowPersonalWithCompany === true }));
  return { id: a.id, userDecisionRef: a.userDecisionRef, grantedAt: a.grantedAt, expiresAt: a.expiresAt, revoked: a.revoked,
    consumed: a.consumed === true, scopes: scopes.sort((a, b) => compare(fingerprint(a), fingerprint(b))) };
}

// metadata supplies ALL registered accounts (analyze has only one TTADK/TRAE),
// catalogs, harnesses, observation times and positive capabilities. Never infer
// auth from .usable/.healthy, or tool access from a legacy .browser boolean.
export function snapshotFromAnalyze(analyzed, metadata = {}) {
  metadata = object(metadata) ? metadata : {};
  const x = object(analyzed?.codex) ? analyzed.codex : {};
  const legacy = [x.ttadk, x.trae, ...array(x.rows).map((r) => r?.a)].filter(object);
  const registered = array(metadata.accounts).filter(object).map((a) => ({ ...a }));
  for (const a of legacy) if (!registered.some((r) => r.id === a.name)) registered.push({ id: a.name, kind: a.kind ?? 'chatgpt',
    resets: a.resets, windows: a.windows });
  for (const a of array(x.companyAccounts)) if (object(a) && !registered.some((r) => r.id === a.name)) registered.push({ id: a.name, kind: a.kind });
  const stamp = (value, sampledAt, maxAgeMs = FRESHNESS.cacheMs) => ({ status: 'KNOWN', value, sampledAt,
    receivedAt: metadata.collectedThrough, maxAgeMs, source: 'sanitized-analyze' });
  for (const a of registered) {
    const old = legacy.find((r) => r.name === a.id);
    if (!old) continue;
    // Absence of an analyze timestamp cannot silently freshen a cached reading.
    const at = metadata.analysisSampledAt;
    a.catalog ??= stamp(old.allModels ?? old.models, at);
    if (a.quota === undefined) {
      if (a.kind === 'ttadk') a.quota = [{ bucketId: 'ttadk-daily', unit: 'tokens', authoritative: false, usage: stamp(old.usage, at) }];
      else if (a.kind === 'trae') a.quota = Object.entries(object(old.quota?.daily) ? old.quota.daily : {}).map(([id, q]) => ({
        bucketId: modelId(id), unit: 'model-bucket', authoritative: false, usage: stamp(q, old.quota.sampledAt),
        priority: stamp(q?.depleted === true ? 'depleted' : q?.depleted === false ? 'available' : null, old.quota.sampledAt),
      }));
    }
    if (a.burn === undefined && old.burn) a.burn = stamp(old.burn, old.burn.sampledAt, FRESHNESS.telemetryMs);
    // Provider-denial evidence is intentionally NOT derived from healthy=false,
    // a reason string or a numeric quota counter. The adapter must attest it.
  }
  const lanes = array(metadata.lanes).filter(object).map((l) => {
    const old = legacy.find((r) => r.name === l.accountId);
    const direct = old?.lanes?.[modelId(l.modelId)] ?? metadata.laneTelemetry?.[l.accountId]?.[modelId(l.modelId)];
    const load = old?.load?.[modelId(l.modelId)];
    return { ...l,
      ...(l.position === undefined && direct ? { position: stamp(direct.position, direct.t, FRESHNESS.telemetryMs) } : {}),
      ...(l.drainPerMin === undefined && direct ? { drainPerMin: stamp(direct.drainPerMin, direct.t, FRESHNESS.telemetryMs) } : {}),
      ...(l.queueState === undefined && direct ? { queueState: stamp(direct.state, direct.t, FRESHNESS.telemetryMs) } : {}),
      ...(l.progressAt === undefined && direct ? { progressAt: stamp(direct.lastProgressAt, direct.t, FRESHNESS.telemetryMs) } : {}),
      ...(l.loadPercent === undefined && load ? { loadPercent: stamp(load.percent, load.t, FRESHNESS.telemetryMs), loadSource: 'model' } : {}),
    };
  });
  return createSnapshot({ ...metadata, accounts: registered, lanes });
}
