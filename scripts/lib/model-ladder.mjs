// Availability changes model choice, not the meaning of a later quality rung.
export const normalizeLadder = (rows, source, gptOrder) => {
  const kept = [], dropped = [], bestEffort = new Map();
  const efforts = ['low', 'medium', 'high', 'xhigh', 'max'];
  const claudeOrder = ['fable', 'opus', 'sonnet', 'haiku'];
  let bestGPT = Infinity, bestClaude = Infinity, sourceFloor = 0;
  for (const row of rows) {
    const x = row.pick, key = `${x.vendor}:${x.model}`, effort = efforts.indexOf(x.effort);
    const gpt = x.vendor === 'codex' ? gptOrder.indexOf(x.model) : -1;
    const claude = x.vendor === 'claude' ? claudeOrder.indexOf(x.model) : -1;
    const reason = effort <= (bestEffort.get(key) ?? -1) ? 'same model at equal/lower effort'
      : gpt >= 0 && gpt > bestGPT ? 'weaker GPT'
      : claude >= 0 && claude > bestClaude ? 'weaker Claude'
      : row.index < sourceFloor && !bestEffort.has(key) && !(gpt >= 0 && gpt < bestGPT)
        ? 'precedes the substituted stronger model' : null;
    if (reason) { dropped.push({ ...row, reason }); continue; }
    kept.push(row);
    bestEffort.set(key, effort);
    if (gpt >= 0) bestGPT = Math.min(bestGPT, gpt);
    if (claude >= 0) bestClaude = Math.min(bestClaude, claude);
    // A promoted Astra already occupies the later Astra quality stage; do not retry earlier fallback families.
    const stage = source.findIndex((raw) => raw.vendor === x.vendor && raw.model === x.model);
    sourceFloor = Math.max(sourceFloor, row.index, stage);
  }
  return { kept, dropped };
};
