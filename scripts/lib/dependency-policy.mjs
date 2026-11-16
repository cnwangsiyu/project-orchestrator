// Compatibility export; dependency policy comes from the worker digest.
import { loadDigest } from './global-rules.mjs';
export const DEPENDENCY_RULE = loadDigest().worker.split('\n').find(line => line.startsWith('- Project dependencies'));
