import { spawn } from 'node:child_process';
const child = spawn(process.execPath, ['-e', '/* worker-background fixture */ setInterval(() => { if (process.ppid === 1) process.exit(0); }, 200)'], { stdio: 'ignore' });
console.log(`ready ${child.pid}`);
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { child.kill(signal); });
process.on('exit', () => child.kill('SIGTERM'));
