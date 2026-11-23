// Scan XML printed in logs without parsing or rewriting the surrounding document.
// JSON escapes are decoded by the shared redactor before this detector runs.
import { credentialLabel } from './credential-labels.mjs';
const placeholder = value => /^(?:\[[^\]]*(?:masked|redact)[^\]]*\]|REDACTED|\*+)$/i.test(value);
const reference = value => /^@(?:\+)?(?:[\w.]+:)?[\w.]+\//.test(value)
  || /(?<!\\)\$(?:[A-Za-z_]\w*|\{[^}]*\})/.test(value);

// cat -n, grep -n (including context lines), and diff prefixes are transport,
// not part of a value. Only recognize them at the physical start of a line.
const linePrefix = /^[\t ]*(?:[+-][\t ]*)?(?:\d+(?:\t|[:-])[\t ]*)?/;
const gapOnly = text => text.split(/\r?\n/).every(line => !line.replace(linePrefix, '').trim());

function* tags(text) {
  const pattern = /<(\/?)([A-Za-z_][\w:.-]*)\b/g;
  for (let match; (match = pattern.exec(text));) {
    let quote, end = pattern.lastIndex;
    for (; end < text.length; end++) {
      const char = text[end];
      if (quote) { if (char === quote) quote = undefined; }
      else if (char === '"' || char === "'") quote = char;
      else if (char === '>' || char === '<') break;
    }
    if (text[end] !== '>') { pattern.lastIndex = end; continue; }
    const start = match.index, contentStart = pattern.lastIndex;
    pattern.lastIndex = end + 1;
    yield { start, end: end + 1, contentStart, name: match[2], closing: !!match[1],
      selfClosing: text.slice(contentStart, end).trimEnd().endsWith('/') };
  }
}

function attributes(text, tag) {
  const result = new Map(), body = text.slice(tag.contentStart, tag.end - 1);
  const pattern = /([A-Za-z_][\w:.-]*)/g;
  const gap = index => {
    while (index < body.length) {
      if (body[index] === '\n') {
        index++;
        index += body.slice(index).match(linePrefix)[0].length;
      } else if (/[\t \r]/.test(body[index])) index++;
      else break;
    }
    return index;
  };
  for (let match; (match = pattern.exec(body));) {
    let index = gap(pattern.lastIndex);
    if (body[index] !== '=') continue;
    index = gap(index + 1);
    const quote = body[index];
    if (quote !== '"' && quote !== "'") continue;
    const start = index + 1, end = body.indexOf(quote, start);
    if (end < 0) break;
    pattern.lastIndex = end + 1;
    result.set(match[1], { start: tag.contentStart + start, end: tag.contentStart + end });
  }
  return result;
}

function valueParts(text, start, end) {
  const parts = [], pattern = /[^\r\n]+/g, body = text.slice(start, end);
  for (const match of body.matchAll(pattern)) {
    let from = start + match.index, value = match[0];
    if (from === 0 || text[from - 1] === '\n') {
      const prefix = value.match(linePrefix)[0]; from += prefix.length; value = value.slice(prefix.length);
    }
    const leading = value.length - value.trimStart().length;
    from += leading; value = value.trim();
    if (value) parts.push({ start: from, end: from + value.length, value });
  }
  return parts;
}

export function xmlLogFindings(text, publicValue, jsonStrings = [], fileBlocks = []) {
  const hits = [], labelRanges = [];
  const collect = (range, field) => {
    const parts = valueParts(text, range.start, range.end);
    const value = parts.map(part => part.value).join('\n');
    if (!value || publicValue(value) || placeholder(value) || reference(value)) return;
    for (const part of parts) if (!placeholder(part.value))
      hits.push({ line: 0, field: field.toLowerCase(), start: part.start, end: part.end });
  };
  let open, pair, json = 0, block = 0;
  for (const tag of tags(text)) {
    while (block < fileBlocks.length && fileBlocks[block][1] <= tag.start) block++;
    const structural = fileBlocks[block]?.[0] <= tag.start && tag.start < fileBlocks[block][1];
    while (jsonStrings[json]?.index + jsonStrings[json]?.length <= tag.start) json++;
    if (jsonStrings[json]?.index < tag.start) continue; // Already handled after JSON decoding.
    if (open && tag.closing && tag.name === open.name) {
      const range = { start: open.end, end: tag.start };
      if (open.name === 'key') {
        labelRanges.push([range.start, range.end]);
        const label = valueParts(text, range.start, range.end).map(part => part.value).join('');
        pair = credentialLabel(label) ? { label, end: tag.end } : undefined;
      } else if (open.label) collect(range, open.label);
      open = undefined;
      continue;
    }
    // Nested or unrelated elements must never associate a label with a later value.
    open = undefined;
    const pairedLabel = pair && gapOnly(text.slice(pair.end, tag.start)) ? pair.label : undefined;
    pair = undefined;
    if (tag.closing) continue;
    if (tag.name === 'meta-data') {
      const attrs = attributes(text, tag), name = attrs.get('android:name'), value = attrs.get('android:value');
      if (name) labelRanges.push([name.start - 1, name.end + 1]);
      const label = name && text.slice(name.start, name.end);
      if (value && credentialLabel(label || '')) collect(value, label);
    } else if (tag.name === 'key' || tag.name === 'string') {
      const name = attributes(text, tag).get('name');
      if (name) labelRanges.push([name.start - 1, name.end + 1]);
      const label = name ? text.slice(name.start, name.end) : pairedLabel;
      if (!tag.selfClosing) open = { ...tag, label: credentialLabel(label || '') ? label : undefined };
    } else if (structural && !tag.selfClosing) open = { ...tag, label: tag.name };
  }
  return { hits, labelRanges };
}
