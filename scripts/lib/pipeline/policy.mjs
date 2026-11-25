// Category qualification and preferences, shared by admission and ordering.
import { EFFORTS, company, adversarial, known, policyModel, isAstra, isReview } from './common.mjs';
import { mandatoryReview } from '../review-policy-data.mjs';
export const SOL='sol', ASTRA='astra';
// Company hard-tier trial: 2026-11-16 through the 2026-11-23 review.
export const TIERS = {hard:[ASTRA,SOL],normal:[SOL,'gpt-5.6-sol','gpt-5.6-terra','deepseek-v4.1-flash'],light:['gpt-5.6-terra','gpt-5.5','deepseek-v4.1-flash']};
// The normal ladder also contains company fallback rungs shared with light work.
export const companyDowngrade = model => TIERS.light.includes(policyModel(model))
  || /(?:^doubao-|-(?:terra|luna)$)/.test(model);
export const normalTierOverflow = task => ['normal', 'hard'].includes(task.tier)
  && task.contentLabels.includes('ordinary') && !task.reviewClass && !task.flags.signing
  && !task.flags['allow-low-priority-queue'] && !task.queueOwnerChoice && !task.requirements.resetRedemption;
export const tierApprovalRef = 'standing:normal-tier-main-2026-11-24';
export const tierDecision = '2026-11-24 “可以按照路由规则走个人的几个模型，不需要授权”';
export const mandatoryClaudeApprovalRef = 'standing:codex-mandatory-review-2026-11-24';
export const mandatoryClaudeDecision = '2026-11-24 “A 可以，四类必审直接用 Claude 评审（不用每次问）”';
export const mandatoryClaudeReview = t => isReview(t) && mandatoryReview(t) && !!t.reviewReason?.trim()
  && [t.flags.author, t.flags.against].includes('codex') && ![t.flags.author, t.flags.against].includes('claude');
// The declared Claude catalog uses `opus` for Opus 5.5. No other model or effort is approved.
export const mandatoryClaudeSeat = (t, c, a) => mandatoryClaudeReview(t) && a.kind === 'claude'
  && c.family === 'claude' && c.modelId === 'opus' && c.effort === 'medium';
export function hardPreference(t) {
  // Retain Sol's effort escalation (including company max) after a Sol attempt.
  // Astra actuals still forbid Sol through pPreviousFloor; preference is not a floor.
  const attempts=t.previousAttempts.filter(a=>a?.taskId===t.taskId&&(a.role??'primary')===t.role&&a.state!=='planned'&&a.actualStatus==='KNOWN');
  const used=id=>attempts.some(a=>policyModel(a.actual?.modelId??a.actual?.model)===id);
  return used(SOL)&&!used(ASTRA)
    ? [SOL,ASTRA] : TIERS.hard;
}
export const PERSONAL = {
  lookup:[['gpt-6-luna','low'],['haiku','low'],[SOL,'medium']],
  extract:[['gpt-6-luna','medium'],['haiku','medium'],[SOL,'medium']],
  analysis:[[SOL,'medium'],['sonnet','medium'],['opus','high']],
  research:[['sonnet','medium'],[SOL,'medium'],['opus','high']],
  implement:[[SOL,'high'],['sonnet','medium'],['opus','high']],
  'implement-hard':[[SOL,'xhigh'],['opus','high'],[ASTRA,'xhigh']],
  debug:[[SOL,'xhigh'],['opus','high'],['fable','high'],[ASTRA,'xhigh']],
  science:[[SOL,'xhigh'],['opus','xhigh'],[ASTRA,'high']],
  review:[[SOL,'high'],['sonnet','high'],['opus','xhigh']],
  'review-high':[['opus','xhigh'],[SOL,'xhigh'],[ASTRA,'high']],
  design:[['opus','high'],[SOL,'xhigh']],
  docs:[['sonnet','medium'],[SOL,'medium'],['opus','medium']],
  draft:[['gpt-6.1-terra','medium'],['sonnet','low'],[SOL,'medium']],
  'build-run':[[SOL,'medium'],['sonnet','medium'],['opus','high']],
  browser:[[SOL,'medium'],['sonnet','medium']],
  'ui-browser':[[SOL,'high'],['sonnet','high'],['opus','high']],
  'computer-use':[[SOL,'medium']],
  'claude-tools':[['sonnet','medium'],['opus','high']],
  // gpt-6-luna (personal ChatGPT) stays: the image tool does the work, so the cheapest model is right. Only TRAE's
  // gpt-5.6-luna is retired (slow, ~3x tokens).
  'image-gen':[['gpt-6-luna','low'],[SOL,'medium']],
  'image-read':[['sonnet','medium'],['gpt-6.1-terra','medium'],['opus','high'],[SOL,'high']],
  'second-opinion':[[SOL,'high'],['opus','high']],
};
export const claudeBrowserPolicy = t => t.category === 'browser'
  ? (t.browserKind === 'poll' ? ['haiku', 'low'] : ['sonnet', 'medium']) : null;
export function modelPreference(t,a,s = null) {
  const browser = claudeBrowserPolicy(t);
  if (a.kind === 'claude' && browser) return [browser[0]];
  if(adversarial(t)) return ['kimi-k3','deepseek-v4.1-flash','opus'];
  if(company(a)) {
    if(t.category==='image-read') return [SOL,ASTRA,...(a.kind==='ttadk'?['gemini-3.1-pro-preview']:[]),'seed-evolving'];
    // An account-less company baseline cannot attest a prior Astra run. Keep the
    // existing Sol assumption for count-only retries; declared Astra catalogs use
    // the trial preference and choose.mjs still checks whether the lane is free.
    if(t.tier==='hard') return known(a.catalog)?.some(isAstra)?hardPreference(t):[SOL,ASTRA];
    return [...TIERS[t.tier],...(t.tier==='light'?[SOL,'gpt-5.6-sol']:[]),...(a.kind==='ttadk'?['gemini-3.1-pro-preview']:[])];
  }
  const preference=(PERSONAL[t.category]??[]).map(([m])=>m);
  if (a.kind === 'chatgpt' && t.tier === 'hard' && s?.personalFallback?.enabled && s.personalFallback.allowHardPersonalAstra
    && !preference.includes(ASTRA)) preference.push(ASTRA);
  if(a.kind==='claude'&&known(a.budget)?.status==='over'&&!['claude-tools','second-opinion','review'].includes(t.category)) return preference.filter(m=>!['haiku','sonnet'].includes(m));
  return preference;
}
export function policyEffort(t,c,a,s) {
  if (mandatoryClaudeReview(t) && a.kind === 'claude' && c.modelId === 'opus') return 'medium';
  const browser = claudeBrowserPolicy(t);
  if (c.family === 'claude' && browser) return browser[1];
  if(['deepseek','kimi','gemini'].includes(c.family)) return 'high';
  if(c.family==='seed') return 'medium';
  if(adversarial(t)) return ['review','review-high'].includes(t.category)?'xhigh':'high';
  let e=(PERSONAL[t.category]??[]).find(([m])=>m===policyModel(c.modelId))?.[1]??(t.tier==='hard'?'xhigh':'medium');
  if(company(a)) {
    e=t.tier==='light'&&t.category!=='image-read'?'medium':(PERSONAL[t.category]??[]).find(([m])=>m===SOL)?.[1]??'medium';
    if(['docs','research','image-read','analysis'].includes(t.category)&&t.tier!=='light') e='high';
    if(t.flags.author==='codex') e='xhigh';
    if(t.impact==='throwaway'&&EFFORTS.indexOf(e)>2&&!t.qualityFailures) e='high';
  }
  if(t.stakes==='high') e=EFFORTS[Math.min(3,EFFORTS.indexOf(e)+1)];
  if(!company(a)) {
    const floor=c.family==='gpt'&&c.modelId!=='gpt-6-luna'?1:0;
    const notch=(d)=>{ e=EFFORTS[Math.max(floor,Math.min(3,EFFORTS.indexOf(e)+d))]; };
    if(!t.qualityFailures&&t.stakes!=='high'&&(t.flags['auto-check']||t.stakes==='low')) notch(-1);
    const budget=known(a.budget), companyDevice=s.accounts.some(company), cheap=['lookup','extract','image-gen','draft'].includes(t.category);
    if(!companyDevice&&budget?.underused&&!cheap&&c.family==='gpt') notch(1);
    else if(budget?.overspending&&t.flags['auto-check']&&t.stakes!=='high') notch(-1);
    if(!companyDevice&&c.family==='claude'&&budget?.expiring&&!cheap) notch(1);
  }
  if(t.qualityFailures&&t.tier==='hard'&&c.family==='gpt'&&EFFORTS.indexOf(e)<3) e='xhigh';
  return e;
}
