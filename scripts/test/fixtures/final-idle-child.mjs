import fs from 'node:fs';
import path from 'node:path';

const [dir] = process.argv.slice(2);
fs.writeFileSync(path.join(dir, 'codex-last.md'), 'DONE fixture final report\n');
fs.writeFileSync(path.join(dir, 'ready.json'), '{}');
setInterval(() => {}, 1000);
