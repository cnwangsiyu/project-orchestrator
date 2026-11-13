#!/usr/bin/env node
import { attribute, readRegistry } from './lib/resource-data.mjs';
const registry = await readRegistry();
if (process.argv.includes('--attribute')) {
  let input = ''; for await (const chunk of process.stdin) input += chunk;
  const rows = JSON.parse(input);
  console.log(JSON.stringify({ owners: Object.fromEntries(attribute(rows, registry)), complete: registry.complete, errors: registry.errors }));
} else console.log(JSON.stringify(registry));
