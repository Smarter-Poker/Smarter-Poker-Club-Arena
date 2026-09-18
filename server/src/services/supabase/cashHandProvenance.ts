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
  const { data, error } = await supabase.rpc('fn_cash_capture_hand_manifest', {
    p_table_id: tableId,
    p_hand_number: handNumber,
    p_participants: roster,
    p_instance_id: instanceId,
    p_lease_generation: leaseGeneration,
  });
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
