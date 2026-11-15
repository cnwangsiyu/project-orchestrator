// Shared policy constants and classification. No quota or host-state reads.
export const REVIEW_CLASSES=['A','B','C','D'];
export const mandatoryReview=t=>REVIEW_CLASSES.includes(t.reviewClass??t.flags?.['review-class']);
export const PROJECT_REVIEW_POLICIES={
  'video-agent':{reviewTargetPct:10,externalRelease:false},
  'vesdk-mainline':{reviewTargetPct:20,externalRelease:true},
  webview:{reviewTargetPct:20,externalRelease:true},
};
export const projectReviewPolicy=(project,profiles={})=>{
  const entry=profiles[project]??{}, base=profiles.default??{profile:'standard',externalRelease:true};
  const named=profiles.profiles?.[entry.profile??base.profile]??{};
  return {reviewTargetPct:10,externalRelease:false,...base,...PROJECT_REVIEW_POLICIES[project],...named,...entry};
};
export const reviewScope=t=>{
  const explicit=t.reviewScope??t.flags?.['review-scope'];if(explicit)return explicit;
  let name=String(t.name??t.flags?.name??t.taskId??'');const project=t.project??t.flags?.project;
  if(project&&name.startsWith(`${project}-`))name=name.slice(project.length+1);
  return name.replace(/(?:[-_](?:r\d*|review\d*|re-review\d*))+$/ig,'');
};
export function reviewYield(values) {
  const flat=values.flatMap(v=>Array.isArray(v)?v.map(x=>typeof x==='string'?x:`${x?.severity??''} ${x?.priority??''}`):typeof v==='string'?[v]:[]);
  const explicit=flat.find(v=>v==='blocking'||v==='none');if(explicit)return explicit==='blocking'?'found-p0-p1':'none';
  if(flat.some(v=>/review:\s*blocking found/i.test(v))) return 'found-p0-p1';
  if(flat.some(v=>v==='none'||/review:\s*none/i.test(v))) return 'none';
  const text=flat.join('\n');
  if(/\b(?:no|zero|0)\s+(?:new\s+)?p0(?:\s*\/\s*|\s+(?:or|and)\s+)p1\b|\bno\s+(?:blocking|p0\s*\/\s*p1)\s+findings?\b/i.test(text))return 'none';
  return /\bP[01]\b/i.test(text)?'found-p0-p1':'UNKNOWN';
}
