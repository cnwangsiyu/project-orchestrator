#!/usr/bin/env node
import { loadDigest } from './lib/global-rules.mjs';
const digest = loadDigest();
console.log(`Global worker rules ${digest.version}\n${digest.worker}`);
