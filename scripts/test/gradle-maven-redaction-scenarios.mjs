#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { maskLogText, scanLogFindings } from '../lib/nightly-audit.mjs';
import { redactLogFile } from '../lib/log-redaction.mjs';
import { redactRolloutFile, rolloutReadPath } from '../lib/rollout-redaction.mjs';

const U = 'FAKE_BUILD_USER_723', V = 'FAKE_BUILD_VALUE_723';
const cases = [
  [`MAVEN INFO username=${U} password=${V}`, 'MAVEN INFO username=[MASKED] password=[MASKED]'],
  [`MAVEN INFO {username: '${U}', credentials: '${V}', token: '${V}'}`,
    "MAVEN INFO {username: '[MASKED]', credentials: '[MASKED]', token: '[MASKED]'}"],
  [`MAVEN INFO username ${U}; password ${V}`, 'MAVEN INFO username [MASKED]; password [MASKED]'],
  [`println("MAVEN INFO publishUsername=${U} publishPassword=${V}")`,
    'println("MAVEN INFO publishUsername=[MASKED] publishPassword=[MASKED]")'],
  [`[INFO] Downloading from https://${U}:${V}@example.invalid/repository/a.pom`,
    '[INFO] Downloading from https://[MASKED]@example.invalid/repository/a.pom'],
  [`maven { credentials { username '${U}'; password '${V}' } }`,
    "maven { credentials { username '[MASKED]'; password '[MASKED]' } }"],
  [`maven { credentials { username = "${U}"\npassword = "${V}"\n} }`,
    'maven { credentials { username = "[MASKED]"\npassword = "[MASKED]"\n} }'],
  [`maven { credentials(PasswordCredentials::class) { username = "${U}"; password = "${V}" } }`,
    'maven { credentials(PasswordCredentials::class) { username = "[MASKED]"; password = "[MASKED]" } }'],
  [`maven { credentials(PasswordCredentials) { username = '${U}'; password = '${V}' } }`,
    "maven { credentials(PasswordCredentials) { username = '[MASKED]'; password = '[MASKED]' } }"],
  [`ORG_GRADLE_PROJECT_releaseUsername=${U}\nORG_GRADLE_PROJECT_releasePassword=${V}`,
    'ORG_GRADLE_PROJECT_releaseUsername=[MASKED]\nORG_GRADLE_PROJECT_releasePassword=[MASKED]'],
  ...['Password', 'Token', 'Secret', 'Key'].map(suffix => [
    `ORG_GRADLE_PROJECT_release${suffix}=${V}`, `ORG_GRADLE_PROJECT_release${suffix}=[MASKED]`]),
  [`./gradlew publish -PreleaseUsername=${U} -PreleasePassword=${V}`,
    './gradlew publish -PreleaseUsername=[MASKED] -PreleasePassword=[MASKED]'],
  [`-PrepoPassword='${V}' -PsigningKey="${V}"`, "-PrepoPassword='[MASKED]' -PsigningKey=\"[MASKED]\""],
  [`systemProp.repo.password=${V}`, 'systemProp.repo.password=[MASKED]'],
  [`-DsystemProp.repo.username=${U} -DsystemProp.repo.password=${V}`,
    '-DsystemProp.repo.username=[MASKED] -DsystemProp.repo.password=[MASKED]'],
  ...['NEXUS', 'MAVEN', 'ARTIFACTORY'].map(prefix => [
    `"${prefix}_USER=${U} ${prefix}_MAGIC_WORD=${V} ${prefix}_PASSWORD=${V}"`,
    `"${prefix}_USER=[MASKED] ${prefix}_MAGIC_WORD=[MASKED] ${prefix}_PASSWORD=[MASKED]"`]),
  [`[DEBUG] Authorization: Basic ${V}`, '[DEBUG] Authorization: [MASKED]'],
  [`[DEBUG] X-Repository-Token: ${V}`, '[DEBUG] X-Repository-Token: [MASKED]'],
  [`X-Repository-Token: '${V}'`, 'X-Repository-Token: [MASKED]'],
  ['MAVEN INFO password=short', 'MAVEN INFO password=[MASKED]'],
  ['-PrepoPassword=short', '-PrepoPassword=[MASKED]'],
];

for (const [index, [input, expected]] of cases.entries()) {
  const result = maskLogText(input);
  // Report case numbers only: assertion diagnostics must not echo fixture values.
  assert.ok(result.text === expected, `exact build output replacement case ${index}`);
  assert.ok(result.masked > 0, `nonzero replacements case ${index}`);
  assert.ok(!result.text.includes(U) && !result.text.includes(V), `all values removed case ${index}`);
  assert.ok(result.text.split('\n').length === input.split('\n').length, `line count case ${index}`);
  const findings = scanLogFindings(input);
  assert.ok(findings.length === result.masked, `scanner matches redactor case ${index}`);
  assert.ok(findings.every(hit => typeof hit.field === 'string' && !Object.values(hit).includes(V)),
    `findings carry metadata only case ${index}`);
  const again = maskLogText(result.text);
  assert.ok(again.text === result.text && again.masked === 0, `idempotence case ${index}`);
}

const negatives = [
  'MAVEN INFO org.example:fixture:1.2.3',
  'MAVEN INFO url=https://example.invalid/repository/releases',
  'Downloading from ssh://git@example.invalid/repository/releases',
  '> Task :maven:publishToMavenLocal',
  '> Task :generateTokenSources UP-TO-DATE',
  'username = "ordinary-display-name"',
  'val username = "ordinary-display-name"',
  '-Pversion=1.2.3 -Pworkers=4',
  'systemProp.http.proxyHost=example.invalid',
  'Authorization: [MASKED]',
  'X-Repository-Token: [MASKED]',
  'MAVEN INFO password=${REPO_PASSWORD}',
  'https://${REPO_USER}:${REPO_PASSWORD}@example.invalid/repository',
  'maven { credentials(PasswordCredentials::class) { username = providers.gradleProperty("repoUser").get() } }',
  'maven { credentials { username = "[MASKED]" } }; username = "ordinary-display-name"',
  'val s = "credentials(PasswordCredentials::class) {"; username = "ordinary-display-name"',
  'NEXUS_MAGIC_WORD = "1.2.3"',
  'NEXUS_MAGIC_WORD = "prefix" + otherVariable;',
  'NEXUS_MAGIC_WORD = otherVariable;',
  'maven { credentials(PasswordCredentials::class) { username = "prefix" + otherVariable; } }',
];
for (const [index, input] of negatives.entries()) {
  const result = maskLogText(input);
  assert.ok(result.text === input && result.masked === 0, `ordinary build output preserved case ${index}`);
}

// Exercise the actual CLI/log path and immutable rollout snapshot path.
const root = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gradle-maven-redaction-'));
try {
  const input = cases.map(([input]) => input).join('\n') + '\n';
  const expected = cases.map(([, expected]) => expected).join('\n') + '\n';
  const log = path.join(tmp, 'build.log'); fs.writeFileSync(log, input);
  const cli = spawnSync(process.execPath, [path.join(root, 'scripts/mask-logs.mjs'), '--force', log], { encoding: 'utf8' });
  assert.ok(cli.status === 0 && !cli.stdout.includes(U) && !cli.stdout.includes(V), 'CLI success without value output');
  assert.ok(fs.readFileSync(log, 'utf8') === expected, 'CLI masks all build forms');
  assert.ok(redactLogFile(log, { force: true }).masked === 0, 'worker log shares idempotent detectors');
  const rollout = path.join(tmp, 'rollout.jsonl');
  const row = { type: 'response_item', payload: { content: [{ text: input }], encrypted_content: 'FAKE_OPAQUE_UNCHANGED' } };
  const jsonl = JSON.stringify(row) + '\n'; fs.writeFileSync(rollout, jsonl);
  redactRolloutFile(rollout);
  assert.ok(fs.readFileSync(rollout, 'utf8') === jsonl, 'provider rollout remains byte identical');
  const snapshot = fs.readFileSync(rolloutReadPath(rollout), 'utf8').split('\n');
  const maskedRow = JSON.parse(snapshot[1]);
  assert.ok(maskedRow.payload.content[0].text === expected, 'rollout snapshot masks all build forms');
  assert.ok(maskedRow.payload.encrypted_content === row.payload.encrypted_content, 'opaque content is preserved');
  const nested = maskLogText(JSON.stringify({ output: cases[3][0] }));
  assert.ok(JSON.parse(nested.text).output === cases[3][1], 'embedded JSON log strings share detectors');
  const giant = maskLogText(`MAVEN INFO username="${'FAKE_LONG_'.repeat(20000)}"`);
  assert.ok(giant.masked === 1 && giant.text === 'MAVEN INFO username="[MASKED]"', 'giant log values do not overflow');
  console.log(`PASS Gradle/Maven masking: ${cases.length} positive and ${negatives.length} negative forms, CLI and rollout snapshots`);
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
