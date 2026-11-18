import fs from 'node:fs';
import path from 'node:path';

const [dir] = process.argv.slice(2), parent = process.ppid;
fs.writeFileSync(path.join(dir, 'ready.json'), JSON.stringify({ pid: process.pid }));
const timer = setInterval(() => {
  // A killed wrapper cannot clean up its process group. Keep this fixture bounded.
  if (process.ppid !== parent) process.exit(0);
  const control = path.join(dir, 'exit-code');
  if (!fs.existsSync(control)) return;
  const code = Number(fs.readFileSync(control, 'utf8'));
  fs.writeFileSync(path.join(dir, 'codex-last.md'), code ? 'Synthetic failure.\n' : 'Synthetic success.\n');
  clearInterval(timer);
  process.exit(code);
}, 20);
setTimeout(() => process.exit(1), 60000).unref();
