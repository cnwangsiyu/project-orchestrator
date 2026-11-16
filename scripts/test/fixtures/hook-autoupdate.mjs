// Keep unrelated hook delivery fixtures free of detached Git work.
import cp from 'node:child_process';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
const spawn = cp.spawn;
cp.spawn = (bin, args, options) => {
  if (!String(args?.[0]).endsWith('/skill-autoupdate.mjs') || args[1] !== '--run') return spawn(bin, args, options);
  const child = new EventEmitter(); child.unref = () => {};
  setImmediate(() => child.emit('exit', 0)); return child;
};
syncBuiltinESMExports();
