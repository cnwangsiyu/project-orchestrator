#!/usr/bin/env node
// Synthetic log fixtures only; never open worker logs or authentication files.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { passwordStyleFindings, maskPasswordStyleValues, maskLogText } from '../lib/nightly-audit.mjs';

const script = fileURLToPath(new URL('../nightly-review.mjs', import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nightly-audit-'));
const fake = 'fake-not-a-secret-123';
const old = new Date(Date.now() - 180000);
const env = { ...process.env, HOME: tmp, NIGHTLY_DIR: path.join(tmp, 'nightly') };
const fixture = (name, text, mode = 0o600) => {
  const file = path.join(tmp, name);
  fs.writeFileSync(file, text, { mode }); fs.utimesSync(file, old, old);
  return file;
};
const command = (cmd, file, ...flags) => {
  const result = spawnSync(process.execPath, [script, cmd, '--file', file, ...flags], { env, encoding: 'utf8', timeout: 10000 });
  assert.ok(!`${result.stdout}${result.stderr}`.includes(fake), 'command exposed a fixture value');
  assert.equal(result.error, undefined);
  return result;
};
const success = (cmd, file, ...flags) => {
  const result = command(cmd, file, ...flags);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  return JSON.parse(result.stdout);
};

try {
  const keys = ['password', 'passphrase', 'passwd', 'pwd', 'pass', 'token', 'secret', 'apikey', 'api_key', 'api-key',
    'accesskey', 'access_key', 'access-key', 'privatekey', 'private_key', 'private-key', 'credential', 'credentials', 'auth'];
  for (const key of keys) {
    for (const [input, output] of [
      [`${key} = ${fake}; keep`, `${key} = [MASKED]; keep`],
      [`${key.toUpperCase()}: '${fake}', keep`, `${key.toUpperCase()}: '[MASKED]', keep`],
      [`${key} "${fake}"`, `${key} "[MASKED]"`],
      [`"${key}": "${fake}"`, `"${key}": "[MASKED]"`],
    ]) {
      // PASS: is a completion marker retained by the original scanner.
      const marker = key === 'pass' && input.startsWith('PASS:');
      assert.deepEqual(passwordStyleFindings(input), marker ? [] : [{ line: 1, field: key }]);
      assert.deepEqual(maskPasswordStyleValues(input), { text: marker ? input : output, masked: Number(!marker) });
    }
  }
  const excluded = [
    'PASS: signed', 'username "ordinary-user"', 'oauth=value', 'tokens=value', 'password_length=12',
    'password=', 'password=""', 'password=$TEST_PASSWORD', 'password="${TEST_PASSWORD}"',
    'token=${TEST_TOKEN}', 'secret=REDACTED', 'api_key=[REDACTED]', 'private-key=[MASKED]',
    'access-key=<placeholder>', 'credential={redacted}', 'auth="{already redacted}"', 'passphrase=***',
  ].join('\n');
  assert.deepEqual(passwordStyleFindings(excluded), []);
  assert.deepEqual(maskPasswordStyleValues(excluded), { text: excluded, masked: 0 });
  const gradle = `credentials {\n username "${fake}"; password '${fake}'\n nested { label "}"; token=$TEST_TOKEN }\n}\nusername "ordinary-user"`;
  assert.deepEqual(passwordStyleFindings(gradle), [{ line: 2, field: 'username' }, { line: 2, field: 'password' }]);
  assert.equal(maskPasswordStyleValues(gradle).text, 'credentials {\n username "[MASKED]"; password \'[MASKED]\'\n nested { label "}"; token=$TEST_TOKEN }\n}\nusername "ordinary-user"');
  const escaped = `password="${fake}\\\"tail"\nsecret='${fake}\\'tail'`;
  assert.deepEqual(maskPasswordStyleValues(escaped), { text: 'password="[MASKED]"\nsecret=\'[MASKED]\'', masked: 2 });
  assert.deepEqual(passwordStyleFindings(`password="${fake}\ncontinued"\nauth=${fake}`), [{ line: 1, field: 'password' }, { line: 3, field: 'auth' }]);
  console.log('PASS secret-key syntax, credential blocks, escaped values and false-positive exclusions');

  const records = [
    JSON.stringify({ type: 'tool_output', output: `build output\npassword = "${fake}"\napi_key: '${fake}'\nkeep this text`, number: 7 }),
    JSON.stringify({ nested: { array: [`token=${fake}`, { output: gradle }, 'ordinary text'] }, ok: true }),
    JSON.stringify(`private-key=${fake}`),
    '{ malformed output; auth = ' + fake,
    '  {"output": "non-secret text", "count": 9}  ',
    JSON.stringify({ output: 'password=$TEST_PASSWORD\nsecret=[REDACTED]' }),
  ];
  const original = records.join('\n') + '\n';
  const jsonl = fixture('worker.jsonl', original);
  const stat = fs.statSync(jsonl);
  const scanned = success('scan-log', jsonl);
  assert.deepEqual(scanned, { findings: [
    { line: 1, field: 'password' }, { line: 1, field: 'api_key' },
    { line: 2, field: 'token' }, { line: 2, field: 'username' }, { line: 2, field: 'password' },
    { line: 3, field: 'private-key' }, { line: 4, field: 'auth' },
  ] });
  assert.equal(fs.readFileSync(jsonl, 'utf8'), original, 'scan-log must be read-only');
  assert.deepEqual(success('redact-log', jsonl), { file: jsonl, masked: 7, lines: 6 });
  const redacted = fs.readFileSync(jsonl, 'utf8'), lines = redacted.trimEnd().split('\n');
  assert.ok(!redacted.includes(fake), 'redacted JSONL retained a fixture value');
  assert.equal(JSON.parse(lines[0]).output, 'build output\npassword = "[MASKED]"\napi_key: \'[MASKED]\'\nkeep this text');
  assert.equal(JSON.parse(lines[0]).number, 7);
  assert.deepEqual(JSON.parse(lines[1]).nested.array, ['token=[MASKED]', { output: maskPasswordStyleValues(gradle).text }, 'ordinary text']);
  assert.equal(JSON.parse(lines[1]).ok, true);
  assert.equal(JSON.parse(lines[2]), 'private-key=[MASKED]');
  assert.equal(lines[3], '{ malformed output; auth = [MASKED]');
  assert.equal(lines[4], records[4]); assert.equal(lines[5], records[5]);
  assert.ok(redacted.endsWith('\n'));
  assert.equal(fs.statSync(jsonl).mode & 0o777, 0o600);
  assert.ok(Math.abs(fs.statSync(jsonl).mtimeMs - stat.mtimeMs) < 1);
  assert.notEqual(fs.statSync(jsonl).ino, stat.ino, 'redaction must replace the file atomically');
  const newStat = fs.statSync(jsonl);
  assert.deepEqual(success('redact-log', jsonl), { file: jsonl, masked: 0, lines: 6 });
  assert.equal(fs.readFileSync(jsonl, 'utf8'), redacted);
  assert.equal(fs.statSync(jsonl).ino, newStat.ino);
  assert.deepEqual(success('scan-log', jsonl), { findings: [] });
  console.log('PASS JSONL strings, nested arrays, malformed-line fallback, counts and byte-idempotence');

  for (const extension of ['log', 'out', 'txt']) {
    const file = fixture(`worker.${extension}`, `prefix\r\npassword = '${fake}'; token=${fake}\r\nnon-secret text`, 0o640);
    assert.deepEqual(success('redact-log', file), { file, masked: 2, lines: 3 });
    assert.equal(fs.readFileSync(file, 'utf8'), 'prefix\r\npassword = \'[MASKED]\'; token=[MASKED]\r\nnon-secret text');
    assert.equal(fs.statSync(file).mode & 0o777, 0o640);
    assert.deepEqual(success('redact-log', file), { file, masked: 0, lines: 3 });
  }
  assert.deepEqual(maskLogText(''), { text: '', masked: 0, lines: 0 });
  assert.equal(maskLogText('\n').lines, 1);
  const empty = fixture('empty.log', '');
  assert.deepEqual(success('redact-log', empty), { file: empty, masked: 0, lines: 0 });
  console.log('PASS plain-text formats, CRLF, no final newline, empty logs and original permissions');

  const recent = fixture('recent.log', `secret=${fake}\n`);
  fs.utimesSync(recent, new Date(), new Date());
  const recentText = fs.readFileSync(recent, 'utf8'), recentStat = fs.statSync(recent);
  const refused = command('redact-log', recent);
  assert.equal(refused.status, 1); assert.equal(refused.stdout, ''); assert.match(refused.stderr, /120 s/);
  assert.equal(fs.readFileSync(recent, 'utf8'), recentText);
  assert.equal(fs.statSync(recent).ino, recentStat.ino);
  assert.equal(success('scan-log', recent).findings.length, 1);
  assert.deepEqual(success('redact-log', recent, '--force'), { file: recent, masked: 1, lines: 1 });
  assert.deepEqual(success('redact-log', recent, '--force'), { file: recent, masked: 0, lines: 1 });

  const racing = fixture('racing.log', `password=${fake}`);
  const hook = `import fs from 'node:fs';
    const write = fs.writeFileSync;
    fs.writeFileSync = function(file, ...args) {
      const result = write.call(this, file, ...args);
      if (typeof file === 'number') fs.appendFileSync(process.env.FIXTURE_LOG, '\\nnew writer line\\n');
      return result;
    };`;
  const race = spawnSync(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(hook)}`, script, 'redact-log', '--file', racing, '--force'], {
    env: { ...env, FIXTURE_LOG: racing }, encoding: 'utf8', timeout: 10000,
  });
  assert.equal(race.status, 1); assert.equal(race.stdout, '');
  assert.match(race.stderr, /changed before replacement/);
  assert.ok(!race.stderr.includes(fake), 'race refusal exposed a fixture value');
  assert.equal(fs.readFileSync(racing, 'utf8'), `password=${fake}\nnew writer line\n`);

  const target = fixture('target.log', `password=${fake}`);
  const link = path.join(tmp, 'link.log'); fs.symlinkSync(target, link);
  const directory = path.join(tmp, 'directory.log'); fs.mkdirSync(directory);
  const huge = fixture('huge.jsonl', ''); fs.truncateSync(huge, 256 * 2 ** 20 + 1);
  const unsafe = path.join(tmp, 'auth'); fs.mkdirSync(unsafe);
  const unsafeFile = path.join(unsafe, 'worker.log'); fs.writeFileSync(unsafeFile, `password=${fake}`);
  for (const file of [link, directory, huge, unsafeFile, path.join(tmp, 'missing.log'), 'relative.log', fixture('worker.md', `password=${fake}`)]) {
    for (const cmd of ['scan-log', 'redact-log']) {
      const result = command(cmd, file, '--force');
      assert.equal(result.status, 1); assert.equal(result.stdout, '');
    }
  }
  assert.equal(fs.readFileSync(target, 'utf8'), `password=${fake}`);
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
  assert.ok(!fs.readdirSync(tmp).some(name => name.endsWith('.tmp')));
  console.log('PASS recent-writer refusal/force, replacement race, unsafe-file refusal and value-free output');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
