#!/usr/bin/env node
import { workerInstructions } from './lib/global-rules.mjs';
const instructions = workerInstructions();
console.log(process.argv.includes('--config') ? `developer_instructions=${JSON.stringify(instructions)}` : instructions);
