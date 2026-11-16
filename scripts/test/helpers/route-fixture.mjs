// Fixture-only explicit user decisions. Never used by the production router.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export function routeFixture(route, args, {env, dir, approve = false, ...options}) {
  const invoke = (argv, extra = {}) => execFileSync(process.execPath, [route, ...argv], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options, env:{...env,...extra},
  });
  if(!approve) return invoke(args);
  // Dry planning avoids double-counting a synthetic accepted dispatch.
  const scopedArgs=args.includes('--urgent')?args:[...args,'--urgent'];
  const first=JSON.parse(invoke(scopedArgs.includes('--dry')?scopedArgs:[...scopedArgs,'--dry']));
  const gates=[...(first.plan?.gates??[]),...(first.plan?.rejected??[]).flatMap(p=>p.gates??(p.gate?[p.gate]:[]))];
  const scopes=gates.filter(g=>['personal-quota','astra','max-effort','fable'].includes(g.kind)&&g.scope)
    .map(g=>({...g.scope,allowPersonalWithCompany:true}));
  if(!scopes.length) return invoke(args);
  const file=path.join(dir,'fixture-approvals.json'), now=Number(env.ROUTE_NOW??Date.now());
  fs.writeFileSync(file,JSON.stringify([{id:'fixture-approval',userDecisionRef:'synthetic-user-decision',
    grantedAt:now-1000,expiresAt:now+60000,revoked:false,scopes}]));
  const clean=scopedArgs.slice(), at=clean.indexOf('--user-ok'); if(at>=0) clean.splice(at,2);
  if(!clean.includes('--urgent')) clean.push('--urgent');
  const result=invoke([...clean,'--user-ok','fixture-approval'],{ROUTE_APPROVAL_FILE:file});
  if(process.env.DEBUG_FIXTURE&&JSON.parse(result).blocked) console.error(JSON.stringify(JSON.parse(result).plan.reasons));
  return result;
}

// Legacy note assertions inspect both buckets; production briefs use only notes.
export const parseRouteJSON = (text) => JSON.parse(text, (key, value) =>
  value && Array.isArray(value.notes) && Array.isArray(value.fixedNotes)
    ? { ...value, allNotes: [...value.fixedNotes, ...value.notes] } : value);
