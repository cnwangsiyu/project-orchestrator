#!/usr/bin/env node
// Synthetic XML only. Never inspect a real application manifest or credential store.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { maskLogText, scanLogFindings } from '../lib/nightly-audit.mjs';
import { redactLogFile } from '../lib/log-redaction.mjs';
import { redactRolloutFile, rolloutReadPath } from '../lib/rollout-redaction.mjs';

const V = 'FAKE_XML_VALUE_723', cases = [];
const labels = ['ApiKey', 'client_secret', 'Token', 'Password', 'Auth', 'APPKEY', 'app_key',
  'access key', 'Signature', 'License', 'com.example.license', 'ACCESS_KEY'];
const layouts = [
  attrs => '<meta-data ' + attrs.join(' ') + ' />',
  attrs => '<meta-data\n    ' + attrs.join('\n    ') + '\n/>',
  attrs => '<meta-data\r\n    ' + attrs.join('\r\n    ') + '\r\n/>',
  attrs => ['<meta-data', ...attrs, '/>'].map((line, i) => '   ' + (42 + i) + '\t' + line).join('\n'),
  attrs => ['<meta-data', ...attrs, '/>'].map((line, i) => (42 + i) + ':' + line).join('\n'),
  attrs => ['<meta-data', ...attrs, '/>'].map((line, i) => (42 + i) + '-' + line).join('\n'),
  attrs => ['<meta-data', ...attrs, '/>'].map(line => '+    ' + line).join('\n'),
  attrs => ['<meta-data', ...attrs, '/>'].map(line => '-    ' + line).join('\n'),
  attrs => ['<meta-data', ...attrs, '/>'].map((line, i) => '+' + (42 + i) + ':' + line).join('\n'),
  attrs => ['<meta-data', ...attrs.flatMap(attr => attr.replace('=', '\n=\n').split('\n')), '/>']
    .map((line, i) => (42 + i) + ':' + line).join('\n'),
];
for (const label of labels) for (const quote of ['"', "'"]) for (const reverse of [false, true]) {
  const attrs = ['android:name=' + quote + label + quote, 'android:value=' + quote + V + quote];
  if (reverse) attrs.reverse();
  attrs.push('android:resource=' + quote + '@string/public_setting' + quote, 'android:enabled=' + quote + 'true' + quote);
  for (const layout of layouts) {
    const input = layout(attrs);
    cases.push([input, input.replace(V, '[MASKED]')]);
  }
}
cases.push(
  ['<meta-data android:name="ClientSecret" android:value="' + V + '>suffix" />',
    '<meta-data android:name="ClientSecret" android:value="[MASKED]" />'],
  ["<meta-data\nandroid:value=\n'" + V + "'\nandroid:name=\"ClientSecret\"\n/>",
    "<meta-data\nandroid:value=\n'[MASKED]'\nandroid:name=\"ClientSecret\"\n/>"],
  ['<meta-data android:name="ApiKey" android:value="\n42:\t' + V + '\n43:\t" />',
    '<meta-data android:name="ApiKey" android:value="\n42:\t[MASKED]\n43:\t" />'],
  ['<string name="app_key">' + V + '</string>', '<string name="app_key">[MASKED]</string>'],
  ["<string\n name='app_key'\n>\n  " + V + "\n</string>", "<string\n name='app_key'\n>\n  [MASKED]\n</string>"],
  ['42:<string name="app_key">\n43:  ' + V + '\n44:</string>',
    '42:<string name="app_key">\n43:  [MASKED]\n44:</string>'],
  ['+<string name="app_key">\n+  ' + V + '\n+  ' + V + '\n+</string>',
    '+<string name="app_key">\n+  [MASKED]\n+  [MASKED]\n+</string>'],
  ['<key>ClientSecret</key>\n<string>' + V + '</string>', '<key>ClientSecret</key>\n<string>[MASKED]</string>'],
  ['<key>ClientSecret</key>\r\n<string>\r\n  ' + V + '\r\n</string>',
    '<key>ClientSecret</key>\r\n<string>\r\n  [MASKED]\r\n</string>'],
  ['  42\t<key>ClientSecret</key>\n  43\t<string>' + V + '</string>',
    '  42\t<key>ClientSecret</key>\n  43\t<string>[MASKED]</string>'],
  ['+42:<key>ClientSecret</key>\n+43:<string>' + V + '</string>',
    '+42:<key>ClientSecret</key>\n+43:<string>[MASKED]</string>'],
  ['-<key>License</key>\n-<string>\n-  ' + V + '\n-</string>',
    '-<key>License</key>\n-<string>\n-  [MASKED]\n-</string>'],
);

for (const [index, [input, expected]] of cases.entries()) {
  const result = maskLogText(input), findings = scanLogFindings(input);
  // Boolean assertions prevent diagnostics from printing even synthetic values.
  assert.ok(result.text === expected, 'XML exact replacement case ' + index);
  assert.ok(!result.text.includes(V), 'XML value removed case ' + index);
  assert.ok(result.text.split('\n').length === input.split('\n').length, 'XML line count case ' + index);
  assert.ok(findings.length === result.masked && findings.length > 0, 'XML scanner parity case ' + index);
  assert.ok(findings.every(hit => !JSON.stringify(hit).includes(V)), 'XML metadata only case ' + index);
  const again = maskLogText(result.text);
  assert.ok(again.text === result.text && again.masked === 0, 'XML idempotence case ' + index);
  for (const wrapper of [text => JSON.stringify(text), text => JSON.stringify({ output: text }),
    text => JSON.stringify({ output: JSON.stringify({ output: text }) })]) {
    const nested = maskLogText(wrapper(input));
    assert.ok(nested.text === wrapper(expected), 'JSON escaped XML case ' + index);
    assert.ok(maskLogText(nested.text).masked === 0, 'JSON escaped XML idempotence case ' + index);
  }
}

const negatives = [
  '<meta-data android:name="android.max_aspect" android:value="2.4" />',
  '<meta-data\nandroid:value="ordinary-display-name"\nandroid:name="com.example.version_name"/>',
  '<meta-data android:name="ApiKey" android:resource="@string/public_setting"/>',
  '<meta-data android:name="Token" android:resource="ordinary-public-resource-id"/>',
  '<meta-data android:name="ApiKey"/><meta-data android:name="ordinary" android:value="ordinary-display-name"/>',
  '<meta-data android:name="LicenseEnabled" android:value="true"/>',
  '<meta-data android:name="AuthEnabled" android:value="FALSE"/>',
  ...['42', '-12.5', '0x1234', '1.2.3', 'v1.2.3-beta', '@string/app_key', '@android:string/app_key',
    '@+string/app_key', '${APP_KEY}', '[MASKED]', '[REDACTED]', 'REDACTED', ''].map(value =>
    '<meta-data\n android:name="AppKey"\n android:value="' + value + '"/>'),
  '<string name="display_name">ordinary-display-name</string>',
  '<string name="Token" translatable="false"/>',
  '<string name="app_key">@string/reference</string>',
  '<string name="license_version">1.2.3</string>',
  '<string name="app_key"><b>ordinary-display-name</b></string>',
  '<key>CFBundleVersion</key>\n<string>1.2.3</string>',
  '<key>DisplayName</key>\n<string>ordinary-display-name</string>',
  '<key>ClientSecret</key>\n<dict><key>DisplayName</key><string>ordinary-display-name</string></dict>',
  '<key>ClientSecret</key>\n<true/>\n<string>ordinary-display-name</string>',
  '<key>ClientSecret</key>\nunrelated output\n<string>ordinary-display-name</string>',
  '<key>ClientSecret</key>\n<string>42</string>\n<string>ordinary-display-name</string>',
  '<key>ClientSecret</key>\n<string/>\n<string>ordinary-display-name</string>',
  '<meta-data android:name="ClientSecret" android:value="unfinished',
];
for (const [index, input] of negatives.entries()) {
  const result = maskLogText(input);
  assert.ok(result.text === input && result.masked === 0, 'XML public value preserved case ' + index);
  assert.ok(scanLogFindings(input).length === 0, 'XML public scanner case ' + index);
  const nested = JSON.stringify({ output: input });
  assert.ok(maskLogText(nested).text === nested, 'JSON public XML preserved case ' + index);
}
assert.ok(scanLogFindings(cases[1][0])[0].line === 3, 'XML scanner reports value line');

const root = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xml-log-redaction-'));
try {
  const input = cases.map(([input]) => input).join('\n') + '\n' + negatives.join('\n');
  const expected = cases.map(([, expected]) => expected).join('\n') + '\n' + negatives.join('\n');
  const log = path.join(tmp, 'manifest.log'); fs.writeFileSync(log, input);
  const cli = spawnSync(process.execPath, [path.join(root, 'scripts/mask-logs.mjs'), '--force', log], { encoding: 'utf8' });
  assert.ok(cli.status === 0 && !(cli.stdout + cli.stderr).includes(V), 'XML CLI no value output');
  assert.ok(fs.readFileSync(log, 'utf8') === expected, 'XML CLI exact replacement');
  assert.ok(redactLogFile(log, { force: true }).masked === 0, 'XML worker log idempotence');
  const workerLog = path.join(tmp, 'worker.jsonl');
  const row = { type: 'response_item', payload: { content: [{ text: input }], encrypted_content: 'OPAQUE_' + V } };
  const jsonl = JSON.stringify(row) + '\n'; fs.writeFileSync(workerLog, jsonl);
  const result = redactLogFile(workerLog, { force: true });
  const maskedRow = JSON.parse(fs.readFileSync(workerLog, 'utf8'));
  assert.ok(result.masked > 0 && maskedRow.payload.content[0].text === expected, 'XML worker JSONL masks values');
  assert.ok(maskedRow.payload.encrypted_content === row.payload.encrypted_content, 'XML opaque provider content preserved');
  assert.ok(scanLogFindings(jsonl, { jsonl: true }).length === result.masked, 'XML JSONL scanner parity');
  const rollout = path.join(tmp, 'rollout.jsonl'); fs.writeFileSync(rollout, jsonl);
  redactRolloutFile(rollout);
  assert.ok(fs.readFileSync(rollout, 'utf8') === jsonl, 'XML durable rollout byte preservation');
  const snapshotRow = JSON.parse(fs.readFileSync(rolloutReadPath(rollout), 'utf8').split('\n')[1]);
  assert.ok(snapshotRow.payload.content[0].text === expected, 'XML rollout snapshot masks values');
  assert.ok(snapshotRow.payload.encrypted_content === row.payload.encrypted_content, 'XML rollout opaque content preserved');
  const giant = '<meta-data android:name="ClientSecret" android:value="' + 'FAKE_LONG_'.repeat(20000) + '"/>';
  const giantResult = maskLogText(giant);
  assert.ok(giantResult.masked === 1 && giantResult.text === '<meta-data android:name="ClientSecret" android:value="[MASKED]"/>',
    'XML giant attribute avoids regexp overflow');
  console.log('PASS XML masking: ' + cases.length + ' positive and ' + negatives.length +
    ' negative forms, JSON, CLI, worker logs and rollout snapshots');
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
