// Worker final-message protocol. Review verdicts keep their own final-line marker.
export const workerResultInstructions = 'If an environment, access or resource precondition stops the task, include exactly one standalone line WORKER-RESULT: blocked-environment in your final message, before any required REVIEW-RESULT line. Use it for missing tools, login/access, sandbox/network or resource availability; rejected work and failed acceptance checks are quality failures and must not use this marker.';

const reportText = final => {
  const lines = []; let fence = null;
  for (const line of final.split(/\r?\n/)) {
    const marker = line.match(/^\s*(`{3,}|~{3,})(.*)$/);
    if (marker && !fence) { fence = marker[1]; continue; }
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
      continue;
    }
    lines.push(line);
  }
  return lines.join('\n');
};

export function parseWorkerResult(final = '') {
  const markers = reportText(final).split('\n').filter(line => /^WORKER-RESULT:/.test(line));
  return markers.length === 1 ? markers[0].match(/^WORKER-RESULT: (blocked-environment|completed)$/)?.[1] ?? null : null;
}

export function blockedEnvironmentFinal(final = '') {
  final = reportText(final);
  const marker = parseWorkerResult(final);
  if (marker) return marker === 'blocked-environment' ? 'marker' : null;
  // Legacy reports require both a status label and a concrete precondition in
  // the same paragraph. Quoted examples, bare BLOCKED and rejected work do not qualify.
  const label = /^(?:\s*(?:#{1,6}\s+|[-*]\s+)?(?:\*\*)?(?:\[[\w.-]+\]\s+)?(?:\*\*)?(?:(?:status|result|environment|[a-z]+\d[\w.-]*)[ :]+)?(?:BLOCKED|STOPPED)\b)/im;
  const precondition = /\b(?:login required|sign[- ]?in required|not (?:logged|signed) in|missing (?:login|access|permissions?|tools?|executables?|dependencies)|(?:tool|executable|command|dependency) (?:is )?(?:missing|unavailable|not found)|not (?:on|in) (?:the )?PATH|(?:network|sandbox|resource|device|lease|lock|slot|access|permission) (?:is )?(?:unavailable|denied|restricted|missing|busy|held|exhausted)|(?:waiting for|cannot acquire) (?:a |the )?(?:device|lease|lock|slot|resource)|requires? (?:an? )?(?:login|sign[- ]?in)|(?:CLI|browser|desktop tool) (?:is )?(?:unreachable|unavailable))\b/i;
  return final.split(/\r?\n\s*\r?\n/).some(paragraph => label.test(paragraph) && precondition.test(paragraph)) ? 'legacy-label' : null;
}

// Reuse infra's same-tier semantics while preserving the reason in the result.
// An explicit quality/tool correction always takes precedence over this signal.
export const environmentOutcome = row => !!row && row.failureKind === 'infra'
  && (row.result === 'blocked-environment' || row.environmentBlocked === true);
