import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export function sharedHostSamples(root, platform, hosts) {
  if (!fs.existsSync(path.join(root, 'host-samples/latest.json'))) return {};
  const reader = fileURLToPath(new URL('../res/host_samples.py', import.meta.url));
  const result = spawnSync('python3', ['-B', reader, root, platform, ...hosts], { encoding: 'utf8', timeout: 3000 });
  return result.status === 0 ? JSON.parse(result.stdout) : {};
}
