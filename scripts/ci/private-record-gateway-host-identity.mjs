import { createHash } from 'node:crypto';
/** machine-id is a text identifier; one trailing newline must not change host identity. */
export function gatewayMachineIdSha256(raw) {
  const id = String(raw).trim();
  if (!/^[a-fA-F0-9]{32}$/.test(id)) throw new Error('invalid machine identity');
  return createHash('sha256').update(id.toLowerCase()).digest('hex');
}
