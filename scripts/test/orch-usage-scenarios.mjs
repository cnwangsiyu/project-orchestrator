#!/usr/bin/env node
// Exercise the real CLI with isolated agents/transcripts; never write to the user's ~/.claude.
//   node scripts/test/orch-usage-scenarios.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'orch-usage.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-usage-test-'));
const home = path.join(tmp, 'home'), cwd = path.join(tmp, 'repo'), bin = path.join(tmp, 'bin');
const projects = path.join(home, '.claude', 'projects', 'fixture'), now = Date.now(), h = 3600000;
for (const dir of [projects, bin]) fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\nprintf \'%s\\n\' "$ORCH_TEST_AGENTS"\n', { mode: 0o755 });
const env = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`,
  ORCH_TEST_AGENTS: JSON.stringify([{ id: 'fixture', sessionId: 'fixture', name: 'Usage fixture \u4e3b\u5bf9\u8bdd' }]) };
let id = 0;
const call = (name, input = {}, extra = {}) => ({ type: 'assistant', timestamp: new Date(now - h).toISOString(), cwd,
  message: { content: [{ type: 'tool_use', id: `call-${id++}`, name, input }] }, ...extra });
const result = (use, content, extra = {}) => ({ type: 'user', timestamp: use.timestamp,
  message: { content: [{ type: 'tool_result', tool_use_id: use.message.content[0].id, content }] }, ...extra });
const transcript = (entries) => fs.writeFileSync(path.join(projects, 'fixture.jsonl'), ['not json', ...entries.map((e) => JSON.stringify(e))].join('\n') + '\n');
const run = (...args) => execFileSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env });
const json = (hours = 24) => JSON.parse(run('--hours', String(hours), '--json'));
const analyse = (hours = 24) => json(hours).orchestrators[0];
const has = (r, kind) => r.flags.some((f) => f.startsWith(kind));

try {
  // The fixture home is itself under a temp root. Only these source checkouts are exempt from the temp exclusion.
  fs.mkdirSync(path.join(cwd, '.git'), { recursive: true });
  fs.mkdirSync(path.join(home, '.claude-other'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude-other', '.git'), 'gitdir: /fixture/main/.git/worktrees/other\n');
  // All three edit tools, path normalization, bookkeeping exemptions and top-five frequency ranking.
  const entries = [call('Edit', { file_path: 'src/a.js' }), call('Write', { file_path: path.join(cwd, 'src/a.js') }),
    call('NotebookEdit', { notebook_path: 'analysis.ipynb' }), ...['b.js', 'c.js', 'd.js', 'e.js'].map((f) => call('Edit', { file_path: f })),
    call('Write', { file_path: path.join(home, '.claude-other', 'source.js') }), call('Edit', { file_path: '.claude/settings.json' })];
  const bookkeeping = ['brief.md', 'ledger.md', 'notes/project.ledger.md', '~/.claude/memory/state.md',
    ...['orchestrator', 'tasks', 'jobs', 'projects'].map((d) => path.join(home, '.claude', d, 'anything.js')),
    path.join(home, '.claude', 'tasks', '..', 'memory', 'state.md')];
  for (const file_path of bookkeeping) entries.push(call('Write', { file_path }));
  entries.push(call('Edit', { file_path: 'state.md' }, { cwd: path.join(home, '.claude', 'memory') }), call('Edit'));
  transcript(entries);
  const edits = analyse();
  assert.equal(edits.edits, 9); assert.equal(edits.toolCalls, entries.length); assert.equal(edits.ownKB, 0);
  assert.equal(edits.editedPaths.length, 5); assert.deepEqual(edits.editedPaths[0], { path: path.join(cwd, 'src/a.js'), calls: 2 });
  assert.ok(has(edits, 'edits source files itself')); assert.match(edits.flags.join('\n'), /src\/a\.js.*route\.mjs/);
  assert.match(run(), /edits 9, tests\/builds 0, tool calls \d+/); assert.match(run(), /edited: 2 .*src\/a\.js/);
  console.log('ok   source edits and bookkeeping');

  // Shell fixtures only describe writes; none of these command strings are executed.
  const source = '/workspace/orch-usage-fixture', py = (s) => `python3 -I - <<'PY'\n${s}\nPY`;
  const shellWrites = [
    "sed -i '' 's/a/b/' src/a.js", "sed -i 's/a/b/' src/a.js", "sed -i.bak -e 's/a/b/' src/a.js", "sed --in-place 's/a/b/' src/a.js",
    "perl -pi -e 's/a/b/g' src/a.js", "perl -i.bak -pe 's/a/b/g' src/a.js", "sed -i '' 's/a/b/' 'src/with space.js'",
    py("open('src/a.py', 'w').write('code')"), py("p = 'src/a.py'\nopen(p, 'w').write('code')"),
    py("from pathlib import Path\nPath('src/a.py').write_text('code')"), py("p = Path('src/a.py')\np.write_bytes(b'code')"),
    "python3 -c 'open(\"src/a.py\", \"a\").write(\"code\")'", py("open(path_from_args, 'w').write('code')"),
    'cat original.js > src/a.js', "cat <<'CODE' > src/a.js\ncode\nCODE", "printf '%s' 'code > comparison' > src/a.js",
    "printf 'code'>>src/a.js", 'tee src/a.js', "printf 'code' | tee -a src/a.js", "tee > src/a.js",
    "P=src/a.js; sed -i '' 's/a/b/' \"$P\"", "cd /workspace/other && sed -i '' 's/a/b/' src/a.js",
    "sed -i '' 's/a/b/' src/a.js; perl -pi -e 's/a/b/g' src/b.js",
    `python3 - src/a.py <<'PY'\nimport sys\np = sys.argv[1]\nopen(p, 'w').write('code')\nPY`,
    py("open(os.path.join(root, 'src/a.py'), 'w').write('code')"), "cd $UNKNOWN_REPO && sed -i '' 's/a/b/' src/a.js",
  ];
  const ignoredWrites = [
    "sed -n '1,10p' src/a.js", "perl -pe 's/a/b/g' src/a.js", 'cat src/a.js', "printf '%s' 'code'",
    py("open('src/a.py', 'r').read()"), py("open('src/a.py').read()"), py("print(\"open('src/a.py', 'w')\")"),
    py("# open('src/a.py', 'w')\nprint('read only')"), py("sys.stdout.write('output')"),
    "cat <<'BRIEF'\nsed -i '' 's/a/b/' src/a.js\nopen('src/a.py', 'w').write('code')\nBRIEF",
    "claude --bg \"sed -i '' 's/a/b/' src/a.js\"", 'git diff > source.patch', 'git apply source.patch', 'npm test > result.js',
    "printf 'code' > brief.md", "cat src/a.js >> ledger.md", "sed -i '' 's/a/b/' tasks/project.ledger.md 2>/dev/null",
    `perl -pi -e 's/a/b/' '${home}/.claude/memory/state.md'`, py(`open('${home}/.claude/jobs/state.py', 'w').write('code')`),
    py(`p = '${home}/.claude/tasks/state.py'\nopen(p, 'w').write('code')`), py("Path('brief.md').write_text('plan')"),
    "printf 'code' > /dev/null", "printf 'code' > /tmp/source.js", "cat src/a.js > /private/tmp/source.js", 'tee /var/tmp/source.js',
    "printf 'code' > \"$TMPDIR/source.js\"", "cat src/a.js > logs/run.log", 'tee -a logs/run.out', "printf '{}' >> events.jsonl",
    "sed -i '' 's/a/b/' run.log", py("open('events.jsonl', 'a').write('event')"), "printf 'error' 2> src/a.js",
    "cd ~/.claude/tasks && printf 'plan' > state.md", "P=~/.claude/memory/state.md; printf 'plan' > \"$P\"",
    "T=~/.claude/tasks; D=$T/task1; cat > $D/brief.md <<'BRIEF'\nplan\nBRIEF",
    "T=~/.claude/tasks; D=$T/task1; printf 'state' > $D/state.md", "cat > $UNKNOWN/brief.md <<'BRIEF'\nplan\nBRIEF",
    `python3 - '${home}/.claude/memory/state.md' <<'PY'\nimport sys\np = sys.argv[1]\nopen(p, 'w').write('state')\nPY`,
    `P=~/.claude/memory/state.md; python3 - <<'PY'\nimport os\np = os.environ['P']\nopen(p, 'w').write('state')\nPY`,
    py("p = os.path.expanduser('~/.claude/memory/state.md')\nopen(p, 'w').write('state')"),
    py("open(os.path.expanduser('~/.claude/memory/state.md'), 'w').write('state')"),
  ];
  for (const [commands, expected] of [[shellWrites, 1], [ignoredWrites, 0]]) for (const command of commands) {
    transcript([call('Bash', { command }, { cwd: source })]);
    const r = analyse(); assert.equal(r.edits, expected, command); assert.equal(r.toolCalls, 1);
  }
  const unknown = py("open(path_from_args, 'w').write('code')");
  transcript([call('Bash', { command: unknown }, { cwd: source })]);
  assert.deepEqual(analyse().editedPaths, [{ path: unknown.slice(0, 60).replace(/\s+/g, ' '), calls: 1 }]);
  transcript(shellWrites.map((command) => call('Bash', { command }, { cwd: source })));
  const labour = analyse(); assert.equal(labour.edits, shellWrites.length); assert.ok(has(labour, 'edits source files itself'));
  assert.equal(labour.editedPaths[0].path, `${source}/src/a.js`);
  console.log('ok   shell edits, Python writes and output/bookkeeping exclusions');

  // Discover .git entries without invoking git. Both worktree files and normal repo directories count below temp roots.
  const job = path.join(home, '.claude', 'jobs', 'fixture'), work = path.join(job, 'tmp', 'po-wt-file'), repo = path.join(job, 'tmp', 'po-wt-dir');
  fs.mkdirSync(path.join(work, 'scripts'), { recursive: true }); fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  fs.writeFileSync(path.join(work, '.git'), 'gitdir: /fixture/main/.git/worktrees/file\n');
  const writesPath = (p) => `open('${p}', 'w').write('code')`;
  const cases = [
    ["J=$CLAUDE_JOB_DIR/tmp; cat > $J/mr-desc.md <<'DOC'\nbrief\nDOC", 0],
    ["cd $CLAUDE_JOB_DIR/tmp && printf 'notes' > mr-desc.md", 0],
    ["M=~/.claude/projects/project/memory; printf 'notes' > $M/state.md", 0],
    [py("m = os.path.expanduser('~/.claude/projects/project/memory/')\np = m + 'state.md'\nopen(p, 'w').write('notes')"), 0],
    [py("j = os.path.join(os.environ['CLAUDE_JOB_DIR'], 'tmp')\np = j + '/mr-desc.md'\nopen(p, 'w').write('notes')"), 0],
    [py(writesPath('/workspace/.claude-data/tasks/plan.md')), 0],
    ["printf 'notes' > /workspace/orchestrator/tasks/threads.txt", 0],
    ["D=/workspace/.claude-data/orchestrator/tasks/T47; cat > $D/kws-merged-conclusion.md <<'DOC'\nnotes\nDOC", 0],
    ["cd /workspace/.claude-data/orchestrator/tasks; cat > tasks/$UNKNOWN/brief-resume.md <<'DOC'\nnotes\nDOC", 0],
    [`cd /workspace/.claude-data/orchestrator/tasks; P='${work}/scripts/route.mjs'; sed -i '' 's/a/b/' "$P"`, 1, `${work}/scripts/route.mjs`],
    [`cd '${work}' && ${py(writesPath('scripts/route.mjs'))}`, 1, `${work}/scripts/route.mjs`],
    [`cd '${repo}' && ${py(writesPath('scripts/route.mjs'))}`, 1, `${repo}/scripts/route.mjs`],
    [`R=$CLAUDE_JOB_DIR/tmp/po-wt-file; cd "$R" && ${py("p = 'scripts/route.mjs'\nopen(p, 'w').write('code')")}`, 1, `${work}/scripts/route.mjs`],
    [`R=$CLAUDE_JOB_DIR/tmp/po-wt-file; P=$R/scripts/route.mjs; sed -i '' 's/a/b/' "$P"`, 1, `${work}/scripts/route.mjs`],
    [`cd '${work}' && ${py("Path('scripts/route.mjs').write_text('code')")}`, 1, `${work}/scripts/route.mjs`],
    [`cd '${work}' && ${py("p = os.path.join(os.getcwd(), 'scripts', 'route.mjs')\nopen(p, 'w').write('code')")}`, 1, `${work}/scripts/route.mjs`],
    [`cd '${work}' && ${py(writesPath('orchestrator/tasks/plan.md'))}`, 0],
    [`cd '${work}' && printf 'notes' > .claude-data/threads.txt`, 0],
    [`TMPDIR='${cwd}/scratch'; printf 'notes' > "$TMPDIR/state.md"`, 0],
    [`TMPDIR='${cwd}'; printf 'notes' > "$TMPDIR/state.md"`, 0],
    [py(writesPath(path.join(tmp, 'plain-temp', 'source.mjs'))), 0],
    [py("p = unknown_path()\nopen(p, 'w').write('code')"), 1],
  ];
  for (const [command, expected, editedPath] of cases) {
    transcript([call('Bash', { command }, { cwd: source })]);
    const r = analyse(); assert.equal(r.edits, expected, command);
    if (editedPath) assert.deepEqual(r.editedPaths, [{ path: editedPath, calls: 1 }]);
  }
  const toolCases = [
    [path.join(work, 'scripts', 'route.mjs'), 1], [path.join(repo, 'source.mjs'), 1], [path.join(job, 'tmp', 'notes.md'), 0],
    [path.join(work, 'orchestrator', 'plan.md'), 0], [path.join(work, '.claude-data', 'threads.txt'), 0],
    ['/workspace/.claude-data/orchestrator/tasks/T47/kws-merged-conclusion.md', 0], ['/workspace/orchestrator/tasks/plan.md', 0],
  ];
  for (const [file_path, expected] of toolCases) {
    transcript([call('Write', { file_path })]); assert.equal(analyse().edits, expected, file_path);
  }
  transcript([call('Bash', { command: `cd '${work}' && ${py("p = 'orchestrator/plan.md'\nopen(p, 'w').write('notes')\np = 'scripts/route.mjs'\nopen(p, 'w').write('code')")}` })]);
  assert.deepEqual(analyse().editedPaths, [{ path: `${work}/scripts/route.mjs`, calls: 1 }]);
  console.log('ok   orchestrator data, temp worktrees and resolved shell/Python paths');

  const builds = ['npm test', 'npm run build', 'pnpm test', 'pnpm build', 'pnpm run test', 'yarn test', 'yarn build', 'yarn run build',
    'node --test', 'pytest -q', 'go test ./...', 'cargo test', 'cargo build', 'xcodebuild -scheme App', 'gradle build', './gradlew test',
    'make', 'swift build', 'swift test', 'bazel test //...', 'ninja', 'node scripts/test/route-scenarios.mjs',
    'cd /repo && node /repo/scripts/test/route-scenarios.mjs', 'CI=1 npm test', 'env CI=1 pnpm run build',
    'npm --prefix web test', 'pnpm -C web build', 'yarn --cwd web test', 'npm run --silent test', 'python3 -m pytest',
    '/usr/bin/make all', 'cmake --build out', 'if true; then npm test; fi', 'npm test && npm run build', 'npm test', 'go build ./...',
    "cat <<'EOF'\nnode --test\nmake a worktree\nEOF\nnode --test"];
  const mentions = ['cat package.json', 'echo npm test', 'rg "npm test" README.md', 'node scripts/route.mjs implement',
    'node scripts/test/not-route-scenarios.mjs', 'cargo --version', 'npm install', 'npm run lint',
    'echo "review; npm test"', 'claude --bg "run npm test; cargo build"', "printf '%s' 'npm test; pytest'", 'echo escaped\\; npm test',
    "cat <<'EOF'\nnode --test\nmake a worktree\nEOF", 'cat <<EOF\nnpm test\nEOF', 'cat <<"BRIEF"\ncargo build\nBRIEF'];
  transcript([...builds, ...mentions].map((command) => call('Bash', { command })));
  const tests = analyse();
  assert.equal(tests.testsBuilds, builds.length); assert.equal(tests.toolCalls, builds.length + mentions.length);
  assert.equal(tests.testBuildCommands.length, 5); assert.deepEqual(tests.testBuildCommands[0], { command: 'npm test', calls: 3 });
  assert.ok(has(tests, 'runs tests/builds itself')); assert.match(tests.flags.join('\n'), /npm test.*route\.mjs/);
  console.log('ok   test/build commands, not mentions or dispatches');

  // Foreground duration is paired by ID, not result order; even routing and non-shell tools can block.
  const timed = (name, input, minutes, extra = {}) => {
    const use = call(name, input, extra);
    return [use, result(use, '', { timestamp: new Date(Date.parse(use.timestamp) + minutes * 60000).toISOString() })];
  };
  const longCommand = `inspect\n  ${'worker-progress-'.repeat(8)}`;
  const blocking = [timed('Bash', { command: longCommand }, 12),
    timed('Bash', { command: 'node scripts/route.mjs implement', run_in_background: false }, 9),
    timed('Read', { file_path: 'source.js' }, 6), timed('Task', { description: 'review worker' }, 4),
    timed('mcp__fixture__build', { command: 'remote build' }, 3),
    timed('Bash', { command: 'background worker', run_in_background: true }, 90),
    timed('Task', { description: 'background review', run_in_background: true }, 120),
    timed('Agent', { description: 'background agent', run_in_background: true }, 120),
    timed('Bash', { command: 'exactly two minutes' }, 2), timed('Read', { file_path: 'quick.js' }, 1.99),
    timed('Read', { file_path: 'zero.js' }, 0), timed('Read', { file_path: 'backwards.js' }, -3)];
  const noResult = call('Bash', { command: 'unfinished' }), invalidResult = call('Read'), invalidUse = call('Read', {}, { timestamp: 'invalid' });
  transcript([...blocking.map(([use]) => use), ...blocking.map(([, res]) => res).reverse(), blocking[0][1], noResult,
    result(call('Read'), ''), invalidResult, result(invalidResult, '', { timestamp: 'invalid' }), invalidUse,
    result(invalidUse, '', { timestamp: new Date(now).toISOString() })]);
  const blockingUsage = analyse();
  assert.equal(blockingUsage.blockedMinutes, 34); assert.equal(blockingUsage.ownKB, 0);
  assert.deepEqual(blockingUsage.blockingExamples, [
    { minutes: 12, command: longCommand.replace(/\s+/g, ' ').slice(0, 60) },
    { minutes: 9, command: 'node scripts/route.mjs implement' }, { minutes: 6, command: 'Read source.js' }]);
  assert.ok(has(blockingUsage, 'blocks in the foreground'));
  assert.match(blockingUsage.flags.join('\n'), /blocks in the foreground: 34 min \(12 min .*; 9 min .*; 6 min Read source\.js\) — run it in the background and dispatch other ready tasks meanwhile/);
  assert.match(run(), /tool calls \d+, blocked 34 min/); assert.match(run(), /blocked: 12 min inspect /);
  assert.ok(has(analyse(12), 'blocks in the foreground')); assert.ok(!has(analyse(48), 'blocks in the foreground'));
  assert.equal(json().limits.blockedMinutes, 30);
  console.log('ok   foreground blocking, background exclusions, pairing and top three examples');

  // Full durations count only for completed calls in the window, strictly over two minutes; limits are strict too.
  const blockingBoundary = timed('Bash', { command: 'long operation' }, 30);
  const oldBlocking = timed('Bash', { command: 'old operation' }, 25, { timestamp: new Date(now - 25 * h).toISOString() });
  transcript([...blockingBoundary, ...oldBlocking, call('Read', {}, { timestamp: undefined })]);
  const exactBlocking = analyse();
  assert.equal(exactBlocking.blockedMinutes, 30); assert.ok(!has(exactBlocking, 'blocks in the foreground'));
  assert.ok(has(analyse(12), 'blocks in the foreground')); assert.ok(!has(analyse(48), 'blocks in the foreground'));
  assert.equal(analyse(48).blockedMinutes, 55);
  transcript([...blockingBoundary, ...timed('Bash', { command: 'short operation' }, 2),
    ...timed('Read', { file_path: 'just-over.js' }, 2.01)]);
  const overBlocking = analyse(); assert.equal(overBlocking.blockedMinutes, 32.01);
  assert.ok(has(overBlocking, 'blocks in the foreground')); assert.equal(overBlocking.blockingExamples.length, 2);
  transcript([call('Read')]);
  assert.equal(analyse().blockedMinutes, 0); assert.deepEqual(analyse().blockingExamples, []);
  console.log('ok   blocking duration boundaries, scaled limits and incomplete/missing timestamps');

  // Exact limits do not flag; all new limits scale both down and up, and old calls stay outside the window.
  const boundary = [...Array.from({ length: 5 }, () => call('Edit', { file_path: 'source.js' })),
    ...Array.from({ length: 3 }, () => call('Bash', { command: 'npm test' })), ...Array.from({ length: 492 }, () => call('Read'))];
  const old = { timestamp: new Date(now - 25 * h).toISOString() };
  transcript([...boundary, call('Edit', { file_path: 'old.js' }, old), call('Bash', { command: 'npm test' }, old),
    call('Edit', { file_path: 'unknown-time.js' }, { timestamp: undefined })]);
  const exact = analyse();
  assert.deepEqual([exact.edits, exact.testsBuilds, exact.toolCalls], [5, 3, 500]); assert.deepEqual(exact.flags, []);
  const half = analyse(12), double = analyse(48);
  for (const kind of ['edits source files itself', 'runs tests/builds itself', 'many tool calls']) {
    assert.ok(has(half, kind)); assert.ok(!has(double, kind));
  }
  const limits = json().limits; assert.deepEqual([limits.edits, limits.testsBuilds, limits.toolCalls], [5, 3, 500]);
  transcript([...boundary, call('Read')]);
  const many = analyse(); assert.equal(many.toolCalls, 501); assert.equal(many.ownKB, 0);
  assert.ok(has(many, 'many tool calls')); assert.match(many.flags.join('\n'), /493 Read.*route\.mjs/);
  console.log('ok   thresholds, scaled windows and calls without results');

  // Existing output buckets/exemptions and flags must remain unchanged.
  const read = call('Read', { file_path: 'source.js' }), route = call('Bash', { command: 'node scripts/route.mjs implement' });
  const legacy = [read, result(read, 'x'.repeat(501 * 1024)), route, result(route, 'x'.repeat(50 * 1024)),
    ...Array.from({ length: 21 }, () => call('mcp__claude-in-chrome__read_page')),
    ...Array.from({ length: 11 }, () => call('Read', { file_path: 'screen.png' })),
    ...Array.from({ length: 11 }, () => call('Bash', { command: 'sleep 60' })), call('Task', { description: 'worker' }),
    { type: 'system', subtype: 'compact_boundary', timestamp: read.timestamp }, { type: 'assistant', isCompactSummary: true, timestamp: read.timestamp }];
  transcript(legacy);
  const unchanged = analyse();
  assert.deepEqual([unchanged.ownKB, unchanged.browserCalls, unchanged.imageReads, unchanged.sleepPolls, unchanged.subagents, unchanged.compactions], [501, 21, 11, 11, 1, 2]);
  assert.deepEqual(unchanged.kinds, { Read: { calls: 1, kb: 501 }, 'shell: routing/quota': { calls: 1, kb: 50 } });
  assert.equal(unchanged.flags.length, 5); assert.deepEqual([unchanged.edits, unchanged.testsBuilds], [0, 0]);
  console.log('ok   existing KB accounting and flags');
  console.log('\nall pass');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
