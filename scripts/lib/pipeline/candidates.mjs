import { EFFORTS, known, freeze, compare, tupleKey, reason } from './common.mjs';

export function enumerateCandidates(task, snapshot) {
  const candidates = [], diagnostics = [];
  for (const account of snapshot.accounts) {
    const catalog = known(account.catalog);
    if (!catalog) { diagnostics.push(reason('enumerate', 'CATALOG_UNKNOWN', 'Account catalog is unresolved.', [account.id])); continue; }
    for (const id of catalog) {
      const model = snapshot.models.find((m) => m.id === id);
      const lanes = snapshot.lanes.filter((l) => l.accountId === account.id && l.modelId === id);
      if (!model || !lanes.length || model.effortsStatus !== 'KNOWN') diagnostics.push(reason('enumerate', 'CAPACITY_UNRESOLVED', 'Model, harness or effort metadata is missing.', [account.id, id]));
      if (!model) continue;
      for (const lane of lanes) {
        if (!known(lane.efforts)) { diagnostics.push(reason('enumerate', 'EFFORTS_UNKNOWN', 'Harness effort support is unresolved.', [lane.id])); continue; }
        for (const effort of EFFORTS.filter((e) => model.efforts.includes(e) && lane.efforts.value.includes(e))) {
          const candidate = { accountId: account.id, modelId: id, family: model.family, laneId: lane.id, harness: lane.harness, effort,
            qualityProfileId: model.qualityProfiles[effort], selectionCause: task.selectionCause };
          candidate.id = tupleKey(candidate); candidates.push(candidate);
        }
      }
    }
  }
  return freeze({ candidates: candidates.sort((a, b) => compare(a.id, b.id)), diagnostics });
}
export const candidateParts = (s, c) => ({ account: s.accounts.find((a) => a.id === c.accountId), model: s.models.find((m) => m.id === c.modelId), lane: s.lanes.find((l) => l.id === c.laneId) });
