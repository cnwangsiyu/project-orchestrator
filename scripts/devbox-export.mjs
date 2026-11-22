#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exportSource } from './lib/devbox-export.mjs';

export function parseArgs(args) {
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    if (!['--repo', '--ref', '--profile', '--out', '--dependencies'].includes(args[i]) || !args[i + 1] || args[i + 1].startsWith('--')) throw Error('invalid exporter arguments');
    const field = args[i].slice(2);
    if (Object.hasOwn(opts, field)) throw Error('duplicate exporter argument');
    opts[field] = args[++i];
  }
  if (['repo', 'ref', 'profile', 'out'].some(name => !opts[name])) throw Error('usage: devbox-export.mjs --repo DIR --ref LOCAL_REF --profile NAME --out FRESH_DIR [--dependencies MANIFEST]');
  if (opts.dependencies) {
    const manifest = JSON.parse(fs.readFileSync(opts.dependencies, 'utf8'));
    if (!Array.isArray(manifest) || manifest.some(d => !(d.dir && !d.repo && !d.ref || d.repo && d.ref && !d.dir) || !d.prefix || Object.keys(d).some(k => !['repo', 'ref', 'dir', 'prefix', 'expectedBachHeaders'].includes(k)))) throw Error('invalid dependency manifest');
    opts.dependencies = manifest;
  }
  return opts;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await exportSource(parseArgs(process.argv.slice(2)));
    console.log(JSON.stringify({ status: result.status, findingCount: result.findings.length, rewriteCount: result.receipts.reduce((sum, r) => sum + (r.rewritten || 0), 0), hydratedLfsCount: result.hydratedLfs.length }));
    process.exitCode = result.status === 'passed' ? 0 : 1;
  } catch {
    console.error('Source export refused; check arguments, profile, and fresh output directory. Contents suppressed.'); process.exitCode = 1;
  }
}
