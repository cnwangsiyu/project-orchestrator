import { transferFindings } from './devbox-transfer-check.mjs';

const compiled = { test: file => /\.(?:c|cc|cpp|cxx|h|hh|hpp|hxx|inl|m|mm|java|kt|kts|swift)$/i.test(file) && !/\.gradle\.kts$/i.test(file) };
const source = /\.(?:c|cc|cpp|cxx|h|hh|hpp|hxx|inl|m|mm|java|kt|kts|swift|groovy|js|jsx|ts|tsx|py|sh)$/i;
const lock = /(?:^|\/)(?:package-lock.json|npm-shrinkwrap.json|yarn.lock|pnpm-lock.ya?ml|Podfile.lock|Gemfile.lock|Cargo.lock|poetry.lock|gradle.lockfile|Package.resolved)$/i;
export const pathMatch = (pattern, file) => new RegExp('^' + pattern.split('*').map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*') + '$').test(file);
export function entropyIdentifierExempt(value) {
  return /^[a-z][a-z0-9]*(_[a-z0-9]+){2,}$/.test(value)
    && (value.match(/[a-z]/g)?.length ?? 0) * 5 >= value.length * 4
    && value.split('_').every(s => s.length <= 20 && !(s.length >= 12 && /^[a-f0-9]+$/.test(s)));
}
export function highEntropy(value) {
  if (entropyIdentifierExempt(value) || !/^[A-Za-z0-9+/_=-]{32,}$/.test(value)) return false;
  const counts = new Map();
  for (const c of value) counts.set(c, (counts.get(c) || 0) + 1);
  return -[...counts.values()].reduce((total, count) => { const p = count / value.length; return total + p * Math.log2(p); }, 0)
    >= (/^[0-9a-fA-F]+$/.test(value) ? 3.5 : 4);
}

// Match comments first. Literal offsets never leave this module; receipts have no values.
export function literals(text) {
  const rows = [], ordinals = new Map(); let previous = 0, line = 1;
  const lexer = /\/\*[\s\S]*?\*\/|\/\/[^\r\n]*|(?:u8|u|U|L)?R"([^ ()\\\t\r\n]{0,16})\([\s\S]*?\)\1"|"""[\s\S]*?"""|(?:u8|u|U|L|@)?"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'/g;
  for (const m of text.matchAll(lexer)) {
    line += (text.slice(previous, m.index).match(/\n/g) || []).length; previous = m.index;
    if (/^\//.test(m[0])) continue;
    const before = text.slice(Math.max(0, m.index - 512), m.index);
    const field = /([A-Za-z_$][\w$.-]*)\s*(?:\[\s*\])?\s*(?::\s*[\w?.<>\[\]]+\s*)?[=:]\s*(?:u8|u|U|L|@)?$/.exec(before)?.[1]
      ?? /([A-Za-z_$][\w$.-]*)\s*(?:\.set\s*\(\s*|\(\s*|[\t ]+)$/.exec(before)?.[1] ?? '[literal]';
    const ordinal = (ordinals.get(field) || 0) + 1; ordinals.set(field, ordinal);
    const raw = m[0], body = raw.replace(/^(?:u8|u|U|L|@)(?=["R])/, '');
    let value;
    if (body.startsWith('R"')) value = body.slice(body.indexOf('(') + 1, body.lastIndexOf(')'));
    else if (body.startsWith('"""')) value = body.slice(3, -3);
    else {
      value = body.slice(1, -1).replace(/\\(?:u([\da-f]{4})|U([\da-f]{8})|x([\da-f]{2})|([0-7]{1,3})|([\s\S]))/gi,
        (_, u, upper, hex, oct, c) => u || upper || hex || oct ? String.fromCodePoint(Math.min(0x10ffff, parseInt(u || upper || hex || oct, oct ? 8 : 16))) : ({ n: '\n', r: '\r', t: '\t' })[c] ?? c);
    }
    rows.push({ start: m.index, end: m.index + raw.length, field, ordinal, value,
      line, raw,
      // Surrounding syntax, with other literals removed, is the structural anchor.
      before: before.slice(before.lastIndexOf('\n') + 1).replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, '<literal>').trim(),
      after: text.slice(m.index + raw.length, m.index + raw.length + 256).split(/\r?\n/, 1)[0].replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, '<literal>').trim() });
  }
  return rows;
}

function options(file) {
  if (lock.test(file) || /(?:^|\/)[^/]+\.xcassets\/.*Contents\.json$/i.test(file) || /\.strings$/i.test(file)
    || /(?:^|\/)(?:i18n|l10n|locales?|translations?|languages?|strings)\/.*\.json$/i.test(file)) return { keyNames: false, lineKeys: false, lockfile: true };
  // The header extension uses value shapes, not configuration field names.
  if (/\.(?:c|cc|cpp|cxx|h|hh|hpp|hxx|inl)$/i.test(file)) return { keyNames: false, lineKeys: false, lockfile: true };
  if (/\.gradle(?:\.kts)?$/i.test(file)) return { dsl: true, keyNames: true };
  if (/\.(?:groovy|kt|kts|swift|ts|tsx|js|jsx|java|m|mm)$/i.test(file)) return { keyNames: false, lockfile: false };
  return { plist: /\.plist$/i.test(file), keyNames: /(?:^|\/)\.env|\.(?:properties|ya?ml|toml|ini|cfg|conf|json|plist|xcconfig)$/i.test(file), lineKeys: !/\.plist$/i.test(file) };
}
export const runnerScansPath = file => /(?:^|\/)(?:\.env[^/]*|[^/]+\.gradle(?:\.kts)?|settings\.gradle[^/]*|gradle\.properties|local\.properties)$/i.test(file)
  || /\.(?:properties|ya?ml|toml|ini|cfg|conf|json|plist|xcconfig|strings|groovy|kt|kts|swift|ts|tsx|js|jsx|java|m|mm)$/i.test(file) || lock.test(file);
const safeHit = (file, field, detector, line, count = 1) => ({ path: file, field, detector, line, count });
export function scanText(text, file) {
  const opts = options(file), rows = text.includes('\0') && !source.test(file) ? [] : literals(text), hits = [];
  const lines = text.split('\n');
  for (const aggregate of transferFindings(text, opts)) {
    if (/^(?:AKIA_ACCESS_KEY|JWT|EMBEDDED_URL_CREDENTIAL)$/.test(aggregate.key)) {
      const anchored = rows.reduce((sum, row) => sum + transferFindings(JSON.stringify(row.value), { keyNames: false, lineKeys: false, lockfile: true }).filter(h => h.key === aggregate.key).reduce((n, h) => n + h.count, 0), 0);
      if (anchored >= aggregate.count) continue;
    }
    const locations = [];
    lines.forEach((line, i) => {
      if (transferFindings(line, opts).some(h => h.key === aggregate.key)) locations.push(i + 1);
    });
    hits.push(safeHit(file, aggregate.key, 'transfer:' + aggregate.key, locations[0] || 1, aggregate.count));
    hits.at(-1).lines = locations;
  }
  const headerHits = new Map();
  for (const m of text.matchAll(/-H[\t ]+["']([A-Za-z][\w-]*):[\t ]*([^"'\r\n]*)["']/g)) {
    for (const h of transferFindings(m[1] + '=' + m[2], { keyNames: true, lineKeys: true })) {
      if (hits.some(hit => hit.field === h.key)) continue;
      const hit = headerHits.get(h.key) || { ...safeHit(file, h.key, 'transfer:' + h.key, text.slice(0, m.index).split('\n').length, 0), lines: [] };
      hit.count += h.count; hit.lines.push(text.slice(0, m.index).split('\n').length); headerHits.set(h.key, hit);
    }
  }
  hits.push(...headerHits.values());
  for (const item of rows) {
    // Value-shape matching is independent of the field name, including C++ headers.
    for (const shape of transferFindings(JSON.stringify(item.value), { keyNames: false, lineKeys: false, lockfile: true })) {
      if (!hits.some(h => h.detector === 'transfer:' + shape.key && h.lines.includes(item.line))) {
        hits.push({ ...safeHit(file, item.field, 'shape:' + shape.key, item.line), ordinal: item.ordinal });
      }
    }
    if (/^(?:sk|ak)_[A-Za-z0-9_-]{16,}$/.test(item.value))
      hits.push({ ...safeHit(file, item.field, 'known-prefix', item.line), ordinal: item.ordinal });
    // Preserve identifiers and home paths; entropy does not authorize rewriting.
    if (compiled.test(file) && !/^[A-Za-z_][A-Za-z0-9_.:/-]*$/.test(item.value)
      && !/^(?:\/|\.\.?\/|[A-Za-z]:[\\/])/.test(item.value) && highEntropy(item.value))
      hits.push({ ...safeHit(file, item.field, 'highEntropyReview', item.line), ordinal: item.ordinal });
  }
  return { hits, rows };
}

export function validateProfile(profile) {
  if (profile.version !== 1 || !Array.isArray(profile.rules) || !Array.isArray(profile.excludePrefixes)) throw Error('invalid exporter profile');
  const ids = new Set();
  for (const r of profile.rules) {
    if (!r.id || ids.has(r.id) || !r.path || r.path.startsWith('/') || r.path.split('/').includes('..') || !r.field || !r.reason
      || !['approved', 'proposed'].includes(r.state) || !['rewrite', 'KEEP', 'delete-path', 'bach-empty'].includes(r.action)
      || !Number.isSafeInteger(r.count) || r.count < 1) throw Error('invalid reviewed rule');
    if (r.action === 'KEEP' && (!r.anchor || !r.ordinal || /\*/.test(r.path) || !r.detector)) throw Error('KEEP needs an exact structural anchor');
    if (r.action === 'rewrite' && (!r.anchor || !r.detector)) throw Error('rewrite needs a structural anchor');
    if (r.action === 'delete-path' && (/\*/.test(r.path) || !r.anchor?.mode)) throw Error('path deletion needs an exact path and mode');
    ids.add(r.id);
  }
  return profile;
}

export function sanitizeText(text, file, profile) {
  const applicable = profile.rules.filter(r => pathMatch(r.path, file));
  const receipts = [], failures = [], observed = [], observations = [];
  for (const rule of applicable.filter(r => r.action === 'bach-empty' && r.state === 'approved')) {
    const items = literals(text).filter(item => item.field === rule.field);
    // Bach permits only one ordinary literal after its exact declaration.
    const item = items[0];
    const declared = item && new RegExp('^' + rule.declaration.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*=\\s*$').test(item.before);
    if (items.length !== rule.count || !declared || !/^"(?:\\.|[^"\\])*"$/.test(item.raw) || item.after !== ';') {
      failures.push(safeHit(file, rule.field, 'bach-shape-or-count', item?.line || 1)); continue;
    }
    text = text.slice(0, item.start) + '""' + text.slice(item.end);
    observed.push(rule.id); receipts.push({ path: file, field: rule.field, rule: rule.id, rewritten: item.value.length ? 1 : 0, noOp: item.value.length ? 0 : 1 });
  }
  let { hits, rows } = scanText(text, file);
  const edits = [];
  for (const rule of applicable.filter(r => r.state === 'approved' && ['KEEP', 'rewrite'].includes(r.action))) {
    if (rule.action === 'rewrite' && rule.anchor.syntax) {
      if (compiled.test(file)) { failures.push(safeHit(file, rule.field, 'compiled-name-rewrite-refused', 1)); continue; }
      const escaped = rule.field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const selectors = {
        'properties-assignment': new RegExp('^(\\s*(?:[#!]\\s*)?' + escaped + '\\s*[=:]\\s*)([^\\r\\n]*)(?=\\r?$)', 'gm'),
        'gradle-reference': new RegExp('^(\\s*' + escaped + '\\s+)([A-Za-z_$][\\w$]*(?:\\.[A-Za-z_$][\\w$]*)*)([\\t ]*;?[\\t ]*)(?=\\r?$)', 'gm'),
        'curl-header': new RegExp('(-H[\\t ]+["\']' + escaped + ':[\\t ]*)([^"\'\\r\\n]*)(["\'])', 'g'),
      };
      const selector = selectors[rule.anchor.syntax], matches = selector ? [...text.matchAll(selector)] : [];
      const matched = hits.filter(h => h.field === rule.field && h.detector === rule.detector);
      if (matches.length !== rule.count || matched.reduce((sum, h) => sum + h.count, 0) !== rule.count) {
        failures.push(safeHit(file, rule.field, 'reviewed-anchor-drift', matched[0]?.line || 1)); continue;
      }
      for (const m of matches) {
        edits.push({ start: m.index + m[1].length, end: m.index + m[1].length + m[2].length,
          replacement: rule.anchor.syntax === 'gradle-reference' ? '""' : '' });
      }
      observed.push(rule.id); receipts.push({ path: file, field: rule.field, rule: rule.id, rewritten: rule.count });
      continue;
    }
    const items = rows.filter(item => item.field === rule.field && (!rule.ordinal || item.ordinal === rule.ordinal));
    const matched = hits.filter(h => h.field === rule.field && h.detector === rule.detector);
    const anchorOK = items.every(item => item.before === rule.anchor?.before && item.after === rule.anchor?.after);
    if (items.length !== rule.count || !anchorOK || matched.reduce((sum, h) => sum + h.count, 0) !== rule.count) {
      failures.push(safeHit(file, rule.field, 'reviewed-anchor-drift', items[0]?.line || 1)); continue;
    }
    // Strong value-shape findings can never be retained with a KEEP.
    if (rule.action === 'KEEP' && matched.some(h => /^(?:shape:|known-prefix)|transfer:(?:PRIVATE_KEY_BLOCK|AKIA_ACCESS_KEY|JWT|EMBEDDED_URL_CREDENTIAL)$/.test(h.detector))) {
      failures.push(safeHit(file, rule.field, 'KEEP-value-shape-refused', items[0]?.line || 1)); continue;
    }
    if (rule.action === 'rewrite') {
      if (compiled.test(file) && !/^(?:shape:|known-prefix)/.test(rule.detector)) {
        failures.push(safeHit(file, rule.field, 'compiled-name-rewrite-refused', items[0]?.line || 1)); continue;
      }
      if (items.some(item => !(compiled.test(file) ? /^"(?:\\.|[^"\\])*"$/ : /^(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')$/).test(item.raw))) {
        failures.push(safeHit(file, rule.field, 'rewrite-literal-shape', items[0]?.line || 1)); continue;
      }
      edits.push(...items.map(item => ({ ...item, replacement: item.raw[0] === "'" ? "''" : '""' })));
    } else hits = hits.filter(h => !matched.includes(h));
    observed.push(rule.id); receipts.push({ path: file, field: rule.field, rule: rule.id, [rule.action === 'KEEP' ? 'kept' : 'rewritten']: rule.count });
  }
  for (const edit of edits.sort((a, b) => b.start - a.start)) text = text.slice(0, edit.start) + edit.replacement + text.slice(edit.end);
  if (edits.length) {
    hits = scanText(text, file).hits.filter(h => !receipts.some(r => r.kept && applicable.some(rule => rule.id === r.rule && rule.field === h.field && rule.detector === h.detector)));
  }
  for (const hit of hits) {
    if (hit.detector === 'highEntropyReview' || !runnerScansPath(file) && hit.detector.startsWith('transfer:')
      && !/^transfer:(?:PRIVATE_KEY_BLOCK|AKIA_ACCESS_KEY|JWT|EMBEDDED_URL_CREDENTIAL)$/.test(hit.detector)) {
      observations.push({ ...hit, state: 'report-only' }); continue;
    }
    const proposed = applicable.find(r => r.state === 'proposed' && r.field === hit.field);
    failures.push({ ...hit, state: proposed ? 'proposed' : 'unresolved', ...(proposed ? { proposal: proposed.id } : {}) });
  }
  return { text, findings: failures, receipts, observed, observations };
}
