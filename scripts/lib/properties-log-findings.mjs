import { credentialLabel } from './credential-labels.mjs';

const fileName = String.raw`(?:gradle\.properties|local\.properties|keystore\.properties|signing\.properties|\.env[\w.-]*|\.netrc|settings\.xml|\.npmrc|pip\.conf)`;
const filePath = new RegExp(String.raw`(?:^|[\s/\\"'=])${fileName}(?=$|[\s"':=])`, 'i');
const pathOnly = new RegExp(String.raw`^["']?(?:[^\s"']*[/\\])?${fileName}["']?:?$`, 'i');
const command = /^(?:[\t ]*[$>]\s*)?(?:cat|bat|head|tail|sed|nl|rg|grep)\b/;
const nextCommand = /^(?:[$>]\s+|(?:cat|bat|head|tail|sed|nl|rg|grep|git|ls|echo|printf|node|npm|pnpm|yarn|cd)\s)/;
const prefix = /^[\t ]*(?:[+-][\t ]*)?(?:\d+(?:\t|[:-]|\|)[\t ]*)?/;
const assignment = /^(?:export[\t ]+)?(["']?)([A-Za-z_][\w.$/-]*|\/\/[^\s=]+)\1[\t ]*([=:])[\t ]*/;
const publicKey = name => /^(?:org\.gradle\.|android\.|kotlin\.)/i.test(name)
  || /^(?:sdk\.dir|ndk\.dir|version)$/i.test(name);
const placeholder = value => /^(?:\[[^\]]*(?:masked|redact)[^\]]*\]|\{[^}]*(?:masked|redact)[^}]*\}|<[^>]*>|REDACTED|\*+)$/i.test(value);
const reference = value => /^@(?:\+)?(?:[\w.]+:)?[\w.]+\//.test(value)
  || /(?<!\\)\$(?:[A-Za-z_]\w*|\{[^}]*\})/.test(value)
  || /^(?:[A-Za-z_$][\w$]*\.)*[A-Za-z_$][\w$]*\(/.test(value);
const pathValue = value => /^(?:\.{0,2}\/|~[/\\]|[A-Za-z]:[/\\])/.test(value);

export function publicPropertyValue(value, publicValue) {
  return !value || publicValue(value) || pathValue(value) || placeholder(value) || reference(value);
}

function header(line) {
  const diff = /^(?:diff --git |--- |\+\+\+ )/.test(line);
  if (diff) return { recognized: true, sensitive: filePath.test(line), diff: true };
  const recognized = command.test(line) || /^(?:File|Path|Read(?: tool)?(?: result)?):\s*/i.test(line)
    || /^={2,}/.test(line) || pathOnly.test(line);
  return { recognized, sensitive: recognized && filePath.test(line), diff: false };
}

// Keep comments, blank lines, INI sections and XML/diff framing inside a dump.
// The first other line (including a new command/file header) closes the block.
export function propertyFileBlocks(text) {
  const blocks = [];
  let active;
  for (const match of text.matchAll(/[^\n]*(?:\n|$)/g)) {
    if (!match[0]) continue;
    const raw = match[0].replace(/\r?\n$/, ''), line = raw.replace(prefix, '').trimEnd();
    const rawHeader = header(raw.trim()), info = rawHeader.recognized ? rawHeader : header(line);
    if (info.recognized) {
      const sameDiff = active?.diff && info.diff && !/^diff --git /.test(raw.trim());
      if (active && !sameDiff) { blocks.push([active.start, match.index]); active = undefined; }
      if (info.sensitive && !active) active = { start: match.index + match[0].length, diff: info.diff, xmlDepth: 0 };
      continue;
    }
    if (!active) continue;
    const framing = active.xmlDepth > 0 || !line.trim() || /^[#!;]/.test(line) || /^\[[^\]]+\]\s*$/.test(line)
      || /^(?:@@|\\ No newline)/.test(raw) || /^\s*</.test(line)
      || /^(?:machine|default|login|password|account)(?:\s|$)/.test(line);
    if (nextCommand.test(line) || !(framing || assignment.test(line))) {
      blocks.push([active.start, match.index]); active = undefined;
    } else {
      for (const tag of line.matchAll(/<(\/?)[A-Za-z_][\w:.-]*\b[^<>]*>/g)) {
        if (tag[1]) active.xmlDepth = Math.max(0, active.xmlDepth - 1);
        else if (!/\/\s*>$/.test(tag[0])) active.xmlDepth++;
      }
    }
  }
  if (active) blocks.push([active.start, text.length]);
  return blocks;
}

function valueAt(line, start, structural) {
  const quote = line[start];
  if (quote === '"' || quote === "'") {
    for (let end = start + 1; end < line.length; end++) {
      if (line[end] === '\\') { end++; continue; }
      if (line[end] === quote) return { start: start + 1, end };
    }
    // An incomplete dump still must not expose its unterminated value.
    return { start: start + 1, end: line.trimEnd().length };
  }
  if (!structural) {
    const enclosed = line.slice(start).match(/^(?:\$\{[^}]*\}|\[[^\]]*\]|<[^>]*>|\{[^}]*\})/);
    if (enclosed) return { start, end: start + enclosed[0].length };
    const stop = line.slice(start).search(/[\s,;{}"'\[\]<>]/);
    return { start, end: stop < 0 ? line.trimEnd().length : start + stop };
  }
  const comment = line.slice(start).search(/[\t ]+[#!;]|[\t ]+["']?[A-Za-z_][\w.-]*["']?[\t ]*[=:]/);
  const end = (comment < 0 ? line : line.slice(0, start + comment)).trimEnd().length;
  return { start, end };
}

export function propertiesLogFindings(text, publicValue, blocks = propertyFileBlocks(text), labelRanges = []) {
  const hits = [];
  let block = 0, label = 0;
  const collect = (name, start, end, structural) => {
    const value = text.slice(start, end);
    if ((!credentialLabel(name) && (!structural || publicKey(name)))
      || publicPropertyValue(value, publicValue)) return;
    hits.push({ line: 0, field: name.toLowerCase(), start, end });
  };
  for (const match of text.matchAll(/[^\n]*(?:\n|$)/g)) {
    if (!match[0]) continue;
    const raw = match[0].replace(/\r?\n$/, ''), transport = raw.match(prefix)[0];
    if (/^[\t ]*-[PD][A-Za-z_]/.test(raw)) continue;
    const line = raw.slice(transport.length), index = match.index + transport.length;
    while (block < blocks.length && blocks[block][1] <= index) block++;
    const structural = blocks[block]?.[0] <= index && index < blocks[block][1];
    while (labelRanges[label]?.[1] <= index) label++;
    if (labelRanges[label]?.[0] <= index && index < labelRanges[label][1]) continue;
    let cursor = 0, field = line.match(assignment);
    if (field) {
      while (field) {
        if (/^@["']/.test(line.slice(cursor + field[0].length))) break;
        const range = valueAt(line, cursor + field[0].length, structural);
        const quoted = /^["']/.test(line[cursor + field[0].length]);
        if (!structural && field[1] && field[3] === ':' && !quoted
          && /^[A-Za-z_$][\w$]*(?:\.[\w$]+)*$/.test(line.slice(range.start, range.end))) break;
        if (quoted && /^[\t ]*[+.([]/.test(line.slice(range.end + 1))) break;
        if (!structural && !quoted && /^[A-Za-z_$][\w$]*(?:\.[\w$]+)*[\t ]*;/.test(line.slice(range.start))) break;
        collect(field[2], index + range.start, index + range.end, structural);
        const end = range.end + Number(quoted), gap = line.slice(end).match(/^[\t ]+/);
        if (!gap) break;
        cursor = end + gap[0].length;
        field = line.slice(cursor).match(assignment);
      }
    } else if (structural && /^(?:machine|default|login|password|account)(?:\s|$)/.test(line)) {
      const pairs = /\b(machine|login|password|account)[\t ]+/g;
      for (let pair; (pair = pairs.exec(line));) {
        const range = valueAt(line, pairs.lastIndex, false);
        collect(pair[1], index + range.start, index + range.end, true);
        pairs.lastIndex = range.end + Number(/^["']/.test(line[pairs.lastIndex]));
      }
    }
  }
  return hits;
}
