// stdin only: never pass raw note text in the Node command line.
import fs from 'node:fs';

// The installer archives a runnable rollback copy with its own shared masker.
const archived = new URL('./lib/nightly-audit.mjs', import.meta.url);
const { maskLogText } = await import(fs.existsSync(archived) ? archived : new URL('../lib/nightly-audit.mjs', import.meta.url));
process.stdout.write(maskLogText(fs.readFileSync(0, 'utf8')).text);
