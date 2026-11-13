#!/usr/bin/env node
// Observational only: never turn a missing route/telemetry write into a blocked launch.
import { auditLaunch } from './lib/global-rules.mjs';
try {
  const argv = process.argv.slice(2), opts = {};
  for (let i = 0; i < argv.length; i += 2) opts[argv[i].replace(/^--/, '')] = argv[i + 1];
  auditLaunch({ name: opts.name, account: opts.account, model: opts.model, vendor: opts.vendor,
    userOK: opts['user-ok'] });
} catch {}
