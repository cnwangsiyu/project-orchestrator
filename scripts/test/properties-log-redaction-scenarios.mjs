#!/usr/bin/env node
// Synthetic labels and values only. Assertion messages never include input text.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { maskLogText, scanLogFindings, passwordStyleFindings } from '../lib/nightly-audit.mjs';
import { redactLogFile } from '../lib/log-redaction.mjs';
import { redactRolloutFile, rolloutReadPath } from '../lib/rollout-redaction.mjs';

const V = 'FAKE_PROPERTIES_VALUE_723', cases = [];
const labels = ['PASSWORD', 'client.passwd', 'build-pwd', 'clientSecret', 'client_token',
  'APIKEY', 'api_key', 'api-key', 'clientApiKey', 'ACCESSKEY', 'access_key', 'private_key',
  'credentials', 'client.credential', 'AUTH', 'clientSignature', 'sign_key', 'storePassword',
  'keyPassword', 'keystore_password', 'store_pass', 'key_pass', 'key_alias_password',
  'license_key', 'magic_word', 'clientMagicWord', 'passphrase', 'COOKIE', 'SESSION',
  'client.cookie', 'client-session', 'APP_KEY', 'privatekey', 'ORG_GRADLE_PROJECT_clientPwd',
  ...['NEXUS', 'ARTIFACTORY', 'MAVEN', 'SONATYPE', 'OSSRH'].flatMap(family =>
    ['USER', 'USERNAME', 'PASSWORD', 'TOKEN'].map(suffix => family + '_' + suffix)),
  'signing.user', 'signing.custom', 'nexus.username', 'artifactory-username',
  'PaSsWoRd', 'client.PaSsWoRd', 'aPiKeY', 'mAgIc_wOrD', 'STOREPASSWORD', 'KEYPASSWORD',
  'LICENSEKEY', 'LICENCEKEY', 'KEYSTOREPASSWORD', 'KEYALIASPASSWORD', 'SIGNINGKEY'];
const layouts = [
  key => `${key}=${V}`,
  key => `${key} = '${V}'`,
  key => `"${key}": "${V}"`,
  key => `'${key}' = ${V}`,
  key => `export ${key}="${V}"`,
  key => `${key}: ${V}`,
];
const prefixes = ['', '42:', '42-', '   42\t', '+ ', '- ', '+42:', '-42:'];
for (const label of labels) for (const layout of layouts) for (const prefix of prefixes) {
  const input = prefix + layout(label);
  cases.push([input, input.replace(V, '[MASKED]')]);
}
cases.push(
  [`customPassword="${V} with spaces" # public comment`, 'customPassword="[MASKED]" # public comment'],
  [`cat /fixture/.env\ncustomPassword=${V} with spaces # public comment`, 'cat /fixture/.env\ncustomPassword=[MASKED] # public comment'],
  [`client_secret='${V}`, "client_secret='[MASKED]"],
  [`password=${V}; public`, 'password=[MASKED]; public'],
  [`//example.invalid/:_authToken=${V}`, '//example.invalid/:_authToken=[MASKED]'],
);

const types = ['gradle.properties', 'local.properties', 'keystore.properties', 'signing.properties',
  '.env', '.env.test', '.netrc', 'settings.xml', '.npmrc', 'pip.conf'];
const headers = [
  file => 'cat /fixture/' + file,
  file => '$ cat -n "/fixture/' + file + '"',
  file => "sed -n '1,90p' /fixture/" + file,
  file => 'File: /fixture/' + file,
  file => 'Path: /fixture/' + file,
  file => 'Read tool: /fixture/' + file,
  file => '=== /fixture/' + file + ' ===',
  file => '/fixture/' + file,
  file => 'diff --git a/' + file + ' b/' + file + '\n--- a/' + file + '\n+++ b/' + file + '\n@@ -1 +1 @@',
];
for (const type of types) for (const format of headers) for (const prefix of ['', '42:', '+ ', '- ']) {
  const input = [format(type), prefix + '# blank lines do not end a dump', '', '[fixture]',
    prefix + 'opaque = ' + V, prefix + 'org.gradle.jvmargs=-Xmx4g',
    prefix + 'android.namespace=com.example.fixture', prefix + 'kotlin.code.style=official',
    prefix + 'sdk.dir=/fixture/sdk', prefix + 'ndk.dir=../fixture/ndk',
    prefix + 'version=1.2.3', prefix + 'enabled=true', prefix + 'count=7',
    prefix + 'website=https://example.invalid/public', prefix + 'ref=${FIXTURE_VALUE}',
    'BUILD FINISHED', 'opaque=ordinary-display-name'].join('\n');
  cases.push([input, input.replace(V, '[MASKED]')]);
}
cases.push(
  ['<string name="license_key"><![CDATA[' + V + ']]></string>',
    '<string name="license_key">[MASKED]</string>'],
  ['<meta-data android:name="license_key" android:value="<![CDATA[' + V + ']]>"/>',
    '<meta-data android:name="license_key" android:value="[MASKED]"/>'],
  ['[INFO] SONATYPE_USERNAME=' + V + ' OSSRH_PASSWORD=' + V,
    '[INFO] SONATYPE_USERNAME=[MASKED] OSSRH_PASSWORD=[MASKED]'],
  ['<meta-data android:name="PaSsWoRd" android:value="' + V + '"/>',
    '<meta-data android:name="PaSsWoRd" android:value="[MASKED]"/>'],
  ['<string name="mAgIc_wOrD">' + V + '</string>', '<string name="mAgIc_wOrD">[MASKED]</string>'],
  ['cat /fixture/.env\nopaque=' + V + ';suffix,second\nother=' + V,
    'cat /fixture/.env\nopaque=[MASKED]\nother=[MASKED]'],
  ['cat /fixture/.env\nopaque=' + V + ' second=' + V,
    'cat /fixture/.env\nopaque=[MASKED] second=[MASKED]'],
  ['cat /fixture/.env\norg.gradle.customSecret=' + V, 'cat /fixture/.env\norg.gradle.customSecret=[MASKED]'],
  ['cat /fixture/.netrc\nlogin "' + V + ' with spaces" password "' + V + ' with spaces"',
    'cat /fixture/.netrc\nlogin "[MASKED]" password "[MASKED]"'],
  ['cat /fixture/settings.xml\n<settings>\n<opaque>\n' + V + '\n</opaque>\n<other>' + V + '</other>\n</settings>',
    'cat /fixture/settings.xml\n<settings>\n<opaque>\n[MASKED]\n</opaque>\n<other>[MASKED]</other>\n</settings>'],
  ['diff --git a/.env b/public.txt\n--- a/.env\n+++ b/public.txt\n-opaque=' + V + '\n+opaque=' + V,
    'diff --git a/.env b/public.txt\n--- a/.env\n+++ b/public.txt\n-opaque=[MASKED]\n+opaque=[MASKED]'],
  ['cat /fixture/.netrc\nmachine example.invalid login ' + V + ' password ' + V,
    'cat /fixture/.netrc\nmachine [MASKED] login [MASKED] password [MASKED]'],
  ['cat /fixture/settings.xml\n<settings>\n<opaque>' + V + '</opaque>\n<version>1.2.3</version>\n</settings>',
    'cat /fixture/settings.xml\n<settings>\n<opaque>[MASKED]</opaque>\n<version>1.2.3</version>\n</settings>'],
  ['cat /fixture/settings.xml\n<settings>\n<opaque>\n42: ' + V + '\n43: ' + V + '\n44:</opaque>\n</settings>',
    'cat /fixture/settings.xml\n<settings>\n<opaque>\n42: [MASKED]\n43: [MASKED]\n44:</opaque>\n</settings>'],
  ['File: /fixture/.env\nopaque=' + V + '\nFile: /fixture/readme.txt\nopaque=ordinary-display-name',
    'File: /fixture/.env\nopaque=[MASKED]\nFile: /fixture/readme.txt\nopaque=ordinary-display-name'],
  ['cat /fixture/.env\nopaque=' + V + '\n$ echo finished\nopaque=ordinary-display-name',
    'cat /fixture/.env\nopaque=[MASKED]\n$ echo finished\nopaque=ordinary-display-name'],
  ['diff --git a/.env b/.env\n--- a/.env\n+++ b/.env\n-opaque=' + V + '\n+opaque=' + V +
    '\ndiff --git a/readme.txt b/readme.txt\n--- a/readme.txt\n+++ b/readme.txt\n+opaque=ordinary-display-name',
    'diff --git a/.env b/.env\n--- a/.env\n+++ b/.env\n-opaque=[MASKED]\n+opaque=[MASKED]' +
    '\ndiff --git a/readme.txt b/readme.txt\n--- a/readme.txt\n+++ b/readme.txt\n+opaque=ordinary-display-name'],
);

for (const [index, [input, expected]] of cases.entries()) {
  const result = maskLogText(input), findings = scanLogFindings(input);
  assert.ok(result.text === expected, 'properties exact replacement case ' + index);
  assert.ok(!result.text.includes(V), 'properties value removed case ' + index);
  assert.ok(findings.length > 0 && findings.length === result.masked, 'properties scanner parity case ' + index);
  assert.ok(findings.every(hit => !JSON.stringify(hit).includes(V)), 'metadata only case ' + index);
  assert.ok(result.text.split('\n').length === input.split('\n').length, 'properties line count case ' + index);
  const again = maskLogText(result.text);
  assert.ok(again.text === result.text && again.masked === 0, 'properties idempotence case ' + index);
  for (const wrap of [text => JSON.stringify({ output: text }),
    text => JSON.stringify({ output: JSON.stringify({ output: text }) })]) {
    const nested = maskLogText(wrap(input));
    assert.ok(nested.text === wrap(expected), 'JSON properties replacement case ' + index);
    assert.ok(maskLogText(nested.text).masked === 0, 'JSON properties idempotence case ' + index);
  }
}

const negatives = [
  'org.gradle.jvmargs=-Xmx4g', 'android.useAndroidX=true', 'kotlin.code.style=official',
  'sdk.dir=/fixture/sdk', 'ndk.dir=../fixture/ndk', 'version=1.2.3', 'workers=4', 'enabled=false',
  'PASSWORD=1.2.3', 'TOKEN=true', 'SECRET=17', 'PRIVATE_KEY=/fixture/public.pem',
  'private_key="../fixture/public.pem"', 'cookie="~/fixture/public.txt"',
  'PASSWORD=https://example.invalid/public', 'KEY=', 'PASSWORD=""', "PASSWORD=''",
  'client_secret=${FIXTURE_VALUE}', 'api_key=@string/public_setting', 'MAVEN_PASSWORD=@string/public_setting',
  'PASSWORD=[MASKED]', 'password=<redacted>', 'password=REDACTED',
  ...['keyboard', 'monkey', 'tokenizer', 'author', 'client_tokenizer', 'clientAuthor', 'publicKeyboard']
    .map(key => key + '=ordinary-display-name'),
  'keyAlias="fixture"', 'username=ordinary-display-name',
  'clientSecret = getFixtureValue()', 'clientSecret = otherVariable;',
  'clientSecret = "prefix" + otherVariable;',
  'We discussed gradle.properties today\nopaque=ordinary-display-name',
  'cat /fixture/readme.txt\nopaque=ordinary-display-name',
  'File: /fixture/readme.txt\nopaque=ordinary-display-name',
  'cat /fixture/.env\n# comment\n\norg.gradle.jvmargs=-Xmx4g\nandroid.namespace=com.example.fixture\n' +
    'kotlin.code.style=official\nsdk.dir=/fixture/sdk\nndk.dir=../fixture/ndk\nversion=1.2.3\n' +
    'workers=4\nenabled=true\nwebsite=https://example.invalid/public\nref=${FIXTURE_VALUE}',
  'cat /fixture/.env\nBUILD FINISHED\nopaque=ordinary-display-name',
  'cat /fixture/.env\nFile: /fixture/readme.txt\nopaque=ordinary-display-name',
  'cat /fixture/.env\n$ echo finished\nopaque=ordinary-display-name',
  'mux_client_request_session: session request failed',
  'mux_client_request_session: send fds failed',
  '<meta-data android:name="tokenizer" android:value="ordinary-display-name"/>',
  '<string name="keyboard">ordinary-display-name</string>',
];
for (const [index, input] of negatives.entries()) {
  const result = maskLogText(input);
  assert.ok(result.text === input && result.masked === 0, 'properties public value case ' + index);
  assert.ok(scanLogFindings(input).length === 0, 'properties public scanner case ' + index);
  const wrapped = JSON.stringify({ output: input });
  assert.ok(maskLogText(wrapped).text === wrapped, 'JSON public properties case ' + index);
}
assert.ok(scanLogFindings('cat /fixture/.env\n42:opaque=' + V)[0].line === 2, 'physical value line');
const callbackInputs = Array(10).fill(JSON.stringify({ output: 'SESSION=' + V }));
assert.ok(callbackInputs.map(passwordStyleFindings).every(hits => hits.length === 1),
  'array callback indexes do not change JSON recursion depth');

const root = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'properties-log-redaction-'));
try {
  // Separate fixture blocks so their context cannot affect the next test input.
  const input = cases.map(([text]) => text + '\nEND FIXTURE').join('\n');
  const expected = cases.map(([, text]) => text + '\nEND FIXTURE').join('\n');
  const log = path.join(tmp, 'properties.log'); fs.writeFileSync(log, input);
  const cli = spawnSync(process.execPath, [path.join(root, 'scripts/mask-logs.mjs'), '--force', log], { encoding: 'utf8' });
  assert.ok(cli.status === 0 && !(cli.stdout + cli.stderr).includes(V), 'properties CLI no value output');
  assert.ok(fs.readFileSync(log, 'utf8') === expected, 'properties CLI exact replacement');
  assert.ok(redactLogFile(log, { force: true }).masked === 0, 'properties worker log idempotence');
  const row = { type: 'response_item', payload: { content: [{ text: input }], encrypted_content: 'OPAQUE_' + V } };
  const jsonl = JSON.stringify(row) + '\n', worker = path.join(tmp, 'worker.jsonl');
  fs.writeFileSync(worker, jsonl);
  const result = redactLogFile(worker, { force: true }), masked = JSON.parse(fs.readFileSync(worker, 'utf8'));
  assert.ok(masked.payload.content[0].text === expected, 'properties worker JSONL replacement');
  assert.ok(masked.payload.encrypted_content === row.payload.encrypted_content, 'opaque content preserved');
  assert.ok(scanLogFindings(jsonl, { jsonl: true }).length === result.masked, 'worker JSONL scanner parity');
  const rollout = path.join(tmp, 'rollout.jsonl'); fs.writeFileSync(rollout, jsonl);
  redactRolloutFile(rollout);
  assert.ok(fs.readFileSync(rollout, 'utf8') === jsonl, 'durable rollout unchanged');
  const snapshot = JSON.parse(fs.readFileSync(rolloutReadPath(rollout), 'utf8').split('\n')[1]);
  assert.ok(snapshot.payload.content[0].text === expected, 'properties rollout snapshot replacement');
  assert.ok(snapshot.payload.encrypted_content === row.payload.encrypted_content, 'rollout opaque content preserved');
  const giant = 'cat /fixture/.env\nopaque="' + 'FAKE_LONG_'.repeat(20000) + '"';
  const giantResult = maskLogText(giant);
  assert.ok(giantResult.masked === 1 && giantResult.text === 'cat /fixture/.env\nopaque="[MASKED]"',
    'giant properties values do not overflow');
  console.log('PASS properties masking: ' + cases.length + ' positive and ' + negatives.length +
    ' negative fixtures, JSON, CLI, worker logs and rollout snapshots');
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
