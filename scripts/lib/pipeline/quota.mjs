import { array, object } from './common.mjs';
function projectUsage(w, history, now) {
  const hours=w.windowMins/60,left=Math.max(0,(w.resetsAt-now)/3600000);
  const old=array(history).filter((x)=>x.t<=now&&now-x.t<=86400000&&Math.abs(x.resetsAt-w.resetsAt)<300000&&x.used<=w.used).sort((a,b)=>a.t-b.t)[0];
  const rate=old&&now-old.t>=10800000?(w.used-old.used)/((now-old.t)/3600000):w.used/Math.max(.1*hours,hours-left);
  return { hours, left, rate, projected: Math.round(w.used+rate*left) };
}
export function weeklyProjection(windows, history, now) {
  const w = array(windows).find(w => object(w) && !w.scoped && w.windowMins === 10080);
  if (!w || !Number.isFinite(w.used) || w.used < 0 || !Number.isFinite(w.resetsAt) || w.resetsAt <= now) return null;
  return { used: w.used, projected: projectUsage(w, history, now).projected, resetsAt: w.resetsAt };
}
// Existing personal-window discipline, with an explicit clock. No cache reads.
export function personalBudget(windows, resets, history, now, claude=false) {
  const w=array(windows).filter((w)=>object(w)&&!w.scoped&&w.windowMins>0).sort((a,b)=>b.windowMins-a.windowMins)[0];
  if(!w) return {status:'UNKNOWN',underused:false,overspending:false,deadline:null};
  const { hours, left, rate, projected } = projectUsage(w, history, now), elapsed=1-left/hours;
  const credits=array(resets?.credits).filter((c)=>c.expiresAt>now);
  const deadline=Math.min(left,...credits.map((c)=>(c.expiresAt-now)/3600000));
  if(claude) {
    const share=Math.min(1,left/hours),reserve=Math.max(2,Math.round(20/7*left/24)),cap=Math.round(95-15*share),spareLine=Math.round(cap-20*share);
    const room=Math.max(0,Math.min(95-reserve,cap)-w.used);
    return {status:room<=0||projected>cap?'over':projected>spareLine?'near':'spare',expiring:left<24&&room>=25&&projected<cap,deadline,underused:false};
  }
  const card=credits.sort((a,b)=>a.expiresAt-b.expiresAt)[0], expH=card?(card.expiresAt-now)/3600000:null;
  const gain=w.used/100+left/hours-1, redeem=!!card&&(w.used>=99&&(left/hours>=.1||expH<left)||expH<=1&&gain>.05);
  return {status:'KNOWN',underused:credits.length>0||((w.used+rate*deadline)<100&&(deadline<left||elapsed>=.1)),
    overspending:!credits.length&&projected>115,deadline,frontLoad:credits.length>0,
    weekly:weeklyProjection(windows,history,now),
    redemption:redeem?{cardId:card.id,expiresAt:card.expiresAt,gain}:null};
}
