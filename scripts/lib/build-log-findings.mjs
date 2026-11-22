// Build tools echo properties inside prose and quoted log messages as well as DSL.
// Return offsets only; the shared redactor owns replacement and overlap handling.
const fields = /(?<![\w$.-])(["']?)((?:-[PD])?[A-Za-z_][\w.-]*)\1([\t ]*(?:[:=][\t ]*|[\t ]+))/g;
const sensitive = name => /(?:password|passwd|token|secret|magic[._-]?word)$/i.test(name)
  || /(?:^|[._-])key$/i.test(name) || /Key$/.test(name);
const user = name => /user(?:name)?$/i.test(name);
const stem = name => name.replace(/(?:password|passwd|token|secret|magic[._-]?word|key|user(?:name)?)$/i, '')
  .replace(/[._-]/g, '').toLowerCase();
const property = name => /^-[PD]|^ORG_GRADLE_PROJECT_|^systemProp\.|^(?:NEXUS|MAVEN|ARTIFACTORY)_/i.test(name);
const reference = value => /(?<!\\)\$(?:[A-Za-z_]\w*|\{[^}]*\})/.test(value)
  || /^(?:[A-Za-z_$][\w$]*\.)*[A-Za-z_$][\w$]*\(/.test(value);
const placeholder = value => !value || /^(?:\[[^\]]*(?:masked|redact)[^\]]*\]|<[^>]*>|REDACTED|\*+)$/i.test(value);

function valueAt(text, index) {
  if (text.startsWith('${', index)) return null;
  const quote = text[index];
  if (quote === '"' || quote === "'") {
    // A scanner avoids regexp stack overflow on giant compiler-log strings.
    for (let end = index + 1; end < text.length && !/[\r\n]/.test(text[end]); end++) {
      if (text[end] === '\\') { end++; continue; }
      if (text[end] === quote) return { start: index + 1, end };
    }
    return null;
  }
  let end = index;
  while (end < text.length && !/[\s,;{}"'\[\]<>]/.test(text[end])) end++;
  return end > index ? { start: index, end } : null;
}

export function buildLogFindings(text, blocks, publicValue, labelRanges = []) {
  const hits = [], assignments = [], paired = new Set();
  let label = 0;
  for (const match of text.matchAll(fields)) {
    while (labelRanges[label]?.[1] <= match.index) label++;
    if (labelRanges[label]?.[0] <= match.index && match.index < labelRanges[label][1]) continue;
    const value = valueAt(text, match.index + match[0].length);
    if (!value) continue;
    const name = match[2], normalized = name.replace(/^-[PD]/, '');
    const valueStart = match.index + match[0].length;
    const entry = { ...value, index: match.index, name, normalized, property: property(name),
      quoted: text[valueStart] === '"' || text[valueStart] === "'" };
    assignments.push(entry);
    if (entry.property && sensitive(normalized)) paired.add(stem(normalized));
  }
  let block = 0, lineStart = 0, lineEnd = text.indexOf('\n');
  if (lineEnd < 0) lineEnd = text.length;
  let mavenInfo = /\bMAVEN[\t ]+INFO\b/i.test(text.slice(lineStart, lineEnd));
  for (const entry of assignments) {
    while (lineEnd < entry.index) {
      lineStart = lineEnd + 1; lineEnd = text.indexOf('\n', lineStart);
      if (lineEnd < 0) lineEnd = text.length;
      mavenInfo = /\bMAVEN[\t ]+INFO\b/i.test(text.slice(lineStart, lineEnd));
    }
    while (block < blocks.length && blocks[block][1] < entry.index) block++;
    const inBlock = blocks[block]?.[0] < entry.index && entry.index < blocks[block][1];
    const name = entry.normalized;
    const selected = entry.property && (sensitive(name) || user(name) && paired.has(stem(name)))
      || mavenInfo && (sensitive(name) || user(name) || /^credentials?$/i.test(name))
      || inBlock && entry.quoted && /^username$/i.test(name);
    const value = text.slice(entry.start, entry.end);
    if (!mavenInfo) {
      if (publicValue(value)) continue;
      if (entry.quoted && /^[\t ]*[+.([]/.test(text.slice(entry.end + 1))) continue;
      if (!entry.quoted && !/^-[PD]/.test(entry.name) && !entry.name.includes('.')
        && /^[A-Za-z_$][\w$]*(?:\.[\w$]+)*$/.test(value)
        && /^[\t ]*;/.test(text.slice(entry.end))) continue;
    }
    if (selected && !placeholder(value) && !reference(value))
      hits.push({ line: 0, field: name.toLowerCase(), start: entry.start, end: entry.end });
  }
  // User/password URI pairs are sensitive even without a surrounding field label.
  for (const match of text.matchAll(/(?<![\w+.-])[a-z][a-z\d+.-]*:\/\/([^/\s"'<>]+)@/gi)) {
    const value = match[1];
    if (!value.includes(':') || placeholder(value) || reference(value)) continue;
    const start = match.index + match[0].length - value.length - 1;
    hits.push({ line: 0, field: 'repository userinfo', start, end: start + value.length });
  }
  for (const match of text.matchAll(/\b(X-[\w-]*Token)([\t ]*:[\t ]*)/gi)) {
    const start = match.index + match[0].length;
    const end = text.indexOf('\n', start), lineEnd = end < 0 ? text.length : end;
    const raw = text.slice(start, lineEnd).trimEnd();
    if (placeholder(raw) || reference(raw)) continue;
    // Quoted header values must leave their quotes and following log fields intact.
    const value = valueAt(text, start);
    const quoted = text[start] === '"' || text[start] === "'";
    if (!quoted || value) hits.push({ line: 0, field: match[1].toLowerCase(),
      start: quoted ? value.start : start, end: quoted ? value.end : start + raw.length });
  }
  return hits;
}
