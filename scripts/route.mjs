#!/usr/bin/env node
// The CLI owns acquisition and logging; the pure pipeline is the sole selector.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseTaskSpec, routePure, renderPlan, createSnapshot } from './lib/pipeline/index.mjs';
import { WORKER_NOTES } from './lib/fixed-worker-notes.mjs';
import { companyDevice } from './lib/pipeline/common.mjs';
import { withLock } from './lib/shared-file.mjs';
import { acquireRoute, taskContext } from './lib/route-data.mjs';
import { loadDigest } from './lib/global-rules.mjs';
import { launcherIdentity, validOwner } from './lib/worker-events.mjs';
import { taskLaunchPaths } from './lib/launch-paths.mjs';
import { approvalMismatchHints, mismatchHintText } from './lib/approval-diagnostics.mjs';
import { checkPersonalPriorityNotices } from './lib/personal-priority-notices.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
if (process.argv.includes('--help') || process.argv.includes('-h') || process.argv[2] === 'help') {
  console.log('usage: route.mjs <category> [options]\nbrowser | ui-browser: --browser-origins <comma list of hosts or HTTP(S) origins> (required; --origins is an alias)\ncomputer-use: --computer-use-apps <comma list of bundle IDs> (--apps is an alias)\nBrowser origins and desktop apps are carried into the worker launch and --route-args. Never infer sites from a brief.\nClaude-in-Chrome: run node scripts/browser-identity.mjs serve --once on the target machine and give the URL/expected token in the brief; prove the machine in a new tab before task actions.\nUse --table for categories and references/worker-operations.md for task flags.');
  process.exit(0);
}
if (process.argv[2] === 'void') {
  // Void a route decision that was never launched, so it does not count (e.g. as a review round).
  const routeId = process.argv[3], i = process.argv.indexOf('--reason'), why = i > 0 ? process.argv[i + 1] : '';
  if (!/^route:[0-9a-f]{8,}$/.test(routeId ?? '') || !why) { console.error('usage: route.mjs void <route:id> --reason "<why it was never launched>"'); process.exit(2); }
  const shared = process.env.RULES_SHARED || path.join(process.env.HOME, '.claude/orchestrator/_shared');
  const log = process.env.ROUTE_LOG_FILE || path.join(shared, 'route-log.jsonl');
  const known = fs.readFileSync(log, 'utf8').split('\n').some((l) => l.includes(`"routeId":"${routeId}"`));
  if (!known) { console.error(`route: unknown ${routeId}`); process.exit(1); }
  fs.appendFileSync(log, JSON.stringify({ kind: 'void', routeId, reason: why, t: Date.now() }) + '\n');
  console.log(`voided ${routeId}`); process.exit(0);
}
try {
  const task = parseTaskSpec(process.argv.slice(2), taskContext());
  if (task.kind === 'table') {
    const table = task.categories.map(category => ({ category, engine: 'candidate-pipeline', note: ['implement','implement-hard','debug','science'].includes(category)?WORKER_NOTES.routeImpact:WORKER_NOTES.routeTuple }));
    console.log(process.argv.includes('--json') ? JSON.stringify(table) : table.map(r => `${r.category}  ${r.note}`).join('\n'));
  } else {
    if (['browser', 'ui-browser'].includes(task.category) && !task.flags['browser-origins'] && !task.flags.origins)
      throw Object.assign(Error(`usage: route.mjs ${task.category} --browser-origins <comma list> [options]; name the allowed sites explicitly`), { code: 'BROWSER_ORIGINS_REQUIRED', exitCode: 2 });
    if (task.flags.owner !== undefined && !validOwner(task.flags.owner)) throw Error('--owner needs a public session ID');
    const owner = launcherIdentity(task.flags.owner).sessionId;
    const context = acquireRoute({...task,owner:owner??'UNKNOWN'}, {root});
    // Acquire providers before taking the short account-selection lock. The
    // pure snapshot carries the counter; only a nondry personal launch advances it.
    const select = () => routePure(context.task, context.snapshot);
    const rr = process.env.ROUTE_RR || path.join(process.env.RULES_SHARED || path.dirname(context.routeLog),'route-rotation.txt');
    const plan = companyDevice(context.snapshot) || task.flags.dry ? select() : withLock(rr, () => {
      let counter=context.snapshot.rotationState;
      try { const n=Number(fs.readFileSync(rr,'utf8')); if(Number.isSafeInteger(n)&&n>=0) counter=n; } catch {}
      context.snapshot=createSnapshot({...context.snapshot,rotationState:counter},{now:context.now});
      const selected=select();
      if(!task.flags.dry && selected.kind==='launch' && context.snapshot.accounts.some(a=>a.id===selected.primary.candidate.accountId&&a.kind==='chatgpt'))
        fs.writeFileSync(rr,String((counter+1)%Number.MAX_SAFE_INTEGER));
      return selected;
    });
    const launchPaths = Object.fromEntries([plan.primary ?? plan.primaryProposal, ...plan.reviewers, ...(plan.reviewerProposals ?? [])]
      .filter(s => s?.task.flags['task-dir']).map(s => [s.role, taskLaunchPaths(s.task.taskDir, s.role)]));
    const view = renderPlan(plan, {...context, launchPaths, owner, digest: loadDigest()});
    const approvalHints = approvalMismatchHints(plan, context.snapshot, root, process.env.ORCHESTRATOR_OWNER);
    const notices = checkPersonalPriorityNotices({ snapshot: context.snapshot, task: context.task, plan, owner, dry: !!task.flags.dry });
    const notifiedView = notices.length ? { ...view, tellUser: [...new Set([...view.tellUser, ...notices.map(r => r.text)])] } : view;
    const out = approvalHints.length ? { ...notifiedView, approvalMismatchHints: approvalHints,
      needsUserOK: [...view.needsUserOK, ...approvalHints.map(mismatchHintText)] } : notifiedView;
    if (!task.flags.dry && process.env.ROUTE_LOG !== '0') {
      const tuple = p => p ? {vendor:p.vendor,model:p.model,effort:p.effort,account:p.account,sandbox:p.sandbox,company:p.company} : null;
      const rec = {t:context.now,kind:'route',project:plan.task.project,name:plan.task.flags.name??plan.task.taskId,requestId:plan.task.requestId,
        routeId:plan.routeId,planHash:plan.planHash,category:out.category,stakes:out.stakes,failures:out.failures,failureKind:out.failureKind,impact:plan.task.impact,
        review:plan.followups[0]?.category??null,security:out.security,adversarial:out.adversarial,defensive:out.defensive,signing:out.signing,
        background:out.background,tier:out.tier,deferred:out.deferred,kindResult:out.kind,executable:out.executable,env:plan.task.env,
        autoCheck:!!task.flags['auto-check'],runsTests:plan.task.runsTests,noLocalBuild:plan.task.execution==='remote',
        noRedeem:!!task.flags['no-redeem'],excluded:plan.task.exclusions.filter(e=>e.scope==='account').map(e=>e.value),
        excludedLanes:plan.task.exclusions.filter(e=>e.accountId).map(e=>`${e.accountId}:${e.value}`),ttadk:!!out.pick?.company,
        pick:tuple(out.pick),second:tuple(out.secondOpinion),secondExecutable:!!out.secondOpinion?.command,why:out.why,needsOK:out.needsUserOK,tell:out.tellUser,
        personalApproved:out.executable&&!!out.pick&&!out.pick.company,approvalRef:out.pick?.approvalRef??task.flags['user-ok']??null,
        astraApprovalRef:out.pick?.astraApprovalRef??null,
        reviewClass:plan.task.reviewClass,reviewReason:plan.task.reviewReason,reviewScope:plan.task.reviewScope,reviewOverride:task.flags['review-override']??null,reviewRequired:task.flags['review-required']??null,profileOverride:task.flags['profile-override']??null,
        company:out.pick?.company?out.pick.account:null,owner:owner??null,quota:out.quotaSummary,balance:out.balance};
      try { fs.mkdirSync(path.dirname(context.routeLog),{recursive:true}); fs.appendFileSync(context.routeLog,JSON.stringify(rec)+'\n'); }
      catch(e) { console.error(`route log write failed: ${e.code??e.message}`); }
    }
    if (task.flags.json) console.log(JSON.stringify(out));
    else {
      console.log(`${out.kind.toUpperCase()} ${out.category}${out.pick?` → ${out.pick.model} ${out.pick.effort} on ${out.pick.account??'claude'}`:''}`);
      // A --dry preview records no route decision: launching from it is an unrouted launch (Lynx T90, 2026-11-15).
      if(out.pick?.command) console.log(task.flags.dry ? `  launch (PREVIEW ONLY, not a route: run again without --dry and launch from that output): ${out.pick.command}` : `  launch: ${out.pick.command}`);
      if(out.secondOpinion) console.log(`  + second opinion: ${out.secondOpinion.model} ${out.secondOpinion.effort} on ${out.secondOpinion.account??'claude'}${out.secondOpinion.command?` — ${out.secondOpinion.command}`:' (blocked)'}`);
      if(out.redeemFirst) console.log(`  first: ${JSON.stringify(out.redeemFirst)}`);
      console.log(`  worker rules ${out.workerRulesVersion} are injected by the launcher; do not copy them into the brief`);
      for (const key of ['why','needsUserOK','tellUser','notes',...(task.flags.verbose?['fixedNotes']:[])]) {
        const lines = !task.flags.verbose && key==='why' ? out.shortWhy
          : !task.flags.verbose && key==='notes' ? [...new Set(out.shortNotes)] : out[key];
        for (const line of lines) console.log(`  ${key}: ${line}`);
      }
    }
  }
} catch(error) {
  console.error(`route: ${error.code??'INVALID_INPUT'}: ${error.message}`);
  process.exitCode=error.exitCode??2;
}
