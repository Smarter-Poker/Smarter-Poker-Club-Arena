import { createHash } from 'node:crypto';
import { supabase } from './supabase.js';

export type HorseTunerWriteRequest = Readonly<{
  horseId: string;
  runDate: string;
  /** Explicit audit-only requests may never change the stored profile. */
  intent?: 'observational_only';
  expectedProfile: unknown;
  nextProfile: unknown;
  audit: Readonly<{
    hands: number;
    stats: Record<string, number>;
    modsBefore: Record<string, number>;
    modsAfter: Record<string, number>;
    reasons: readonly string[];
  }>;
}>;
export type HorseTunerWriteResult =
  | Readonly<{ status: 'recorded'; changed: boolean; replayed: boolean }>
  | Readonly<{ status: 'unknown' }>
  | Readonly<{ status: 'unavailable'; reason: string }>;

/** Serialize before the await: both CAS and audit describe that exact study.
 * Never fall back to separate writes or infer rollback from a lost reply. */
export async function recordHorseTunerUpdate(
  request: HorseTunerWriteRequest
): Promise<HorseTunerWriteResult> {
  const unknown = (): HorseTunerWriteResult => Object.freeze({ status: 'unknown' });
  let payload: string;
  try {
    payload = JSON.stringify({ version: 1, ...request });
    if (Buffer.byteLength(payload, 'utf8') > 65536)
      return Object.freeze({ status: 'unavailable', reason: 'request_budget_exceeded' });
  } catch {
    return Object.freeze({ status: 'unavailable', reason: 'invalid_request' });
  }
  const captured = JSON.parse(payload) as HorseTunerWriteRequest;
  const requestHash = createHash('sha256').update(payload).digest('hex');
  try {
    const { data, error } = await supabase
      .rpc('fn_record_horse_tuner_update', { p_payload: payload })
      .abortSignal(AbortSignal.timeout(5000));
    if (error) return unknown();
    if (data?.version === 1 && data.status === 'unavailable') {
      const reasons = new Set([
        'invalid_request',
        'invalid_modifiers',
        'causal_permission_missing',
        'authored_profile_change',
        'writer_busy',
        'run_conflict',
        'horse_unavailable',
        'profile_changed',
        'legacy_run_unavailable',
      ]);
      return Object.freeze({
        status: 'unavailable',
        reason: reasons.has(data.reason) ? data.reason : 'invalid_receipt',
      });
    }
    if (
      data?.version !== 1 ||
      data.status !== 'recorded' ||
      data.requestHash !== requestHash ||
      data.horseId !== captured.horseId ||
      data.runDate !== captured.runDate ||
      typeof data.changed !== 'boolean' ||
      typeof data.replayed !== 'boolean'
    )
      return unknown();
    return Object.freeze({ status: 'recorded', changed: data.changed, replayed: data.replayed });
  } catch {
    return unknown();
  }
}
