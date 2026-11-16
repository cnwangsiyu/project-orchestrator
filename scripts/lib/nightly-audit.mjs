// Callers receive locations only. Suspected values never leave this scanner.
export function passwordStyleFindings(text) {
  const findings = [];
  for (const [index, line] of text.split('\n').entries()) {
    for (const match of line.matchAll(/\b(password|passphrase|passwd|pwd|pass)\b\s*([:=]|\s)\s*("[^"]*"|'[^']*'|[^\s,;]+)/gi)) {
      if (/^PASS$/i.test(match[1]) && match[2] === ':') continue;
      const value = match[3].replace(/^["']|["']$/g, '');
      if (!value || /^\$(?:[A-Za-z_]\w*|\{[^}]+\})$/.test(value) || /^(?:<[^>]*redact[^>]*>|\[[^\]]*redact[^\]]*\]|\{[^}]*redact[^}]*\}|REDACTED|\*+|<[^>]+>)$/i.test(value)) continue;
      findings.push({ line: index + 1, field: match[1].toLowerCase(), value: '[MASKED]' });
    }
  }
  return findings;
}
