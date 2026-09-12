import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The canonical bytes are owned by server/src/maintenance/operationPolicy.json.
// This installed copy is distribution only; no independent timing policy.
export const operationPolicyDigest =
  '1fed78c7afc00a220839dd198f2a362befe0fbe9655b2574d9d037d2864b2bda';
// This is an installed server file, not a browser asset for Vite to inline.
const bytes = await readFile(join(dirname(fileURLToPath(import.meta.url)), 'operationPolicy.json'));
if (createHash('sha256').update(bytes).digest('hex') !== operationPolicyDigest)
  throw new Error('RELEASE_OPERATION_POLICY_MISMATCH');
export const operationPolicy = Object.freeze(JSON.parse(bytes));
