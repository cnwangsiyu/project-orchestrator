#!/usr/bin/env node
import { appendWorkerAlert } from './lib/worker-events.mjs';
const [owner, id, tag, reason, at] = process.argv.slice(2);
if (!/^[a-zA-Z0-9_.:-]{1,200}$/.test(owner || '') || !/^[0-9a-f-]{36}:(down|up)$/.test(id || '')
    || !['mini2-down', 'mini2-up'].includes(tag) || !/^[a-z0-9-]{1,80}$/.test(reason || '') || !Number.isFinite(+at)) throw Error('invalid mini2 alert');
const detail = tag === 'mini2-down'
  ? 'Measured power-loss recovery was about 30 seconds without a local login. SSH should return by itself after a reboot or power loss. Two failed probes at least 5 minutes apart indicate an outage lasting at least 5 minutes; someone should check the machine.'
  : 'Two consecutive probes succeeded. The cable connection has recovered; normal admission checks apply.';
const text = `[${tag}] Bytedances-Mac-mini.local en12 ${reason}; at=${new Date(+at*1000).toISOString()}. ${detail}`;
const event = appendWorkerAlert({ runId: id.split(':')[0], owner, event: 'message', account: 'monitor',
  name: 'mini2-link', kind: 'risk', wake: true, text }, 'mini2-link:' + id);
console.log(JSON.stringify({ delivered: true, id: event.id }));
