import { UUID_SHAPE } from '../lib/uuidShape.js';

/** A movement owner is never a hand/dealer owner. SQL retains the full proof. */
export interface F06MovementAdmission {
  admission_id: string;
  tournament_id: string;
  lease_generation: string;
  table_id: string;
  lifecycle: string;
  break_id: string;
  custody_id: string;
  revision: string;
  proof_hash: string;
}

export function verifyF06MovementAdmission(
  value: unknown,
  expected: Omit<F06MovementAdmission, 'revision' | 'proof_hash'>
): F06MovementAdmission {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('f06_movement_admission_unproven');
  const row = value as Record<string, unknown>;
  if (row.ok !== true || row.mode !== 'movement_only')
    throw new Error('f06_movement_admission_unproven');
  for (const [key, id] of Object.entries(expected)) {
    if (row[key] !== id || (key !== 'lifecycle' && !UUID_SHAPE.test(id)))
      throw new Error('f06_movement_admission_identity_changed');
  }
  if (
    !/^[1-9][0-9]{0,18}$/.test(expected.lifecycle) ||
    typeof row.revision !== 'string' ||
    !/^[1-9][0-9]{0,18}$/.test(row.revision) ||
    BigInt(row.revision) > 9223372036854775807n ||
    typeof row.proof_hash !== 'string' ||
    !/^[0-9a-f]{64}$/.test(row.proof_hash)
  )
    throw new Error('f06_movement_admission_proof_invalid');
  return Object.freeze({ ...expected, revision: row.revision, proof_hash: row.proof_hash });
}
