// Follower-owned provisional outcomes. No provider calls or private configuration reads.
import fs from 'node:fs';
import path from 'node:path';
import { rulesLog, readRecords, isRouteDecision } from './global-rules.mjs';
import { withLock } from './shared-file.mjs';
import { completionKind } from './worker-completion.mjs';

const bare = (project, name) => name.startsWith(`${project}-`) ? name.slice(project.length + 1) : name;
const sameTask = (project, name, row) => row.project === project && typeof row.name === 'string'
  && bare(project, row.name) === bare(project, name);
export const reviewSeat = ({ category, role, name }) => ['review', 'review-high', 'adversarial', 'second-opinion'].includes(category)
  || role === 'second' || /-R\d*$/.test(name ?? '');
export const reviewInstructions = 'End your final message with exactly one line REVIEW-RESULT: blocking or REVIEW-RESULT: none. Use blocking when at least one finding must be fixed before acceptance; otherwise use none.';
export const parseReviewResult = (final = '') => {
  const lines = final.trimEnd().split(/\r?\n/);
  const markers = lines.filter(line => /^REVIEW-RESULT:/.test(line));
  const match = lines.at(-1)?.match(/^REVIEW-RESULT: (blocking|none)$/);
  return markers.length === 1 && match ? match[1] : null;
};
// Status words must stand as report labels, not appear in explanations like "no BLOCKED tasks".
export const unresolvedFinal = (final = '') => /^(?:\s*(?:#{1,6}\s+|[-*]\s+)?(?:\*\*)?(?:[\w.-]+[ :]+)?(?:BLOCKED|FAILED|FAIL|QUESTION|NEEDS[-_ ]USER)\b)|\bneeds[-_ ]user\b/im.test(final);

export function recordWorkerOutcome({ project, name, category, role, account = 'main', model, effort, actualModel,
  startedAt, command, thread, turn, exit, final = '', terminal = false, status, error, cumulativeInput, skip = false, log = rulesLog(), time = Date.now() }) {
  // Exit 4 leaves a live turn. Handoffs, approval/deferral and cancellation uncertainty are not task results.
  if (skip || [4, 7, 8, 9, 10, 130, 143, 129].includes(exit)) return null;
  const records = readRecords(log);
  const routes = records.filter(isRouteDecision);
  const decision = routes.filter(row => (!project || row.project === project) && typeof row.name === 'string' && (!project ? row.name === name : bare(project, row.name) === bare(project, name))).at(-1);
  project ??= decision?.project; category ??= decision?.category;
  if (typeof project !== 'string' || typeof name !== 'string' || !name || !category) return null;
  // Only proven completions can pass; other terminal/launcher failures provisionally count as infra failures.
  if (exit === 0 && !terminal) return null;
  const reviewRun = reviewSeat({ category, role, name });
  const reviewResult = reviewRun && terminal && exit === 0 ? parseReviewResult(final) : null;
  const unresolved = unresolvedFinal(final);
  const transport = completionKind({ status, error }) === 'transport-failed';
  // A review verdict may say BLOCKED while supplying a valid blocking marker. Keep that yield as metadata,
  // without calling the unresolved turn a task pass/fail.
  if (unresolved && !reviewResult && !transport) return null;
  fs.mkdirSync(path.dirname(log), { recursive: true });
  return withLock(log, () => {
    const rows = readRecords(log);
    const prior = rows.filter(row => row.kind === 'outcome' && row.auto === true && sameTask(project, name, row));
    // Multiple followers/wait reattachments for one turn must not add a round or a duplicate outcome.
    if (thread && turn && prior.some(row => row.thread === thread && row.turn === turn)) return null;
    const launches = rows.filter(row => row.kind === 'launch' && sameTask(project, name, row));
    const execution = rows.findLast(row => row.kind === 'launch-model' && row.thread === thread && row.turn === turn && row.actualModel);
    actualModel ??= execution?.actualModel;
    effort ??= execution?.actual?.effort ?? launches.at(-1)?.effort;
    model ??= launches.at(-1)?.model;
    const owned = rows.filter(row => isRouteDecision(row) && sameTask(project, name, row));
    const firstLaunch = Math.min(startedAt ?? time, ...launches.map(row => row.t), ...prior.map(row => row.startedAt ?? row.t));
    const previous = prior.at(-1);
    const newTurns = launches.filter(row => row.continuation && row.t > (previous?.t ?? time) && !row.blocked).length;
    const rounds = (previous?.rounds ?? 0) + (command === 'turn' && previous && ['pass', 'rework'].includes(previous.result) ? Math.max(1, newTurns) : 0);
    const pick = { vendor: 'codex', model: actualModel ?? model ?? null, effort: effort ?? 'medium', account };
    const actual = actualModel ? [...(previous?.actual ?? []), { ...pick }] : previous?.actual;
    const rec = { t: time, kind: 'outcome', auto: true, project, name, category, role: role ?? 'primary',
      reviewRun, ...(transport ? { result: 'transport-failed' } : !unresolved ? { result: exit === 0 ? rounds ? 'rework' : 'pass' : 'fail' } : {}), rounds,
      cause: transport ? 'transport' : exit === 0 ? null : 'infra', failureKind: transport ? 'transport-failed' : exit === 0 ? 'quality' : 'infra',
      minutes: Math.max(0, (time - firstLaunch) / 60000), startedAt: firstLaunch, thread, turn, exit,
      ...(terminal && Number.isSafeInteger(cumulativeInput) && cumulativeInput > 0 ? { cumulativeInput, usageAccount: account } : {}),
      first: owned[0]?.pick ?? previous?.first ?? pick, accepted: exit === 0 ? pick : null,
      impact: owned[0]?.impact ?? null, decisions: owned.length,
      ...(actual ? { actual } : {}), actualStatus: actualModel ? 'KNOWN' : 'UNKNOWN',
      ...(reviewRun ? { reviewResult } : {}) };
    fs.appendFileSync(log, JSON.stringify(rec) + '\n');
    return rec;
  });
}
