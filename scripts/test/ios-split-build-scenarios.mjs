import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

execFileSync('python3', ['-B', fileURLToPath(new URL('./ios_split_build.py', import.meta.url))],
  { stdio: 'inherit' });
