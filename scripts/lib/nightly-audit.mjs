const fields = 'password|passphrase|passwd|pwd|pass|token|secret|api[_-]?key|access[_-]?key|private[_-]?key|credentials?|auth|username';
const quotedValue = String.raw`"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'`;
const bareValue = String.raw`\$\{[^}\r\n]*\}|<[^>\r\n]*>|\[[^\]\r\n]*\]|[^\s,;{}"'\[\]<>]+`;
const assignments = new RegExp(String.raw`(?<![\w-])(["']?)(${fields})\1([\t ]*(?:[:=][\t ]*|[\t ]+))(${quotedValue}|${bareValue})`, 'gi');

function credentialBlocks(text) {
  const stack = [], blocks = [];
  let active = 0, start;
  // Quoted braces and nested closures must not end a Gradle credentials block.
  for (const match of text.matchAll(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\bcredentials\s*\{|[{}]/gi)) {
    if (match[0][0] === '"' || match[0][0] === "'") continue;
    if (match[0] === '}') {
      if (stack.pop() && --active === 0) blocks.push([start, match.index]);
    } else {
      const credential = match[0] !== '{';
      stack.push(credential);
      if (credential && active++ === 0) start = match.index;
    }
  }
  if (active) blocks.push([start, text.length]);
  return blocks;
}

// Only offsets and field names leave this private matcher, never suspected values.
// HTTP auth headers: the whole header value (Cookie/Set-Cookie pairs, Authorization schemes) is secret.
const headers = /(?<![\w-])(set-cookie|cookie|authorization|proxy-authorization|x-[\w-]*(?:token|api-key|auth)[\w-]*)([\t ]*:[\t ]*)([^\r\n"]+)/gi;

function visitSecrets(text, visit) {
  const hits = [];
  collectSecrets(text, (hit) => hits.push(hit));
  for (const match of text.matchAll(headers)) {
    const value = match[3].trimEnd();
    if (!value || /^(?:\[[^\]]*(?:redact|masked)[^\]]*\]|REDACTED|\*+)$/i.test(value)) continue;
    const start = match.index + match[1].length + match[2].length;
    hits.push({ line: 0, field: match[1].toLowerCase(), start, end: start + value.length });
  }
  hits.sort((a, b) => a.start - b.start);
  let line = 1, offset = 0, last = -1;
  for (const hit of hits) {
    if (hit.start < last) continue; // overlapping match already covered
    for (; offset < hit.start; offset++) if (text[offset] === '\n') line++;
    visit({ ...hit, line }); last = hit.end;
  }
}

function collectSecrets(text, visit) {
  const blocks = credentialBlocks(text);
  let line = 1, offset = 0, block = 0;
  for (const match of text.matchAll(assignments)) {
    for (; offset < match.index; offset++) if (text[offset] === '\n') line++;
    const field = match[2].toLowerCase(), raw = match[4];
    while (block < blocks.length && blocks[block][1] < match.index) block++;
    if (field === 'username' && !(blocks[block]?.[0] < match.index)) continue;
    if (field === 'pass' && !match[1] && match[3].trim() === ':') continue;
    const quoted = raw[0] === '"' || raw[0] === "'";
    const value = quoted ? raw.slice(1, -1) : raw;
    if (!value || /^\$(?:[A-Za-z_]\w*|\{[^}]+\})$/.test(value) || /^(?:<[^>]+>|\[[^\]]*(?:redact|masked)[^\]]*\]|\{[^}]*(?:redact|masked)[^}]*\}|REDACTED|\*+)$/i.test(value)) continue;
    const start = match.index + match[0].length - raw.length + Number(quoted);
    visit({ line, field, start, end: start + raw.length - 2 * Number(quoted) });
  }
}

export function passwordStyleFindings(text) {
  const findings = [];
  visitSecrets(text, ({ line, field }) => findings.push({ line, field }));
  return findings;
}

export function maskPasswordStyleValues(text) {
  const parts = [];
  let offset = 0, masked = 0;
  visitSecrets(text, ({ start, end }) => {
    parts.push(text.slice(offset, start), '[MASKED]'); offset = end; masked++;
  });
  parts.push(text.slice(offset));
  return { text: parts.join(''), masked };
}

function walkStrings(value, transform) {
  if (typeof value === 'string') return transform(value);
  const pending = [value];
  while (pending.length) {
    const object = pending.pop();
    if (!object || typeof object !== 'object') continue;
    for (const key of Object.keys(object)) {
      if (typeof object[key] === 'string') object[key] = transform(object[key]);
      else if (object[key] && typeof object[key] === 'object') pending.push(object[key]);
    }
  }
  return value;
}

function processLog(text, jsonl, transform) {
  if (!jsonl) return transform(text);
  return text.split('\n').map((line, index) => {
    let value;
    try { value = JSON.parse(line); }
    catch { return transform(line, index + 1); }
    let changed = false;
    value = walkStrings(value, (string) => {
      const result = transform(string, index + 1);
      changed ||= result !== string;
      return result;
    });
    return changed ? JSON.stringify(value) : line;
  }).join('\n');
}

export function scanLogFindings(text, { jsonl = false } = {}) {
  const findings = [];
  processLog(text, jsonl, (string, line) => {
    for (const finding of passwordStyleFindings(string)) findings.push({ ...finding, line: line ?? finding.line });
    return string;
  });
  return findings;
}

export function maskLogText(text, { jsonl = false } = {}) {
  let masked = 0;
  const result = processLog(text, jsonl, (string) => {
    const result = maskPasswordStyleValues(string); masked += result.masked;
    return result.text;
  });
  return { text: result, masked, lines: text ? text.split('\n').length - Number(text.endsWith('\n')) : 0 };
}
