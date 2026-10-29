import { HandController } from '../../engine/HandController.js';
import type { GameState, HandConfig } from '../../types.js';
import { supabase } from './client.js';
import {
  decodePrivateHandContinuation,
  encodePrivateHandContinuation,
  type ContinuationSeat,
  type PrivateHandContinuation,
} from '../../engine/PrivateHandContinuation.js';
import type { HandContinuationBatch } from '../../engine/HandContinuationLane.js';
import type { F06HandIdentity } from '../F06HandPermit.js';

type Transport = (
  name: string,
  args: Record<string, unknown>
) => PromiseLike<{ data: unknown; error: unknown }>;
const rpc: Transport = (name, args) =>
  supabase.rpc(name, args).abortSignal(AbortSignal.timeout(8000));

/** One original write. Unknown acknowledgement retains this same sequence. */
export async function retainHandContinuation(
  original: Readonly<F06HandIdentity>,
  writerGeneration: string,
  seats: readonly ContinuationSeat[],
  batch: HandContinuationBatch,
  current: () => boolean,
  transport: Transport = rpc
): Promise<void> {
  if (!current()) throw new Error('Hand Continuation Owner Changed');
  const encoded = encodePrivateHandContinuation({ version: 1, original, seats, batch });
  const result = await transport('fn_f06_retain_hand_continuation', {
    p_tournament_id: original.tournament_id,
    p_lease_generation: writerGeneration,
    p_table_id: original.table_id,
    p_hand_number: original.hand_number,
    p_sequence: String(batch.sequence),
    p_payload: encoded.payload,
    p_sha256: encoded.sha256,
  });
  const row = result.data as Record<string, unknown> | null;
  if (
    !current() ||
    result.error ||
    !row ||
    row.ok !== true ||
    row.table_id !== original.table_id ||
    row.hand_number !== original.hand_number ||
    row.sequence !== String(batch.sequence) ||
    row.sha256 !== encoded.sha256 ||
    row.writer_generation !== writerGeneration
  )
    throw new Error('Hand Continuation Write Is Unproven');
}

export async function claimHandContinuation(
  tournamentId: string,
  writerGeneration: string,
  tableId: string,
  current: () => boolean,
  transport: Transport = rpc
): Promise<PrivateHandContinuation | null> {
  if (!current()) throw new Error('Hand Continuation Owner Changed');
  const result = await transport('fn_f06_claim_hand_continuation', {
    p_tournament_id: tournamentId,
    p_lease_generation: writerGeneration,
    p_table_id: tableId,
  });
  const row = result.data as Record<string, unknown> | null;
  if (
    !current() ||
    result.error ||
    !row ||
    row.ok !== true ||
    row.table_id !== tableId ||
    !Object.prototype.hasOwnProperty.call(row, 'continuation')
  )
    throw new Error('Hand Continuation Claim Is Unproven');
  if (row.continuation === null) return null;
  const claim = row.continuation as Record<string, unknown>;
  if (
    !claim ||
    row.writer_generation !== writerGeneration ||
    typeof claim.payload !== 'string' ||
    typeof claim.sha256 !== 'string'
  )
    throw new Error('Hand Continuation Claim Is Unproven');
  const value = decodePrivateHandContinuation(claim.payload, claim.sha256);
  if (
    value.original.table_id !== tableId ||
    value.original.tournament_id !== tournamentId ||
    value.original.hand_number !== claim.hand_number ||
    String(value.batch.sequence) !== claim.sequence
  )
    throw new Error('Hand Continuation Claim Identity Changed');
  return value;
}

/** Only a complete, untouched river can use a legacy snapshot without a deck. */
export async function claimLegacyRiverContinuation(
  tournamentId: string,
  writerGeneration: string,
  tableId: string,
  current: () => boolean
): Promise<PrivateHandContinuation | null> {
  const state = await supabase.rpc('fn_f06_hand_number_state', {
    p_tournament_id: tournamentId,
    p_lease_generation: writerGeneration,
    p_table_id: tableId,
  });
  if (!current() || state.error || !state.data?.ok)
    throw new Error('Legacy Hand Authority Is Unproven');
  const permit = state.data.unresolved_permit;
  if (!permit || permit.state !== 'reserved' || permit.generation === writerGeneration) return null;
  const snap = await supabase
    .from('hand_state_snapshots')
    .select('table_id,hand_number,state_json,config_json,created_at,updated_at,stage')
    .eq('table_id', tableId)
    .eq('hand_number', permit.hand_number)
    .eq('is_complete', false)
    .maybeSingle();
  if (!current() || snap.error) throw new Error('Legacy Hand Snapshot Is Unproven');
  if (!snap.data || snap.data.stage !== 'river') return null;
  const saved = snap.data.state_json as unknown as Omit<GameState, 'deck'>;
  const config = {
    ...(snap.data.config_json as unknown as HandConfig),
    isTournament: true as const,
  };
  const first = saved.actionHistory[0] as unknown as { publicNode?: { seats?: number[][] } };
  const sb = first?.publicNode?.seats?.filter((s) => s[2] === config.smallBlind);
  const bb = first?.publicNode?.seats?.filter((s) => s[2] === config.bigBlind);
  if (sb?.length !== 1 || bb?.length !== 1) throw new Error('Legacy Original Blinds Are Unproven');
  const controller = HandController.fromLegacyUnactedRiver(config, saved, {
    smallBlind: sb[0][0],
    bigBlind: bb[0][0],
  });
  const roster = await supabase
    .from('table_seats')
    .select('id,user_id,joined_at,stack,seat_number')
    .eq('table_id', tableId)
    .is('left_at', null);
  if (!current() || roster.error || !roster.data)
    throw new Error('Legacy Original Seats Are Unproven');
  const seats = saved.players.map((p) => {
    const seat = roster.data.find((s) => s.user_id === p.user_id && s.seat_number === p.seat);
    const before = p.stack + p.totalInvested;
    if (
      !seat ||
      Number(seat.stack) !== before ||
      Date.parse(seat.joined_at) > Date.parse(snap.data!.created_at)
    )
      throw new Error('Legacy Original Seat Changed');
    return {
      user_id: p.user_id,
      seat_id: seat.id,
      seat_joined_at: seat.joined_at,
      stack_before: before,
    };
  });
  const cards = (cs: Array<{ rank: string; suit: string }>) => cs.map((c) => c.rank + c.suit);
  const fields = {
    currentHandStartedAt: Date.parse(snap.data.created_at),
    currentHandDealerSeat: saved.dealerSeat,
    currentHandVariant: config.gameVariant,
    currentHandWentToFlop: saved.sawFlop,
    currentHandSawFlopForMoney: saved.sawFlop,
    currentHandPotSize: saved.pot,
    currentHandCommunityCards: cards(saved.communityCards),
    currentHandCommunityCards2: [],
    currentHandCommunityCards3: [],
    currentHandActions: structuredClone(saved.actionHistory),
    currentHandContributions: new Map(
      saved.players.filter((p) => p.totalInvested > 0).map((p) => [p.user_id, p.totalInvested])
    ),
    currentHandDealtStacks: new Map(seats.map((s) => [s.user_id, s.stack_before])),
    currentHandSeatGenerations: new Map(
      seats.map((s) => [s.user_id, { seat_id: s.seat_id, seat_joined_at: s.seat_joined_at }])
    ),
    currentHandHoleCards: new Map(
      saved.players.map((p) => [p.user_id, { seat: p.seat, cards: structuredClone(p.cards) }])
    ),
  };
  const original = {
    tournament_id: tournamentId,
    table_id: tableId,
    lease_generation: permit.generation,
    permit_id: permit.permit_id,
    lifecycle: String(permit.lifecycle),
    hand_number: String(permit.hand_number),
    custody_id: permit.custody_id,
  };
  const value: PrivateHandContinuation = {
    version: 1,
    original,
    seats,
    batch: {
      version: 1,
      sequence: 0,
      controller: controller.serializeRecoveryState(),
      events: [],
      engine: { fields },
    },
  };
  const encoded = encodePrivateHandContinuation(value);
  const claimed = await supabase.rpc('fn_f06_claim_legacy_river_continuation', {
    p_tournament_id: tournamentId,
    p_lease_generation: writerGeneration,
    p_table_id: tableId,
    p_hand_number: original.hand_number,
    p_snapshot_updated_at: snap.data.updated_at,
    p_payload: encoded.payload,
    p_sha256: encoded.sha256,
  });
  if (
    !current() ||
    claimed.error ||
    claimed.data?.ok !== true ||
    claimed.data?.sha256 !== encoded.sha256
  )
    throw new Error('Legacy Original Claim Is Unproven');
  return claimHandContinuation(tournamentId, writerGeneration, tableId, current);
}
