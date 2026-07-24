/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  HAND EVENT ADAPTER — hand_history row → NormalizedHand
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * FOUNDATION MODULE — pure functions. Bridges the persisted `hand_history` row
 * shape (server/src/services/supabase.ts logHandHistory) into the NormalizedHand
 * consumed by the integrity detectors.
 *
 * The persisted row's JSONB columns are loosely typed in the DB, so this adapter
 * is defensive: unknown/missing fields degrade gracefully rather than throw.
 * It also computes per-action decision latency (time since the previous action
 * in the hand) which the BotDetector relies on.
 */

import type {
  NormalizedAction,
  NormalizedActionType,
  NormalizedHand,
  NormalizedPlayer,
  NormalizedWinner,
  Street,
} from './types.js';

/** Loose shape of a persisted hand_history row (all JSONB fields optional). */
export interface HandHistoryRow {
  id?: string | null;
  table_id?: string | null;
  hand_number?: number | null;
  game_variant?: string | null;
  small_blind?: number | null;
  big_blind?: number | null;
  pot_size?: number | null;
  rake_amount?: number | null;
  community_cards?: unknown;
  started_at?: string | number | null;
  ended_at?: string | number | null;
  winners?: unknown;
  players?: unknown;
  actions?: unknown;
}

function toMs(v: string | number | null | undefined): number {
  if (v == null) return 0;
  if (typeof v === 'number') return v;
  const parsed = Date.parse(v);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function toNum(v: unknown, fallback = 0): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

function toStr(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : v == null ? fallback : String(v);
}

function toCards(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((c) => {
    if (typeof c === 'string') return c;
    if (c && typeof c === 'object') {
      const rank = (c as { rank?: unknown }).rank;
      const suit = (c as { suit?: unknown }).suit;
      if (rank != null && suit != null) return `${String(rank)}${String(suit)}`;
    }
    return String(c);
  });
}

const STREET_ALIASES: Record<string, Street> = {
  preflop: 'preflop',
  pre_flop: 'preflop',
  pre: 'preflop',
  flop: 'flop',
  turn: 'turn',
  river: 'river',
  showdown: 'showdown',
};

export function normalizeStreet(v: unknown): Street {
  const key = toStr(v, 'preflop').toLowerCase();
  return STREET_ALIASES[key] ?? 'preflop';
}

const ACTION_ALIASES: Record<string, NormalizedActionType> = {
  fold: 'fold',
  check: 'check',
  call: 'call',
  bet: 'bet',
  raise: 'raise',
  all_in: 'all_in',
  allin: 'all_in',
  'all-in': 'all_in',
  post_blind: 'post_blind',
  post_sb: 'post_blind',
  post_bb: 'post_blind',
  small_blind: 'post_blind',
  big_blind: 'post_blind',
  blind: 'post_blind',
  post_ante: 'post_ante',
  ante: 'post_ante',
  discard: 'discard',
};

export function normalizeActionType(v: unknown): NormalizedActionType {
  return ACTION_ALIASES[toStr(v, 'unknown').toLowerCase()] ?? 'unknown';
}

function isForced(a: NormalizedActionType): boolean {
  return a === 'post_blind' || a === 'post_ante';
}

/** Convert one persisted hand_history row into a NormalizedHand. */
export function fromHandHistoryRow(row: HandHistoryRow): NormalizedHand {
  const handId = toStr(row.id, `hand-${toNum(row.hand_number, 0)}`);
  const tableId = toStr(row.table_id, 'unknown-table');

  const players: NormalizedPlayer[] = Array.isArray(row.players)
    ? row.players.map((p) => {
        const rec = (p ?? {}) as Record<string, unknown>;
        return {
          userId: toStr(rec.userId ?? rec.user_id),
          seat: toNum(rec.seat),
          startingStack: toNum(rec.stack ?? rec.startingStack ?? rec.starting_stack),
          cards: toCards(rec.cards),
        };
      })
    : [];

  const winners: NormalizedWinner[] = Array.isArray(row.winners)
    ? row.winners.map((w) => {
        const rec = (w ?? {}) as Record<string, unknown>;
        return { userId: toStr(rec.userId ?? rec.user_id), amount: toNum(rec.amount) };
      })
    : [];

  const seatToUser = new Map<number, string>();
  for (const p of players) seatToUser.set(p.seat, p.userId);

  const rawActions = Array.isArray(row.actions) ? row.actions : [];
  // Latency = gap to the previous NON-FORCED action in the same hand.
  let lastVoluntaryTs: number | null = null;
  const actions: NormalizedAction[] = rawActions.map((a) => {
    const rec = (a ?? {}) as Record<string, unknown>;
    const seat = toNum(rec.seat);
    const userId = toStr(rec.userId ?? rec.user_id) || seatToUser.get(seat) || '';
    const action = normalizeActionType(rec.action);
    const ts = toNum(rec.timestamp);
    const forced = isForced(action);
    let latencyMs = 0;
    if (!forced && ts > 0 && lastVoluntaryTs != null && ts >= lastVoluntaryTs) {
      latencyMs = ts - lastVoluntaryTs;
    }
    if (!forced && ts > 0) lastVoluntaryTs = ts;
    return {
      handId,
      tableId,
      userId,
      seat,
      street: normalizeStreet(rec.stage ?? rec.street),
      action,
      amount: toNum(rec.amount),
      timestamp: ts,
      latencyMs,
      forced,
    };
  });

  return {
    handId,
    tableId,
    gameVariant: toStr(row.game_variant, 'unknown'),
    smallBlind: toNum(row.small_blind),
    bigBlind: toNum(row.big_blind, 1),
    potSize: toNum(row.pot_size),
    rake: toNum(row.rake_amount),
    communityCards: toCards(row.community_cards),
    startedAt: toMs(row.started_at),
    endedAt: toMs(row.ended_at),
    players,
    winners,
    actions,
  };
}

export function fromHandHistoryRows(rows: HandHistoryRow[]): NormalizedHand[] {
  return rows.map(fromHandHistoryRow);
}
