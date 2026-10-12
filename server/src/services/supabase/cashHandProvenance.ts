import { supabase } from './client.js';
import type { HandSeatGeneration } from '../../engine/handSeatGeneration.js';

export interface CashManifestParticipant {
  user_id: string;
  seat_id: string;
  seat_joined_at: string;
  occupancy_id: string;
  stack_before: number;
  is_horse: boolean;
}

const CAPTURE_ATTEMPTS = 3;

/** Called once at the real pre-deal boundary. Missing evidence never invents ownership. */
export async function captureCashHandProvenance(
  tableId: string,
  handNumber: number,
  participants: readonly CashManifestParticipant[],
  instanceId: string,
  leaseGeneration: string
): Promise<string> {
  // Freeze before yielding; callers cannot turn a response-loss retry into a different roster.
  const roster = participants.map((participant) => ({ ...participant }));
  const request = {
    p_table_id: tableId,
    p_hand_number: handNumber,
    p_participants: roster,
    p_instance_id: instanceId,
    p_lease_generation: leaseGeneration,
  };
  // A lost response is not a lost manifest: the database may have committed
  // it. fn_cash_capture_hand_manifest returns the same manifest for the same
  // (table, hand, roster, lease), so the identical request is asked again
  // before the hand is dealt without its link (2026-09-22..27: 6 manifests
  // committed whose ids never reached the engine, their hands unlinked).
  let data: any = null;
  let error: { message: string } | null = null;
  for (let attempt = 0; attempt < CAPTURE_ATTEMPTS; attempt++) {
    try {
      ({ data, error } = await supabase.rpc('fn_cash_capture_hand_manifest', request));
    } catch (thrown) {
      data = null;
      error = { message: thrown instanceof Error ? thrown.message : String(thrown) };
    }
    if (!error) break;
  }
  if (error) throw new Error(`Cash provenance capture unavailable: ${error.message}`);
  if (
    data?.version !== 1 ||
    typeof data.manifest_id !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(data.manifest_id)
  ) {
    throw new Error('Cash provenance capture returned an invalid receipt');
  }
  return data.manifest_id;
}

export function bindCashHandManifest(
  generations: ReadonlyMap<string, HandSeatGeneration>,
  manifestId: string,
  participants: readonly CashManifestParticipant[]
): Map<string, HandSeatGeneration> {
  if (
    generations.size !== participants.length ||
    new Set(participants.map((p) => p.user_id)).size !== participants.length
  ) {
    throw new Error('Cash provenance participant set mismatch');
  }
  return new Map(
    participants.map((participant) => {
      const generation = generations.get(participant.user_id);
      if (
        !generation ||
        generation.seat_id !== participant.seat_id ||
        generation.seat_joined_at !== participant.seat_joined_at
      ) {
        throw new Error('Cash provenance seat generation mismatch');
      }
      return [
        participant.user_id,
        Object.freeze({
          ...generation,
          occupancy_id: participant.occupancy_id,
          funding_manifest_id: manifestId,
          funding_stack_before: participant.stack_before,
        }),
      ];
    })
  );
}
