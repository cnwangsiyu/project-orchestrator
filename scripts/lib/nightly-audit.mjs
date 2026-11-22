const fields = 'password|passphrase|passwd|pwd|pass|token|secret[_-]?access[_-]?key|secret|api[_-]?key|access[_-]?key(?:[_-]?id)?|private[_-]?key|credentials?|auth|username|ak|sk|x-(?:tos|amz)-(?:credential|signature|security-token)|signature';
import { maskPrivateKeyBlocks } from './private-key-blocks.mjs';
import { buildLogFindings } from './build-log-findings.mjs';
import { xmlLogFindings } from './xml-log-findings.mjs';

const quotedValue = String.raw`"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'`;
const inlineQuotedValue = String.raw`"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'`;
const bareValue = String.raw`\$\{[^}\r\n]*\}|<[^>\r\n]*>|\[[^\]\r\n]*\]|[^\s,;{}"'\[\]<>]+`;
// A minus is a diff prefix only at the start of a line, not inside an ordinary word.
const assignmentKey = String.raw`(?:(?<![\w.-])|(?<=^[+-])|(?<=^--)|(?<=[\t ]--)|(?<=[\t ]-))(["']?)(${fields})\1`;
const assignments = new RegExp(String.raw`${assignmentKey}([\t ]*[:=][\t ]*)(${quotedValue}|${bareValue})`, 'gim');
const whitespaceAssignments = new RegExp(String.raw`${assignmentKey}([\t ]+)(${inlineQuotedValue}|${bareValue})`, 'gim');
const properties = new RegExp(String.raw`^([+-]?[\t ]*(?:export[\t ]+)?)(["']?)([A-Za-z_][\w.-]*)\2([\t ]*[:=][\t ]*)(${quotedValue}|${bareValue})`, 'gm');
// Source assignments are deliberately limited to complete string-literal values.
const sourceAssignments = new RegExp(String.raw`(?<![\w.-])([A-Za-z_$][\w$]*)([\t ]*(?::[\t ]*[\w?.<>\[\]]+[\t ]*)?=[\t ]*@?)(${inlineQuotedValue})(?=[\t ]*(?:$|[;,)}\r\n]|//|/\*))`, 'gm');
const dslCalls = new RegExp(String.raw`(?<![\w$-])([A-Za-z_$][\w$]*)([\t ]*(?:\.[\t ]*set[\t ]*)?\([\t ]*)(${inlineQuotedValue})(?=[\t ]*\))`, 'gm');
const dslWhitespace = new RegExp(String.raw`(?<![\w$.-])([A-Za-z_$][\w$]*)([\t ]*)(${inlineQuotedValue})(?![\t ]*[+.([])`, 'gm');
const sourceField = value => /(?:Password|Passphrase|Passwd|Token|Secret|ApiKey|AccessKey|PrivateKey|Credentials?|Auth|Key)$/.test(value)
  || /(?:^|_)(?:password|passphrase|passwd|token|secret|api_key|access_key|private_key|credentials?|auth|key)$/i.test(value);
const exactField = new RegExp(`^(?:${fields})$`, 'i');
// Repository usernames need repository context; the other requested names are wildcards.
const repositoryUser = value => /user(?:name)?/i.test(value) && /repo|maven|nexus|artifactory/i.test(value);
const credentialField = value => !/^keyAlias$/i.test(value) && (
  /^nexus/i.test(value) || /magic|credential|auth|pass|pwd|secret|token|key/i.test(value)
  || repositoryUser(value));
const publicValue = value => /^(?:true|false)$/i.test(value)
  || /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?[fLdD]?$|^0[xob][\da-f]+$/i.test(value)
  || /^v?\d+(?:[._-]\d+)+(?:[-+][\w.-]+)?$/i.test(value)
  || /^(?:[a-z][a-z\d+.-]*:\/|\/\/)/i.test(value);
const referenceValue = value => /(?<!\\)\$(?:[A-Za-z_]\w*|\{[^}]*\})/.test(value)
  || /^(?:[A-Za-z_$][\w$]*\.)*[A-Za-z_$][\w$]*\(/.test(value);
// Punctuation around a word (or a hyphenated English phrase) is not token entropy.
const tokenLikeValue = value => value.length >= 8 && !/[\s|]/.test(value) && /[\d\W_]/.test(value)
  && !/^[^A-Za-z0-9]*[A-Za-z]+(?:[-'][A-Za-z]+)*[^A-Za-z0-9]*$/.test(value);
const markdownRow = (text, index) => /^[\t ]*\|/.test(text.slice(text.lastIndexOf('\n', index - 1) + 1, index));
const cellValue = raw => raw.split(/(?<!\\)\|/, 1)[0];

function* boundedMatches(text, pattern, valueGroup = 4) {
  const matcher = new RegExp(pattern.source, pattern.flags);
  for (let match; (match = matcher.exec(text));) {
    const raw = match[valueGroup], quoted = raw[0] === '"' || raw[0] === "'";
    if (!quoted && markdownRow(text, match.index) && cellValue(raw).length !== raw.length) {
      // Resume at the next cell instead of swallowing its independent assignments.
      matcher.lastIndex = match.index + match[0].length - raw.length + cellValue(raw).length + 1;
    }
    yield match;
  }
}

function quotedRanges(text, { multiline = false } = {}) {
  const ranges = [];
  for (let i = 0; i < text.length; i++) {
    const quote = text[i];
    if (quote !== '"' && quote !== "'") continue;
    const start = i; let closed = false;
    for (i++; i < text.length; i++) {
      if (!multiline && (text[i] === '\n' || text[i] === '\r')) { i = start; break; }
      if (text[i] === '\\') { i++; continue; }
      if (text[i] === quote) { ranges.push({ index: start, length: i - start + 1 }); closed = true; break; }
    }
    if (!closed && i >= text.length) i = start;
  }
  return ranges;
}

function jsonStringRanges(text) {
  const ranges = [];
  for (const range of quotedRanges(text)) {
    if (text[range.index] !== '"') continue;
    let before = range.index - 1;
    while (before >= 0 && /[\t ]/.test(text[before])) before--;
    if (before >= 0 && !':[,'.includes(text[before])) continue;
    try {
      const decoded = JSON.parse(text.slice(range.index, range.index + range.length));
      ranges.push({ ...range, decoded });
    } catch {}
  }
  return ranges;
}

function credentialBlocks(text) {
  const stack = [], blocks = [];
  let active = 0, start, quoted = 0;
  const ranges = quotedRanges(text, { multiline: true });
  // Scan linearly: V8's quoted-string regexp can overflow on giant compiler-log lines.
  for (let i = 0; i < text.length; i++) {
    while (ranges[quoted]?.index + ranges[quoted]?.length <= i) quoted++;
    if (ranges[quoted]?.index === i) { i += ranges[quoted].length - 1; quoted++; continue; }
    if (text[i] === '}') {
      if (stack.pop() && --active === 0) blocks.push([start, i]);
    } else {
      let credential = false, brace = text[i] === '{';
      if (!brace && (i === 0 || !/[\w$]/.test(text[i - 1]))
        && text.slice(i, i + 11).toLowerCase() === 'credentials'
        && !/[\w$]/.test(text[i + 11] || '')) {
        let end = i + 11;
        while (/\s/.test(text[end] || '')) end++;
        if (text[end] === '(') {
          let nesting = 1, quote;
          for (end++; end < text.length && nesting; end++) {
            const char = text[end];
            if (quote) {
              if (char === '\\') end++;
              else if (char === quote) quote = undefined;
            } else if (char === '"' || char === "'") quote = char;
            else if (char === '(') nesting++;
            else if (char === ')') nesting--;
          }
          while (/\s/.test(text[end] || '')) end++;
        }
        if (text[end] === '{') { credential = true; brace = true; i = end; }
      }
      if (!brace) continue;
      stack.push(credential);
      if (credential && active++ === 0) start = i;
    }
  }
  if (active) blocks.push([start, text.length]);
  return blocks;
}

// Only offsets and field names leave this private matcher, never suspected values.
// HTTP auth headers: the whole header value (Cookie/Set-Cookie pairs, Authorization schemes) is secret.
const headers = /(?:(?<![\w-])|(?<=^[+-]))(set-cookie|cookie|authorization|proxy-authorization|x-[\w-]*(?:token|api-key|auth)[\w-]*)([\t ]*:[\t ]*)([^\r\n"]+)/gim;

// tosutil takes its key pair as `-i <AK> -k <SK>`; these short flags are too generic to mask elsewhere.
const tosutilKeys = /(?<=\btosutil\b[^\r\n]*[\t ])-([ik])([\t ]+)([^\s"']+)/gi;

function visitSecrets(text, visit) {
  const { hits, labelRanges } = xmlLogFindings(text, publicValue, jsonStringRanges(text));
  for (const hit of buildLogFindings(text, credentialBlocks(text), publicValue, labelRanges)) hits.push(hit);
  collectSecrets(text, (hit) => hits.push(hit), labelRanges);
  for (const match of text.matchAll(tosutilKeys)) {
    const start = match.index + 1 + match[1].length + match[2].length;
    hits.push({ line: 0, field: `tosutil -${match[1]}`, start, end: start + match[3].length });
  }
  for (const match of boundedMatches(text, headers, 3)) {
    const value = (markdownRow(text, match.index) ? cellValue(match[3]) : match[3]).trimEnd();
    if (!value || /^(?:\[[^\]]*(?:redact|masked)[^\]]*\]|REDACTED|\*+)$/i.test(value)) continue;
    const start = match.index + match[1].length + match[2].length;
    hits.push({ line: 0, field: match[1].toLowerCase(), start, end: start + value.length });
  }
  hits.sort((a, b) => a.start - b.start || b.end - a.end);
  let line = 1, offset = 0, last = -1;
  for (const hit of hits) {
    if (hit.start < last) continue; // overlapping match already covered
    for (; offset < hit.start; offset++) if (text[offset] === '\n') line++;
    visit({ ...hit, line }); last = hit.end;
  }
}

function collectSecrets(text, visit, labelRanges = []) {
  const blocks = credentialBlocks(text);
  const strings = quotedRanges(text);
  let string = 0, label = 0;
  let line = 1, offset = 0, block = 0;
  const matches = [...boundedMatches(text, assignments), ...boundedMatches(text, whitespaceAssignments)]
    .filter(match => {
      if (/^@["']/.test(text.slice(match.index + match[0].length - match[4].length))) return false;
      if (match[3].includes(':') || !sourceField(match[2]) || !/[a-z][A-Z]/.test(match[2])) return true;
      const quoted = /^["']/.test(match[4]);
      return quoted && !/^[\t ]*[+.([]/.test(text.slice(match.index + match[0].length));
    });
  for (const match of text.matchAll(properties)) {
    if (!(exactField.test(match[3]) || credentialField(match[3]) || /^keyAlias$/i.test(match[3]))) continue;
    if (/^keyAlias$/i.test(match[3]) && !/^["']/.test(match[5])) continue;
    if (/^@["']/.test(text.slice(match.index + match[0].length - match[5].length))) continue;
    // Preserve source references without treating punctuation in properties as an expression.
    if (!match[3].includes('.') && !match[4].includes(':')) {
      const quoted = /^["']/.test(match[5]);
      if (!quoted && (referenceValue(match[5]) || /^[A-Za-z_$][\w$]*(?:\.[\w$]+)*$/.test(match[5])
        && /^[\t ]*;/.test(text.slice(match.index + match[0].length)))) continue;
      if (quoted && /^[\t ]*[+.([]/.test(text.slice(match.index + match[0].length))) continue;
    }
    matches.push({ index: match.index + match[1].length, 0: match[0].slice(match[1].length),
      1: match[2], 2: match[3], 3: match[4], 4: match[5] });
  }
  for (const match of text.matchAll(sourceAssignments)) {
    if (!(sourceField(match[1]) || credentialField(match[1]) || /^keyAlias$/i.test(match[1]))) continue;
    matches.push({ index: match.index, 0: match[0], 1: '', 2: match[1], 3: match[2], 4: match[3] });
  }
  for (const pattern of [dslCalls, dslWhitespace]) {
    for (const match of text.matchAll(pattern)) {
      if (!(exactField.test(match[1]) || sourceField(match[1]) || credentialField(match[1]) || /^keyAlias$/i.test(match[1]))) continue;
      matches.push({ index: match.index, 0: match[0], 1: '', 2: match[1], 3: match[2], 4: match[3] });
    }
  }
  matches.sort((a, b) => a.index - b.index);
  for (const match of matches) {
    while (labelRanges[label]?.[1] <= match.index) label++;
    if (labelRanges[label]?.[0] <= match.index && match.index < labelRanges[label][1]) continue;
    while (string < strings.length && strings[string].index + strings[string].length <= match.index) string++;
    if (strings[string]?.index < match.index) continue; // A mention inside a log message is not source code.
    for (; offset < match.index; offset++) if (text[offset] === '\n') line++;
    const field = match[2].toLowerCase(), originalRaw = match[4];
    const table = markdownRow(text, match.index), whitespace = !/[:=]/.test(match[3]);
    const quoted = originalRaw[0] === '"' || originalRaw[0] === "'";
    if (field === 'username' && quoted && /^[\t ]*[+.([]/.test(text.slice(match.index + match[0].length))) continue;
    if (match[1] && match[3].includes(':') && !quoted && /^[A-Za-z_$][\w$]*(?:\.[\w$]+)*$/.test(originalRaw)) continue;
    // Markdown status cells are not password aliases, even when their details are quoted.
    if (table && whitespace && match[2] === 'PASS') continue;
    const raw = table && !quoted ? cellValue(originalRaw) : originalRaw;
    while (block < blocks.length && blocks[block][1] < match.index) block++;
    if (field === 'username' && !(blocks[block]?.[0] < match.index)) continue;
    if (field === 'pass' && !match[1] && match[3].trim() === ':') continue;
    const value = quoted ? raw.slice(1, -1) : raw;
    if (whitespace && !quoted && !tokenLikeValue(value)) continue;
    if (!value || publicValue(value) || referenceValue(value)
      || field === 'keyalias' && !tokenLikeValue(value)
      || /^(?:<[^>]+>|\[[^\]]*(?:redact|masked)[^\]]*\]|\{[^}]*(?:redact|masked)[^}]*\}|REDACTED|\*+)$/i.test(value)) continue;
    const start = match.index + match[0].length - originalRaw.length + Number(quoted);
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

const OPAQUE_KEYS = new Set(['encrypted_content']);

function walkStrings(value, transform) {
  if (typeof value === 'string') return transform(value);
  const pending = [value];
  while (pending.length) {
    const object = pending.pop();
    if (!object || typeof object !== 'object') continue;
    for (const key of Object.keys(object)) {
      // Opaque provider ciphertext (reasoning items) must stay byte-identical, or the
      // thread can no longer be resumed (HTTP 400 invalid_encrypted_content, BC-109).
      if (OPAQUE_KEYS.has(key)) continue;
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
  const blocks = maskPrivateKeyBlocks(text);
  let masked = blocks.masked;
  const result = processLog(blocks.text, jsonl, (string) => {
    const urls = maskExecURLQueries(string); masked += urls.masked;
    const prose = maskDocumentCredentials(urls.text); masked += prose.masked;
    const result = maskPasswordStyleValues(prose.text); masked += result.masked;
    return result.text;
  });
  return { text: result, masked, lines: text ? text.split('\n').length - Number(text.endsWith('\n')) : 0 };
}

// Temporary exec links can use short, otherwise innocuous parameter names.
// Preserve the URL and parameter names, masking every value for Kross/webshell
// links and credential-named parameters on other URLs.
export function maskExecURLQueries(text) {
  let masked = 0;
  const result = text.replace(/https?:[\\]*\/[\\]*\/[^\s"'<>]+/gi, (raw, index) => {
    const context = text.slice(Math.max(0, index - 160), index);
    const closing = context.endsWith('(') && raw.endsWith(')') ? ')' : '';
    if (closing) raw = raw.slice(0, -1);
    const signed = [...raw.matchAll(/[?&]([^=&#]+)=/g)].some(match => {
      let name; try { name = decodeURIComponent(match[1]); } catch { name = match[1]; }
      return /sign|signature|token|expires|auth|ticket|(?:^|amp;)x-amz-|(?:^|amp;)x-tos-/i.test(name);
    });
    const temporary = signed || /kross|webshell|\/(?:exec|terminal)(?:[/?]|$)/i.test(raw.replace(/\\\//g, '/'))
      || /(?:webshell|exec|terminal)[_-]?(?:url|link)?["'\s]*[:=]["'\s]*$/i.test(context);
    return raw.replace(/([?&]([^=&#]*)=)([^&#]*)/g, (param, prefix, key, value) => {
      let name; try { name = decodeURIComponent(key); } catch { name = key; }
      if (!temporary && !/token|secret|password|passwd|credential|signature|auth|session|ticket|^sign$|^(?:(?:api|access|private|client)[_-]?)?key$|^code$/i.test(name)) return param;
      const escapedQuote = value.match(/\\+$/)?.[0] ?? '';
      const content = escapedQuote ? value.slice(0, -escapedQuote.length) : value;
      if (!content || /^(?:\[MASKED\]|%5BMASKED%5D)$/i.test(content)) return param;
      masked++; return prefix + '[MASKED]' + escapedQuote;
    }) + closing;
  });
  return { text: result, masked };
}

export function maskDocumentCredentials(text, depth = 0) {
  let masked = 0;
  if (depth < 8) {
    const ranges = jsonStringRanges(text);
    for (const range of ranges.reverse()) {
      try {
        const urls = maskExecURLQueries(range.decoded), prose = maskDocumentCredentials(urls.text, depth + 1), nested = maskPasswordStyleValues(prose.text);
        if (urls.masked || prose.masked || nested.masked) {
          masked += urls.masked + prose.masked + nested.masked;
          text = text.slice(0, range.index) + JSON.stringify(nested.text) + text.slice(range.index + range.length);
        }
      } catch {}
    }
  }
  const value = String.raw`("(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|\$\{[^}\r\n]*\}|(?![\\@]["'])[^\s,;，。；、"'<>{}\[\]|]+)`;
  const chinese = new RegExp(String.raw`(账号密码|密码|口令|密钥|令牌)([\t ]*(?:[:：是为])[\t ]*)${value}`, 'g');
  const replace = (prefix, raw) => {
    const quoted = raw[0] === '"' || raw[0] === "'", body = quoted ? raw.slice(1, -1) : raw;
    if (!body || /\[MASKED|REDACTED/i.test(body)) return prefix + raw;
    masked++; return prefix + (quoted ? raw[0] + '[MASKED]' + raw[0] : '[MASKED]');
  };
  let result = text.replace(chinese, (_, key, separator, raw) => replace(key + separator, raw));
  const safeAlt = alt => alt.replace(/\b(?:[a-z0-9_-]+\.)+[a-z][a-z0-9.-]*\b/gi, host => {
      if (!host.split('.').some(part => part.length >= 24 && /[a-z]/i.test(part) && /\d/.test(part))) return host;
      masked++; return '[MASKED HOSTNAME]';
  });
  result = result.replace(/!\[([^\]]*)\](?=\()/g, (_, alt) => '![' + safeAlt(alt) + ']');
  result = result.replace(/(<img\b[^>]*\balt\s*=\s*["'])([^"']*)(["'])/gi, (_, prefix, alt, suffix) => prefix + safeAlt(alt) + suffix);
  return { text: result, masked };
}
