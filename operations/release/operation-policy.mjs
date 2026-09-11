import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

// The canonical bytes are owned by server/src/maintenance/operationPolicy.json.
// This installed copy is distribution only; no independent timing policy.
export const operationPolicyDigest = '1fed78c7afc00a220839dd198f2a362befe0fbe9655b2574d9d037d2864b2bda';
const bytes = await readFile(new URL('./operationPolicy.json', import.meta.url));
if (createHash('sha256').update(bytes).digest('hex') !== operationPolicyDigest)
  throw new Error('RELEASE_OPERATION_POLICY_MISMATCH');
export const operationPolicy = Object.freeze(JSON.parse(bytes));
