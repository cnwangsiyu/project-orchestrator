// Public account observations only. Independent last-good readings survive a
// partial quota-cache write or a failed probe without renewing their timestamps.
import fs from 'node:fs';
import { withLock, writeJson } from './shared-file.mjs';
import { object, nonnegative } from './pipeline/common.mjs';
const read=file=>{try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch{return null;}};
const windows=v=>Array.isArray(v)&&v.every(w=>object(w)&&nonnegative(w.used));
const good=a=>object(a)&&typeof a.name==='string'&&Array.isArray(a.models)&&a.models.every(m=>typeof m==='string')
  &&!a.stateUnknown&&!a.statusReadFailed&&typeof a.live==='boolean'&&(typeof a.healthy==='boolean'||a.kind==='chatgpt'&&windows(a.windows))
  &&nonnegative(a.seenAt)&&(a.models.length>0||a.healthy===false);
const keys=['name','kind','models','modelIds','healthy','live','auth','transport','seenAt','windows','resets','usage','usageSeenAt','quota','quotaOut',
  'quotaKeys','load','browser','desktop','publicBrowser','search','searchLive','traeBrowser','active'];
export function mergeRoutingObservations(current, previous, now) {
  const data=object(current)?{...current}:{};
  const prior=object(previous)?previous:{};
  const accounts=new Map((Array.isArray(prior.codexAccounts)?prior.codexAccounts:[]).filter(good)
    .map(a=>[a.name,{...a,statusSource:'last-good-stale',observationStale:true}]));
  for(const raw of Array.isArray(data.codexAccounts)?data.codexAccounts:[]) {
    if(!object(raw)||typeof raw.name!=='string') continue;
    const a={...raw,seenAt:raw.seenAt??data.checkedAt};
    if(good(a)&&(!accounts.has(a.name)||a.seenAt>=accounts.get(a.name).seenAt)) accounts.set(a.name,a);
    else if(!accounts.has(a.name)) accounts.set(a.name,a);
  }
  data.codexAccounts=[...accounts.values()];
  if(!windows(data.claude)&&windows(prior.claude)) {
    data.claude=prior.claude;data.claudeSeenAt=prior.claudeSeenAt??prior.checkedAt;
    data.claudeObservationStale=true;
  }
  data.checkedAt=nonnegative(data.checkedAt)?data.checkedAt:prior.checkedAt;
  return data;
}
export function readQuotaCache(file) {
  let current=read(file);
  if(!object(current)||!Array.isArray(current.codexAccounts)) current=read(file); // legacy non-atomic writer
  return current;
}
export function readRoutingObservations(file, now) {
  return mergeRoutingObservations(readQuotaCache(file),read(`${file}.routing-last-good.json`),now);
}
// Keep the launch cache current when routing reads main independently of quota.mjs.
export function publishPersonalQuota(file, main) {
  withLock(file, () => {
    const cache = readQuotaCache(file);
    const accounts = Array.isArray(cache?.codexAccounts) ? cache.codexAccounts : [];
    const previous = accounts.find(account => account?.name === main.name);
    if ((previous?.seenAt ?? cache?.checkedAt) > main.seenAt) return;
    const codexAccounts = accounts.filter(account => account?.name !== main.name);
    writeJson(file, { ...cache, codexAccounts: [...codexAccounts, main] });
  }, { timeoutMs: 0 });
}
export function saveRoutingObservations(file,data) {
  const target=`${file}.routing-last-good.json`,lock=`${target}.lock`;
  // Routing never waits on a cache writer. A failed save cannot discard a read.
  let held=false;
  try {
    fs.mkdirSync(lock);held=true;
    const next=mergeRoutingObservations(data,read(target));
    const clean={checkedAt:next.checkedAt,codexAccounts:next.codexAccounts.filter(good).map(a=>Object.fromEntries(keys.filter(k=>Object.hasOwn(a,k)).map(k=>[k,a[k]])))};
    if(windows(next.claude)) {clean.claude=next.claude;clean.claudeSeenAt=next.claudeSeenAt??next.checkedAt;}
    writeJson(target,clean);
  } catch { /* retain the existing last-good file */ }
  finally {if(held)try{fs.rmdirSync(lock);}catch{}}
}
