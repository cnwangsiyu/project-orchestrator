#!/usr/bin/env node
// Mismatches are observational except an unapproved company-to-personal replacement.
import { auditLaunch } from './lib/global-rules.mjs';
try {
  const argv = process.argv.slice(2), opts = {};
  for (let i = 0; i < argv.length; i += 2) opts[argv[i].replace(/^--/, '')] = argv[i + 1];
  let seat;try {seat=opts['routed-seat']?JSON.parse(opts['routed-seat']):undefined;} catch {console.error('launch-audit: routed seat metadata invalid');}
  auditLaunch({ name: opts.name, project:opts.project, account: opts.account, model: opts.model, effort:opts.effort,vendor: opts.vendor,
    sandbox: opts.sandbox, userOK: opts['user-ok'],role:opts.role,seat });
} catch(e) { if(e.code==='PERSONAL_ROUTE_APPROVAL_REQUIRED') {console.error(e.message);process.exitCode=1;} else console.error(`launch-audit: ${e.message}`); }
