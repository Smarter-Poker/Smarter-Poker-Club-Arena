import { attributeKnockout, type KnockoutAttribution } from './knockoutAttribution.js';

/** Covered by uq_hand_history_global_hand_number and therefore unambiguous. */
export const GLOBAL_HAND_NUMBER_FLOOR = 1_000_000;

/**
 * The durable result written by fn_ca_settle_hand_stacks_absolute.
 *
 * `written` is the database-accepted post-hand stack for every player in that
 * hand. It is the only durable record available before hand_history lands, so
 * it is also the only safe way to distinguish the current zero-stack hand from
 * an older hand in which the same player busted before taking a rebuy.
 */
export interface StackSettlementResult {
  success?: unknown;
  table_id?: unknown;
  hand_number?: unknown;
  written?: unknown;
}

export interface KnockoutHistoryRow {
  id?: unknown;
  table_id?: unknown;
  hand_number?: unknown;
  players?: unknown;
  winners?: unknown;
  pots?: unknown;
}

export type PersistedKnockoutEvidence = {
  ready: true;
  tableId: string;
  handId: string;
  handNumber: number;
  /** Added by the durable ledger loader; absent only in pure attribution tests. */
  settledAt?: string;
  attribution: KnockoutAttribution;
};

export type PersistedKnockoutDeferred = {
  ready: false;
  reason:
    | 'settlement_not_accepted'
    | 'settlement_not_zero'
    | 'settlement_identity_missing'
    | 'history_not_ready'
    | 'history_identity_mismatch'
    | 'player_not_in_hand'
    | 'knocker_not_attributable';
};

export type PersistedKnockoutGate = PersistedKnockoutEvidence | PersistedKnockoutDeferred;

export interface BountyRecoveryPlayerRow {
  user_id: string;
  current_bounty?: unknown;
}

export interface BountyRecoveryCollectionRow {
  eliminated_player_id: string;
}

export interface BountyRecoveryAwardRow {
  id: string;
  eliminated_user_id: string;
  status: string;
  table_id?: string | null;
}

export interface BountyRecoveryPlan {
  /** Eliminations for which no durable payout/reservation marker exists. */
  missing: string[];
  /** Durable mystery awards whose reveal/payment transaction is unfinished. */
  pendingAwards: BountyRecoveryAwardRow[];
}

/**
 * Classify durable bounty state without trusting an RPC response.
 *
 * A transport error can mean either "the transaction failed" or "it committed
 * and the response was lost". `tournament_bounties` and completed mystery
 * awards are the commit markers, so a replay is requested only when those
 * records say work is still owed. The paying RPCs are idempotent, making the
 * same plan safe after a process restart or a concurrent sweep.
 */
export function planBountyRecovery(input: {
  eliminated: BountyRecoveryPlayerRow[];
  collections: BountyRecoveryCollectionRow[];
  awards: BountyRecoveryAwardRow[];
  mysteryActive: boolean;
}): BountyRecoveryPlan {
  const collected = new Set(input.collections.map((row) => String(row.eliminated_player_id)));
  const awardByPlayer = new Map<string, BountyRecoveryAwardRow>();
  for (const award of input.awards) {
    const userId = String(award.eliminated_user_id || '');
    if (userId && !awardByPlayer.has(userId)) awardByPlayer.set(userId, award);
  }

  const pendingAwards = input.mysteryActive
    ? input.awards.filter((award) => !['completed'].includes(String(award.status)))
    : [];
  const missing: string[] = [];
  for (const player of input.eliminated) {
    const userId = String(player.user_id || '');
    if (!userId || collected.has(userId)) continue;
    const award = awardByPlayer.get(userId);
    if (award?.status === 'completed') continue;
    if (input.mysteryActive && award) continue;
    missing.push(userId);
  }

  return { missing, pendingAwards };
}

function playerIdOf(player: unknown): string {
  if (!player || typeof player !== 'object') return '';
  const row = player as { userId?: unknown; user_id?: unknown };
  return String(row.userId ?? row.user_id ?? '').trim();
}

function playerStackOf(player: unknown): number | null {
  if (!player || typeof player !== 'object') return null;
  const value = Number((player as { stack?: unknown }).stack);
  return Number.isFinite(value) ? value : null;
}

/** The exact accepted zero-stack settlement identity, independent of memory. */
export function acceptedZeroStackSettlement(
  settlement: StackSettlementResult | null | undefined,
  eliminatedUserId: string
): { tableId: string; handNumber: number } | null {
  if (settlement?.success !== true) return null;

  const written =
    settlement.written && typeof settlement.written === 'object'
      ? (settlement.written as Record<string, unknown>)
      : null;
  if (!written || !Object.prototype.hasOwnProperty.call(written, eliminatedUserId)) return null;
  const acceptedStack = Number(written[eliminatedUserId]);
  if (!Number.isFinite(acceptedStack) || acceptedStack > 0) return null;

  const tableId = String(settlement.table_id ?? '').trim();
  const handNumber = Number(settlement.hand_number);
  if (!tableId || !Number.isSafeInteger(handNumber) || handNumber < GLOBAL_HAND_NUMBER_FLOOR) {
    return null;
  }
  return { tableId, handNumber };
}

/**
 * Admit an elimination only when the exact database-accepted zero-stack hand
 * has a queryable history row that still proves who was knocked out and who
 * won their final pot.
 *
 * This deliberately rejects "the latest hand containing the player". A player
 * may have busted, rebought, and busted again; while the second history insert
 * is pending, the first zero-stack row is a plausible but wrong match. The
 * settlement hand number makes that stale-row substitution impossible.
 */
export function persistedKnockoutEvidence(
  settlement: StackSettlementResult | null | undefined,
  hand: KnockoutHistoryRow | null | undefined,
  eliminatedUserId: string
): PersistedKnockoutGate {
  if (settlement?.success !== true) return { ready: false, reason: 'settlement_not_accepted' };
  const written =
    settlement.written && typeof settlement.written === 'object'
      ? (settlement.written as Record<string, unknown>)
      : null;
  if (!written || !Object.prototype.hasOwnProperty.call(written, eliminatedUserId)) {
    return { ready: false, reason: 'settlement_not_zero' };
  }
  const acceptedStack = Number(written[eliminatedUserId]);
  if (!Number.isFinite(acceptedStack) || acceptedStack > 0) {
    return { ready: false, reason: 'settlement_not_zero' };
  }
  const identity = acceptedZeroStackSettlement(settlement, eliminatedUserId);
  if (!identity) return { ready: false, reason: 'settlement_identity_missing' };
  const { tableId, handNumber } = identity;
  if (!hand) return { ready: false, reason: 'history_not_ready' };

  const handId = String(hand.id ?? '').trim();
  const historyTableId = String(hand.table_id ?? '').trim();
  const historyHandNumber = Number(hand.hand_number);
  if (!handId || historyTableId !== tableId || historyHandNumber !== handNumber) {
    return { ready: false, reason: 'history_identity_mismatch' };
  }

  const players = Array.isArray(hand.players) ? hand.players : [];
  const eliminated = players.find((player) => playerIdOf(player) === eliminatedUserId);
  // The history roster contains final stacks. Requiring the same zero here is
  // an independent guard against a corrupt/mis-associated settlement row.
  const historyStack = playerStackOf(eliminated);
  if (!eliminated || historyStack === null || historyStack > 0) {
    return { ready: false, reason: 'player_not_in_hand' };
  }

  // Global hand numbers identify rows written by the current engine. Those
  // rows must carry the pot ledger that proves which pot contained the busted
  // player's last chips. Falling back to the largest winner on a modern row
  // would turn missing/corrupt evidence into a payout to an unrelated side-pot
  // winner. The legacy heuristic remains available to historical callers of
  // attributeKnockout, but it is never an authorization boundary for money.
  if (!Array.isArray(hand.pots) || hand.pots.length === 0) {
    return { ready: false, reason: 'knocker_not_attributable' };
  }

  const attribution = attributeKnockout(hand, eliminatedUserId);
  if (
    !attribution.knockerUserId ||
    attribution.claimants.length === 0 ||
    attribution.basis !== 'pot'
  ) {
    return { ready: false, reason: 'knocker_not_attributable' };
  }

  return { ready: true, tableId, handId, handNumber, attribution };
}
