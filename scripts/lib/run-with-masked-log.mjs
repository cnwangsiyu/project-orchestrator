#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { redactLogFile } from './log-redaction.mjs';
import { unsafeFile } from './resource-data.mjs';

const script = fileURLToPath(import.meta.url);
const signals = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143, SIGKILL: 137, SIGQUIT: 131 };

function writeAll(fd, chunk) {
  for (let offset = 0; offset < chunk.length;) offset += fs.writeSync(fd, chunk, offset, chunk.length - offset);
}

export async function runWithMaskedLog(logFile, command, args) {
  if (!path.isAbsolute(logFile) || !/\.(?:log|txt|out)$/i.test(logFile) || unsafeFile(logFile))
    throw Error('log path must be an absolute, non-credential .log/.txt/.out path');
  const parent = fs.realpathSync(path.dirname(logFile));
  if (unsafeFile(parent) || path.dirname(fs.realpathSync(parent)) === parent) throw Error('unsafe log directory');
  const fd = fs.openSync(logFile, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  let writeError;
  const child = spawn(command, args, { stdio: ['inherit', 'pipe', 'pipe'] });
  const copy = (chunk, output) => {
    if (!writeError) try { writeAll(fd, chunk); } catch (error) { writeError = error; }
    output.write(chunk);
  };
  child.stdout.on('data', chunk => copy(chunk, process.stdout));
  child.stderr.on('data', chunk => copy(chunk, process.stderr));
  const result = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  fs.closeSync(fd);
  if (writeError) console.error(`heavy-build: log capture failed (${writeError.code || 'write error'}); redaction may be incomplete`);
  try {
    const redacted = redactLogFile(logFile, { force: true });
    console.error(`heavy-build: log-redaction files=1 masked=${redacted.masked}`);
  } catch (error) {
    console.error(`heavy-build: log redaction failed (${error.message})`);
  }
  return result.code ?? signals[result.signal] ?? 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === script) {
  const separator = process.argv.indexOf('--', 2);
  if (separator !== 3 || process.argv.length < 5) {
    console.error('usage: run-with-masked-log.mjs /absolute/build.log -- command [args...]');
    process.exitCode = 2;
  } else {
    runWithMaskedLog(process.argv[2], process.argv[4], process.argv.slice(5))
      .then(code => { process.exitCode = code; })
      .catch(error => { console.error(`heavy-build: ${error.message}`); process.exitCode = 2; });
  }
}
