#!/usr/bin/env node
import assert from 'node:assert/strict';
import {mcpStartupMonitor} from '../lib/mcp-startup.mjs';
const notify = (monitor, threadId, status, failureReason) => monitor.observe({
  method:'mcpServer/startupStatus/updated',params:{threadId,name:'playwright',status,failureReason},
});
{
  const monitor=mcpStartupMonitor();
  notify(monitor,'early','ready');
  await monitor.wait('early',{timeoutMs:50});
  notify(monitor,'early','starting');
  await assert.rejects(monitor.wait('early',{timeoutMs:20}),/last status: starting/);
}
{
  const monitor=mcpStartupMonitor();
  const waiting=monitor.wait('own',{timeoutMs:200,readStatus:async()=>{throw Error('status unavailable');}});
  notify(monitor,'other','ready');
  notify(monitor,'own','starting');
  setTimeout(()=>notify(monitor,'own','ready'),20);
  await waiting;
}
{
  const monitor=mcpStartupMonitor();
  notify(monitor,'failed','failed','package unavailable');
  await assert.rejects(monitor.wait('failed',{timeoutMs:50}),/package unavailable.*no browser turn was sent/);
  await assert.rejects(monitor.wait('missing',{timeoutMs:20}),/last status: unknown/);
}
{
  const monitor=mcpStartupMonitor();
  const readStatus=async()=>({data:[{name:'playwright',runtimeStatus:'ready',tools:{browser_navigate:{},browser_snapshot:{}}}]});
  await monitor.wait('resumed',{timeoutMs:50,readStatus});
  await assert.rejects(monitor.wait('empty',{timeoutMs:50,readStatus:async()=>({data:[{name:'playwright',runtimeStatus:'ready',tools:{}}]})}),/browser tools are missing/);
}
console.log('PASS MCP startup: early/delayed readiness, generation reset, thread isolation, failed/unknown deadlines, resumed tools and empty tool rejection');
