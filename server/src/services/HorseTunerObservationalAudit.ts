import {
  recordHorseTunerUpdate,
  type HorseTunerWriteRequest,
  type HorseTunerWriteResult,
} from './HorseTunerAtomicWrite.js';

/** Frequency and review diagnostics are observations, not causal permission.
 * Keep the proposed dials in the audit while preserving the exact raw profile.
 * A future causal activation must use its separately qualified control path. */
export async function recordObservationalHorseStudy(
  input: Omit<HorseTunerWriteRequest, 'intent'>
): Promise<HorseTunerWriteResult> {
  let request: HorseTunerWriteRequest;
  try {
    const bytes = JSON.stringify(input);
    if (Buffer.byteLength(bytes) > 65536)
      return Object.freeze({ status: 'unavailable', reason: 'request_budget_exceeded' });
    // Bind every diagnostic and profile value before the first await, including
    // when the caller reuses nested objects during the nightly study.
    const r = JSON.parse(bytes) as HorseTunerWriteRequest;
    request = {
      horseId: r.horseId,
      runDate: r.runDate,
      intent: 'observational_only',
      expectedProfile: r.expectedProfile,
      nextProfile: r.expectedProfile,
      audit: {
        ...r.audit,
        modsAfter: { ...r.audit.modsBefore },
        stats: {
          ...r.audit.stats,
          observational_audit_version: 1,
          causal_permission: 0,
          proposed_profile_change:
            JSON.stringify(r.expectedProfile) === JSON.stringify(r.nextProfile) ? 0 : 1,
          proposed_tightness: r.audit.modsAfter.tightness,
          proposed_aggression: r.audit.modsAfter.aggression,
          proposed_bluff_frequency: r.audit.modsAfter.bluffFreq,
        },
        reasons: [
          'observational_only_v1: no causal, holdout or shadow activation receipt',
          ...r.audit.reasons.map((reason) => 'diagnostic proposal, not applied: ' + reason),
        ],
      },
    };
  } catch {
    return Object.freeze({ status: 'unavailable', reason: 'invalid_request' });
  }
  const result = await recordHorseTunerUpdate(request);
  if (result.status === 'recorded' && result.changed) return Object.freeze({ status: 'unknown' });
  return result;
}
