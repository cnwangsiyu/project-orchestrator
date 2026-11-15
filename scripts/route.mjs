#!/usr/bin/env node
// The CLI owns acquisition and logging; the pure pipeline is the sole selector.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseTaskSpec, routePure, renderPlan } from './lib/pipeline/index.mjs';
import { acquireRoute, taskContext } from './lib/route-data.mjs';
import { loadDigest } from './lib/global-rules.mjs';
import { launcherIdentity, validOwner } from './lib/worker-events.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
try {
  const task = parseTaskSpec(process.argv.slice(2), taskContext());
  if (task.kind === 'table') {
    const table = task.categories.map(category => ({ category, engine: 'candidate-pipeline', note: 'Effective tuple depends on capabilities, actual floor, scoped approval and ETA.' }));
    console.log(process.argv.includes('--json') ? JSON.stringify(table) : table.map(r => `${r.category}  ${r.note}`).join('\n'));
  } else {
    if (task.flags.owner !== undefined && !validOwner(task.flags.owner)) throw Error('--owner needs a public session ID');
    const owner = launcherIdentity(task.flags.owner).sessionId;
    const context = acquireRoute({...task,owner:owner??'UNKNOWN'}, {root});
    const plan = routePure(context.task, context.snapshot);
    const out = renderPlan(plan, {...context, owner, digest: loadDigest()});
    if (!task.flags.dry && process.env.ROUTE_LOG !== '0') {
      const tuple = p => p ? {vendor:p.vendor,model:p.model,effort:p.effort,account:p.account,sandbox:p.sandbox} : null;
      const rec = {t:context.now,kind:'route',project:plan.task.project,name:plan.task.flags.name??plan.task.taskId,requestId:plan.task.requestId,
        routeId:plan.routeId,planHash:plan.planHash,category:out.category,stakes:out.stakes,failures:out.failures,impact:plan.task.impact,
        review:plan.followups[0]?.category??null,security:out.security,adversarial:out.adversarial,defensive:out.defensive,signing:out.signing,
        background:out.background,tier:out.tier,deferred:out.deferred,kindResult:out.kind,executable:out.executable,env:plan.task.env,
        autoCheck:!!task.flags['auto-check'],runsTests:plan.task.runsTests,noLocalBuild:plan.task.execution==='remote',
        noRedeem:!!task.flags['no-redeem'],excluded:plan.task.exclusions.filter(e=>e.scope==='account').map(e=>e.value),
        excludedLanes:plan.task.exclusions.filter(e=>e.accountId).map(e=>`${e.accountId}:${e.value}`),ttadk:!!out.pick?.company,
        pick:tuple(out.pick),second:tuple(out.secondOpinion),secondExecutable:!!out.secondOpinion?.command,why:out.why,needsOK:out.needsUserOK,tell:out.tellUser,
        personalApproved:out.executable&&!!out.pick&&!out.pick.company,approvalRef:task.flags['user-ok']??null,
        reviewOverride:task.flags['review-override']??null,reviewRequired:task.flags['review-required']??null,profileOverride:task.flags['profile-override']??null,
        company:out.pick?.company?out.pick.account:null,owner:owner??null,quota:out.quotaSummary,balance:out.balance};
      try { fs.mkdirSync(path.dirname(context.routeLog),{recursive:true}); fs.appendFileSync(context.routeLog,JSON.stringify(rec)+'\n'); }
      catch(e) { console.error(`route log write failed: ${e.code??e.message}`); }
    }
    if (task.flags.json) console.log(JSON.stringify(out));
    else {
      console.log(`${out.kind.toUpperCase()} ${out.category}${out.pick?` → ${out.pick.model} ${out.pick.effort} on ${out.pick.account??'claude'}`:''}`);
      if(out.pick?.command) console.log(`  launch: ${out.pick.command}`);
      if(out.secondOpinion) console.log(`  + second opinion: ${out.secondOpinion.model} ${out.secondOpinion.effort} on ${out.secondOpinion.account??'claude'}${out.secondOpinion.command?` — ${out.secondOpinion.command}`:' (blocked)'}`);
      if(out.redeemFirst) console.log(`  first: ${JSON.stringify(out.redeemFirst)}`);
      for(const key of ['why','needsUserOK','tellUser','notes']) for(const line of out[key]) console.log(`  ${key}: ${line}`);
    }
  }
} catch(error) {
  console.error(`route: ${error.code??'INVALID_INPUT'}: ${error.message}`);
  process.exitCode=error.exitCode??2;
}
