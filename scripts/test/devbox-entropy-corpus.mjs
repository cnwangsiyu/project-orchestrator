// Optional local-object qualification of the 25 named T199 anchors; no values leave the process.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { literals, sanitizeText, entropyIdentifierExempt, highEntropy } from '../lib/devbox-sanitize.mjs';
import { loadProfile } from '../lib/devbox-export.mjs';
try {
  const args = process.argv.slice(2), get = name => args[args.indexOf(name) + 1];
  if (args.length !== 6 || !['--repo', '--ref', '--out'].every(name => args.includes(name))) throw Error('invalid corpus arguments');
  const repo = get('--repo'), ref = get('--ref'), out = get('--out');
  if (fs.existsSync(out)) throw Error('receipt already exists');
  const entries = JSON.parse(fs.readFileSync(new URL('./fixtures/devbox-entropy-identifiers.json', import.meta.url)));
  const file = 'proj/android/vebase/src/common/java/com/ss/android/vesdk/VEConfigKeys.java';
  const text = execFileSync('git', ['-C', repo, 'show', ref + ':' + file], { stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 32 * 1024 * 1024 }).toString('utf8');
  const rows = literals(text); let exempt = 0, raw = 0, preserved = 0;
  for (const entry of entries) {
    const symbol = entry.field.split('/').at(-1).split('#')[0];
    const selected = entry.field.startsWith('annotation:')
      ? rows.filter(row => row.field === 'key' && /^@BTCStrategy\(\s*key\s*=\s*$/.test(row.before)
        && new RegExp('\\b' + entry.field.split('/')[0].slice('annotation:'.length) + '\\s*=').test(text.slice(row.end, row.end + 512).split(';', 1)[0]))
      : rows.filter(row => row.field === symbol && row.ordinal === entry.ordinal);
    if (selected.length !== 1) throw Error('corpus structural anchor mismatch');
    const row = selected[0]; if (entropyIdentifierExempt(row.value)) exempt++; if (highEntropy(row.value)) raw++;
    const snippet = 'String ordinary = ' + JSON.stringify(row.value) + ';';
    const verdict = sanitizeText(snippet, 'fixture.java', loadProfile('vesdk-mainline'));
    if (verdict.findings.length || verdict.text !== snippet) throw Error('identifier byte preservation failed');
    preserved++;
  }
  const receipt = { pass: preserved === 25 && exempt === 18 && raw === 7, names: preserved, exempt, remainingRawEntropy: raw, rewrites: 0, keepEntries: 0 };
  fs.writeFileSync(out, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  console.log(JSON.stringify(receipt)); process.exitCode = receipt.pass ? 0 : 1;
} catch { console.error('Identifier corpus qualification failed; contents suppressed.'); process.exitCode = 1; }
