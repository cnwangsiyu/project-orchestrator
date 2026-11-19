import { StringDecoder } from 'node:string_decoder';

export const PRIVATE_KEY_PLACEHOLDER = '[MASKED PRIVATE KEY BLOCK]';
const marker = kind => new RegExp(`-----${kind}[ \\t]+((?:[A-Z0-9._-]+[ \\t]+)*PRIVATE[ \\t]+KEY(?:[ \\t]+BLOCK)?)-----`, 'gi');
const label = value => value.replace(/[ \t]+/g, ' ').toUpperCase();

// Marker matching deliberately ignores indentation, quotes and escaped newlines.
// The bytes between markers never leave this matcher. Missing END means EOF.
export function maskPrivateKeyBlocks(text) {
  const begin = marker('BEGIN'), end = marker('END'), parts = [];
  let offset = 0, masked = 0;
  for (let match; (match = begin.exec(text));) {
    end.lastIndex = begin.lastIndex;
    let close;
    while ((close = end.exec(text)) && label(close[1]) !== label(match[1])) {}
    const stop = close ? end.lastIndex : text.length;
    parts.push(text.slice(offset, match.index), PRIVATE_KEY_PLACEHOLDER);
    offset = stop; begin.lastIndex = stop; masked++;
    if (!close) break;
  }
  parts.push(text.slice(offset));
  return { text: parts.join(''), masked };
}

// Buffer physical lines so BEGIN/END markers split at any byte boundary cannot
// escape. Once BEGIN is seen, suppress all body lines until END or stream end.
export function privateKeyBlockStream(write, { initialActive = false, initialLabel = null } = {}) {
  const decoder = new StringDecoder('utf8');
  let pending = '', active = initialActive, activeLabel = initialLabel, masked = 0;
  const consume = line => {
    let offset = 0;
    while (offset < line.length) {
      if (active) {
        const end = marker('END'); end.lastIndex = offset;
        let close;
        while ((close = end.exec(line)) && activeLabel && label(close[1]) !== activeLabel) {}
        if (!close) return;
        active = false; offset = end.lastIndex;
      } else {
        const begin = marker('BEGIN'); begin.lastIndex = offset;
        const open = begin.exec(line);
        if (!open) { write(line.slice(offset)); return; }
        write(line.slice(offset, open.index) + PRIVATE_KEY_PLACEHOLDER);
        masked++; active = true; activeLabel = label(open[1]); offset = begin.lastIndex;
      }
    }
  };
  return {
    push(chunk) {
      pending += typeof chunk === 'string' ? chunk : decoder.write(chunk);
      let newline;
      while ((newline = pending.indexOf('\n')) >= 0) {
        consume(pending.slice(0, newline + 1)); pending = pending.slice(newline + 1);
      }
    },
    end() { pending += decoder.end(); if (pending) consume(pending); pending = ''; },
    get masked() { return masked; },
    get active() { return active; },
  };
}
