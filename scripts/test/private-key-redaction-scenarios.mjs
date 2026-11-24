#!/usr/bin/env node
// Fake marker/body fixtures only; never load keys, sessions or vendor helpers.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { maskLogText } from '../lib/nightly-audit.mjs';
import { PRIVATE_KEY_PLACEHOLDER as placeholder, maskPrivateKeyBlocks, privateKeyBlockStream } from '../lib/private-key-blocks.mjs';
import { redactLogFile } from '../lib/log-redaction.mjs';
import { redactWorkerTurn } from '../lib/worker-redaction.mjs';
import { maskLogs } from '../mask-logs.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'private-block-fixtures-'));
const body = 'FAKE_PRIVATE_KEY_CONTENT_ONLY';
const block = (type = 'OPENSSH', end = true) => {
  const label = [type, 'PRIVATE KEY', ...(type === 'PGP' ? ['BLOCK'] : [])].filter(Boolean).join(' ');
  return ['-----' + 'BEGIN ' + label + '-----', body,
    ...(end ? ['-----' + 'END ' + label + '-----'] : [])].join('\n');
};
try {
  for (const type of ['', 'RSA', 'DSA', 'EC', 'ENCRYPTED', 'OPENSSH', 'PGP', 'CUSTOM-TYPE']) {
    const key = block(type);
    for (const text of [key, key.split('\n').map(line => '  ' + line).join('\n'), key.split('\n').map(line => `"${line}"`).join('\n'),
      JSON.stringify({ text: key }), JSON.stringify({ nested: JSON.stringify({ text: key }) })]) {
      const result = maskLogText(text);
      assert.equal(result.masked, 1, type);
      assert.ok(result.text.includes(placeholder)); assert.ok(!result.text.includes(body));
      assert.ok(!/-----(?:BEGIN|END)/.test(result.text));
      assert.equal(maskLogText(result.text).masked, 0, 'idempotent block masking');
    }
  }
  const plain = `before\n${block()}\nafter\n`;
  assert.equal(maskLogText(plain).text, `before\n${placeholder}\nafter\n`);
  const unclosed = `before\n${block('OPENSSH', false)}\nDROP_THIS_TRAILING_TEXT`;
  assert.equal(maskLogText(unclosed).text, `before\n${placeholder}`);
  const wrongEnd = block('RSA', false) + '\n' + '-----' + 'END EC PRIVATE KEY-----\nDROP_THIS_TRAILING_TEXT';
  assert.equal(maskLogText(wrongEnd).text, placeholder, 'a different key type cannot terminate the block');
  assert.equal(maskLogText(block() + '\n' + block('PGP')).masked, 2);
  const jsonl = JSON.stringify({ type: 'command', text: block() }) + '\n';
  const sanitized = maskLogText(jsonl, { jsonl: true });
  assert.equal(JSON.parse(sanitized.text).text, placeholder); assert.equal(sanitized.masked, 1);

  for (const text of [plain, unclosed, wrongEnd, JSON.stringify({ text: block() }), 'préface\n' + plain]) {
    const bytes = Buffer.from(text), expected = maskPrivateKeyBlocks(text);
    for (let boundary = 0; boundary <= bytes.length; boundary++) {
      let output = ''; const stream = privateKeyBlockStream(part => { output += part; });
      stream.push(bytes.subarray(0, boundary)); stream.push(bytes.subarray(boundary)); stream.end();
      assert.equal(output, expected.text, `byte boundary ${boundary}`); assert.equal(stream.masked, 1);
    }
  }
  console.log('PASS all private-key types, indented/quoted/escaped forms, unterminated blocks, idempotence and every byte split');

  for (const text of [
    'https://kross.example.invalid/webshell?ticket=fake-short&cluster=fake-cluster',
    'https://shell.example.invalid/exec?u=fake-short&ns=fake-cluster',
    JSON.stringify({ webshellUrl: 'https://example.invalid/connect?opaque=fake-short' }),
    JSON.stringify({ result: { url: 'https://kross.example.invalid/exec?t=fake-short' } }),
    'https://example.invalid/page?access_token=fake-short&view=public',
    'https://example.invalid/page?sign=fake-short&view=public',
    'https://kross.example.invalid/exec?=fake-short',
  ]) {
    const result = maskLogText(text);
    assert.ok(!result.text.includes('fake-short')); assert.ok(result.masked > 0);
    assert.equal(maskLogText(result.text).masked, 0);
  }
  assert.equal(maskLogText('https://example.invalid/docs?view=public').masked, 0);
  console.log('PASS Kross/webshell/exec temporary URL query values and generic credential parameters');

  for (const key of ['密码', '口令', '密钥', '令牌', '账号密码']) for (const separator of ['：', ':', ' 是 ', ' 为 ']) {
    const result = maskLogText(`提示 ${key}${separator}FAKE_DOC_VALUE_ONLY。结束`);
    assert.ok(!result.text.includes('FAKE_DOC_VALUE_ONLY')); assert.ok(result.text.includes('结束')); assert.equal(result.masked, 1);
  }
  for (const key of ['storePassword', 'keyPassword', 'password', 'passwd', 'secret', 'token', 'apiKey', 'accessKey', 'credential']) {
    for (const form of [`${key} 'FAKE_DSL_ONLY'`, `${key} "FAKE_DSL_ONLY"`, `${key}("FAKE_DSL_ONLY")`, `${key}'FAKE_DSL_ONLY'`, `${key.toUpperCase()} ( 'FAKE_DSL_ONLY' )`]) {
      const result = maskLogText(form); assert.ok(!result.text.includes('FAKE_DSL_ONLY')); assert.ok(result.masked > 0);
      assert.equal(maskLogText(result.text).masked, 0);
      for (const jsonl of [false, true]) {
        const encoded = maskLogText(JSON.stringify({ output: form }), { jsonl });
        assert.ok(!encoded.text.includes('FAKE_DSL_ONLY')); assert.ok(encoded.masked > 0);
        assert.equal(maskLogText(encoded.text, { jsonl }).masked, 0);
      }
    }
  }
  for (const parameter of ['sign', 'signature', 'sig', 'token', 'access_token', 'auth', 'authorization',
    'expires=1720000000&signature', 'x-tos-security-token', 'X-Amz-Signature', 'policy', 'code', '%73ig']) {
    const base = 'https://images.example.invalid/item';
    const input = `${base}?width=100&${parameter}=FAKE_SIGNED_ONLY&other=200`;
    assert.equal(maskLogText(input).text, `${base}?[MASKED]`);
    assert.equal(maskLogText(maskLogText(input).text).masked, 0);
  }
  for (const base of ['https://files.feishu.cn/space/api/box/stream/download/all/asset',
    'https://open.larksuite.com/drive/attachments/fixture', 'https://api.meego.com/assets/download']) {
    const input = `[fixture](${base}?opaque=invented-value&mode=original#section)`;
    const expected = `[fixture](${base}?[MASKED]#section)`;
    assert.equal(maskLogText(input).text, expected);
    for (const jsonl of [false, true]) {
      const record = JSON.stringify({ output: input });
      const masked = maskLogText(record, { jsonl });
      assert.equal(JSON.parse(masked.text).output, expected);
      assert.equal(maskLogText(masked.text, { jsonl }).masked, 0);
    }
  }
  const escapedLink = String.raw`{"output":"https://fixture.invalid/a?sig=fake\u0026width=still-private\nnext"}`;
  for (const jsonl of [false, true]) {
    assert.equal(JSON.parse(maskLogText(escapedLink, { jsonl }).text).output,
      'https://fixture.invalid/a?[MASKED]\nnext');
  }
  for (const input of ['https://example.invalid/docs?page=2', 'https://example.invalid/search?q=foo',
    'https://github.com/search?q=webshell&type=code', 'https://docs.feishu.cn/docs/search?q=fixture',
    'https://feishu.cn.example.invalid/stream/download?q=fixture', 'https://example.invalid/page?q=foo#sig=fixture']) {
    assert.equal(maskLogText(input).text, input);
  }
  const fakeHost = 'fakeabc123def456ghi789jkl012mno345.example.invalid';
  for (const image of [`![${fakeHost}](https://images.example.invalid/item)`, `<img alt="${fakeHost}" src="https://images.example.invalid/item">`])
    assert.ok(!maskLogText(image).text.includes(fakeHost));
  console.log('PASS Chinese prose labels, Groovy/Kotlin credential literals, signed attachment queries and image-alt hostnames');

  const direct = path.join(tmp, 'direct.log'); fs.writeFileSync(direct, plain);
  assert.equal(redactLogFile(direct, { force: true }).masked, 1);
  assert.equal(fs.readFileSync(direct, 'utf8'), `before\n${placeholder}\nafter\n`);
  const cli = path.join(tmp, 'cli.log'); fs.writeFileSync(cli, plain);
  assert.equal(maskLogs([cli], { dryRun: true, force: true })[0].masked, 1);
  assert.equal(fs.readFileSync(cli, 'utf8'), plain, 'dry run keeps fixture bytes');
  const maskedCLI = spawnSync(process.execPath, [path.join(root, 'mask-logs.mjs'), '--force', cli], { encoding: 'utf8' });
  assert.equal(maskedCLI.status, 0, maskedCLI.stderr); assert.equal(maskedCLI.stdout, cli + '\n');
  const rewriteManifest = /rewrite manifest=([^\r\n]+)/.exec(maskedCLI.stderr)?.[1];
  assert.ok(rewriteManifest);
  assert.deepEqual(fs.readFileSync(rewriteManifest, 'utf8').trim().split('\n').map(JSON.parse), [cli]);
  assert.equal(fs.readFileSync(cli, 'utf8'), `before\n${placeholder}\nafter\n`);
  const oldShared = process.env.RULES_SHARED; process.env.RULES_SHARED = tmp;
  try {
    const home = path.join(tmp, 'fake-home'); fs.mkdirSync(home);
    const log = path.join(tmp, 'worker.log'), out = path.join(tmp, 'worker.md');
    fs.writeFileSync(log, plain); fs.writeFileSync(out, plain);
    const counts = await redactWorkerTurn({ home, thread: 'fake-thread', log, out, checkIdle: () => true,
      tracker: { set() {}, metadata: () => ({ account: 'main', owner: 'f1234567-abcd-4578-8987-123456789000' }) }, warn() {}, print() {} });
    assert.equal(counts.log, 1); assert.equal(counts.out, 1);
    assert.ok(!fs.readFileSync(log, 'utf8').includes(body)); assert.ok(!fs.readFileSync(out, 'utf8').includes(body));
  } finally { if (oldShared === undefined) delete process.env.RULES_SHARED; else process.env.RULES_SHARED = oldShared; }
  console.log('PASS file masker, CLI force/dry-run and idle worker log/out redaction');

  const child = path.join(tmp, 'child.mjs'), streamed = path.join(tmp, 'stream.log');
  const chunks = ['safe\n', ...block().match(/.{1,7}|\n/g), '\nafter\n'];
  fs.writeFileSync(child, `const chunks=${JSON.stringify(chunks)};for(const chunk of chunks){process.stdout.write(chunk);await new Promise(r=>setTimeout(r,2));}`);
  const live = spawnSync(process.execPath, [path.join(root, 'lib/run-with-masked-log.mjs'), streamed, '--', process.execPath, child], { encoding: 'utf8', timeout: 10000 });
  assert.equal(live.status, 0, live.stderr);
  assert.equal(live.stdout, `safe\n${placeholder}\nafter\n`);
  assert.ok(!fs.readFileSync(streamed, 'utf8').includes(body)); assert.match(live.stderr, /masked=1/);
  console.log('PASS live build output and stored log mask a private-key block split across chunks');
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
