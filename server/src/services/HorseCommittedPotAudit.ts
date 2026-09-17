import { supabase } from './supabase.js';
import {
  emptyCommittedPotAudit as empty,
  parseCommittedPotAuditReceipt,
  type CommittedPotAuditReceipt,
} from './horseAdaptiveJournal/commitmentReceipt.js';

/** Called only by the isolated adaptive-journal loop, never by settlement or
 * the decision worker. Database cursor/review writes commit atomically; retry
 * after response loss continues from that cursor without duplicating rows. */
export async function processHorseCommittedPotAudit(): Promise<CommittedPotAuditReceipt> {
  const mode = process.env.HORSE_COMMITMENT_AUDIT ?? 'on';
  if (mode === 'off') return empty('disabled');
  if (mode !== 'on') return empty('unknown');
  try {
    const { data, error } = await supabase
      .rpc('fn_horse_commitment_audit_step', {})
      .abortSignal(AbortSignal.timeout(5000));
    return error ? empty('unknown') : parseCommittedPotAuditReceipt(data);
  } catch {
    return empty('unknown');
  }
}
