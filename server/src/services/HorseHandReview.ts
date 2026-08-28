/**
 * ═══════════════════════════════════════════════════════════════════════════
 * HORSE HAND REVIEW — the 20bb flag (Dan 2026-08-26)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * "Every hand where a horse wins or loses 20bb needs to be flagged and
 *  reviewed, for every horse, across all cash game variants, MTTs, spins and
 *  heads up. Track, audit, correct and improve horse decision making."
 *
 * Called beside writeHandFacts at settlement, from the same in-memory inputs:
 * SeatPlayer.totalInvested (blinds/antes included, net of uncalled refund)
 * and the winners list. These are EXACT — nothing here reconstructs nets
 * from hand_history.actions, whose reconstruction was measured failing chip
 * conservation in 38% of hands (2026-08-23 self-tuner audit).
 *
 * Any horse whose |net| >= 20bb gets one row in horse_hand_reviews carrying
 * everything a reviewer needs (its hole cards, the board, the full action
 * log, the net) plus LEAK TAGS from the pattern detectors below — the ones
 * that recognize the exact hands Dan watched: a non-nut flush stacking off
 * into a raise, a dominated pair calling down, a blown-off big bluff.
 *
 * Fire-and-forget, never throws, and deliberately NOT awaited by settlement.
 * A permanent per-horse/day rollup is maintained via fn_hhr_rollup_add;
 * raw rows are pruned at 30 days by sp_prune_horse_hand_reviews().
 */

import { supabase } from './supabase/client.js';
import { reportError } from './errorReporter.js';
import { variantInfo, omahaNutStatus, nlhNutStatus } from '../engine/HorseEval.js';
import type { Card } from '../types.js';

export interface HorseReviewInput {
  handId: string;
  tableId: string;
  clubId?: string | null;
  tournamentId?: string | null;
  gameVariant: string;
  bigBlind: number;
  playedAt: string;
  potSize?: number;
  /** Card objects OR the engine's board strings ("Khearts", "10spades"). */
  board?: unknown[] | null;
  /** Every seat dealt in: userId -> { seat, cards }. */
  holeCardsAll: Map<string, { seat: number; cards: unknown }>;
  /** userId -> totalInvested (blinds/antes included, net of uncalled refund). */
  contributions: Map<string, number>;
  winners: Array<{ userId: string; amount: number }>;
  actions: Array<{
    seat: number;
    userId?: string;
    action: string;
    amount?: number;
    stage: string;
  }>;
  roster: Array<{ userId: string; isHorse: boolean }>;
}

const FLAG_BB = 20;

export interface HorseReviewRow {
  hand_id: string;
  table_id: string;
  tournament_id: string | null;
  club_id: string | null;
  played_at: string;
  game_variant: string;
  format: string;
  big_blind: number;
  horse_user_id: string;
  seat: number | null;
  net_amount: number;
  net_bb: number;
  pot_size: number | null;
  hole_cards: unknown;
  board: unknown;
  actions: unknown;
  leak_tags: string[];
}

const r2 = (n: number): number => Math.round(n * 100) / 100;

function isCardArray(v: unknown): v is Card[] {
  return (
    Array.isArray(v) &&
    v.length >= 2 &&
    v.every((c) => c && typeof c === 'object' && 'rank' in c && 'suit' in c)
  );
}

const SUIT_NAMES = ['hearts', 'diamonds', 'clubs', 'spades'] as const;

/**
 * The settlement path carries the board as strings ("Khearts", "10spades");
 * hole cards arrive as Card objects. Accept either. Returns null when the
 * shape is unrecognized — detectors then simply skip board-aware tags.
 */
export function parseCards(v: unknown): Card[] | null {
  if (isCardArray(v)) return v;
  if (!Array.isArray(v) || v.length < 3) return null;
  const out: Card[] = [];
  for (const item of v) {
    if (typeof item !== 'string') return null;
    const suit = SUIT_NAMES.find((sn) => item.endsWith(sn));
    if (!suit) return null;
    let rank = item.slice(0, item.length - suit.length);
    if (rank === '10') rank = 'T';
    if (!rank) return null;
    out.push({ rank, suit } as Card);
  }
  return out;
}

/**
 * Leak detectors. Each looks at ONE flagged (usually losing) hand and answers
 * "is this one of the known bad shapes?". Tags are counted per horse per day
 * in horse_review_rollup, so a horse that keeps producing the same tag is
 * visible at a glance — and a fleet-wide spike in a tag after a deploy is a
 * regression alarm for the brain itself.
 */
export function detectLeaks(row: {
  netBB: number;
  invested: number;
  bigBlind: number;
  variant: string;
  holeCards: Card[] | null;
  board: Card[] | null;
  heroActions: Array<{ action: string; stage: string; amount?: number }>;
  wentToShowdown: boolean;
}): string[] {
  const tags: string[] = [];
  const vi = variantInfo(row.variant);
  const investedBB = row.invested / (row.bigBlind || 1);

  if (row.netBB > 0) return tags; // wins carry no leak tags (they are still stored)

  const folded = row.heroActions.some((a) => a.action === 'fold');
  const raisedOrBet = (stage: string) =>
    row.heroActions.some(
      (a) =>
        a.stage === stage && (a.action === 'bet' || a.action === 'raise' || a.action === 'all_in')
    );

  // Big loss with a fold at the end: chips went in and then the hand was
  // surrendered — a blown-off bluff or a bet-fold line that cost a stack.
  if (folded && investedBB >= FLAG_BB) {
    tags.push('big_bet_fold');
  }

  // Omaha nut discipline: the horse lost a 20bb+ pot at showdown holding a
  // non-nut flush or a dominated straight on the final board — the exact
  // "small flush pays off the bigger one" hand.
  if (vi.isOmaha && row.wentToShowdown && row.holeCards && row.board && row.board.length >= 3) {
    try {
      const st = omahaNutStatus(row.holeCards, row.board);
      if (st.category === 6 && st.higherFlushRanks >= 2) {
        tags.push('nonnut_flush_stackoff');
      } else if (st.category === 6 && st.higherFlushRanks === 1) {
        tags.push('second_nut_flush_stackoff');
      } else if (st.category === 5 && !st.straightIsNut) {
        tags.push('dominated_straight_stackoff');
      }
    } catch {
      /* detector is best-effort */
    }
  }

  // Preflop stack-off: 40bb+ went in with all the aggression preflop
  // (no postflop action from the horse at all).
  const postflopActed = row.heroActions.some((a) => a.stage !== 'preflop');
  if (!postflopActed && investedBB >= 2 * FLAG_BB) {
    tags.push('preflop_stackoff');
  }

  // River aggression that lost at showdown: bet/raised the river and paid off
  // or was called by better — worth human eyes when it repeats.
  if (row.wentToShowdown && raisedOrBet('river')) {
    tags.push('river_aggr_lost');

    // V21 (2026-08-27): river_aggr_lost lumped ordinary value bets that ran
    // into the top of the range together with RAISE WARS — and the wars are
    // where the -500bb pots live. Two or more aggressive river actions from
    // the horse in one hand is a war it kept escalating.
    const riverAggrCount = row.heroActions.filter(
      (a) =>
        a.stage === 'river' && (a.action === 'bet' || a.action === 'raise' || a.action === 'all_in')
    ).length;
    if (riverAggrCount >= 2) {
      tags.push('river_raise_war');
    }
  }

  // V21 NLH nut discipline at showdown — the holdem mirror of the Omaha
  // block above. A 20bb+ showdown loss holding a hand the BOARD demotes:
  // a straight on a three-flush board, a non-nut flush, the bottom boat.
  if (
    !vi.isOmaha &&
    row.wentToShowdown &&
    row.holeCards &&
    row.board &&
    row.board.length >= 5 &&
    investedBB >= FLAG_BB
  ) {
    try {
      const ns = nlhNutStatus(row.holeCards, row.board, vi.isShortDeck);
      const flushCat = vi.isShortDeck ? 7 : 6;
      const boatCat = vi.isShortDeck ? 6 : 7;
      if (ns.cat === 5 && ns.flushPossible) {
        tags.push('straight_into_flush_stackoff');
      } else if (ns.cat === 5 && ns.heroStraightTop < ns.maxStraightTop) {
        tags.push('nonnut_straight_stackoff');
      } else if (ns.cat === flushCat && ns.higherFlushRanks >= 1) {
        tags.push('nonnut_flush_stackoff');
      } else if (ns.cat === boatCat && ns.underfull) {
        tags.push('underfull_stackoff');
      }
    } catch {
      /* detector is best-effort */
    }
  }

  return tags;
}

/** Pure: build the rows to insert (exported for tests; no IO). */
export function buildReviewRows(input: HorseReviewInput): HorseReviewRow[] {
  const horses = new Set(input.roster.filter((p) => p.isHorse && p.userId).map((p) => p.userId));
  if (horses.size === 0) return [];

  const returnedBy = new Map<string, number>();
  for (const w of input.winners ?? []) {
    if (!w?.userId) continue;
    returnedBy.set(w.userId, r2((returnedBy.get(w.userId) ?? 0) + (w.amount ?? 0)));
  }

  const bb = input.bigBlind > 0 ? input.bigBlind : 1;
  const dealtCount = input.holeCardsAll.size || input.roster.length;
  const format = input.tournamentId ? 'tournament' : dealtCount === 2 ? 'hu_cash' : 'cash';

  const rows: HorseReviewRow[] = [];
  for (const uid of horses) {
    const invested = input.contributions.get(uid) ?? 0;
    const returned = returnedBy.get(uid) ?? 0;
    const net = r2(returned - invested);
    const netBB = net / bb;
    if (Math.abs(netBB) < FLAG_BB) continue;

    const seatInfo = input.holeCardsAll.get(uid);
    const heroActions = (input.actions ?? [])
      .filter((a) => a.userId === uid)
      .map((a) => ({ action: a.action, stage: a.stage, amount: a.amount }));
    const folded = heroActions.some((a) => a.action === 'fold');
    const holeCards = seatInfo ? parseCards(seatInfo.cards) : null;
    const board = input.board ? parseCards(input.board) : null;

    const tags = detectLeaks({
      netBB,
      invested,
      bigBlind: bb,
      variant: input.gameVariant,
      holeCards,
      board,
      heroActions,
      wentToShowdown: !folded,
    });

    rows.push({
      hand_id: input.handId,
      table_id: input.tableId,
      tournament_id: input.tournamentId ?? null,
      club_id: input.clubId ?? null,
      played_at: input.playedAt,
      game_variant: input.gameVariant,
      format,
      big_blind: bb,
      horse_user_id: uid,
      seat: seatInfo?.seat ?? null,
      net_amount: net,
      net_bb: r2(netBB),
      pot_size: input.potSize ?? null,
      // Store the PARSED shape when parsing succeeded (one consistent shape
      // for the UI and the daily analysis SQL), but NEVER discard evidence:
      // when the parser rejects a payload the raw shape is stored as-is, so
      // the audit's evidence_payload_missing finding can distinguish "parser
      // needs updating" from "data truly absent".
      hole_cards: holeCards ?? seatInfo?.cards ?? null,
      board: board ?? input.board ?? null,
      actions: input.actions ?? null,
      leak_tags: tags,
    });
  }
  return rows;
}

/** Kill switch: HORSE_HAND_REVIEW_ENABLED=false disables all writes. */
const enabled = (): boolean => process.env.HORSE_HAND_REVIEW_ENABLED !== 'false';

// ═══════════════════════════════════════════════════════════════════════════
// V16 REAL NETS (2026-08-26) — per-horse daily aggregate, EVERY hand
// ═══════════════════════════════════════════════════════════════════════════
// The self-tuner's bb100 rule was disabled because action-log reconstruction
// fails chip conservation in 38% of hands. This is the fix the 2026-08-23
// audit called for: the EXACT settlement nets, aggregated per
// horse/day/variant/format in memory and flushed additively every minute.
// Losing one flush window on a crash costs at most ~60s of aggregate — noise
// against a 7-day tuning window — and the additive upsert makes every flush
// idempotent-safe to retry.

interface NetAcc {
  hands: number;
  netBB: number;
}

const netAcc = new Map<string, NetAcc>();
const NET_FLUSH_MS = 60_000;
const NET_BATCH_MAX = 500;
/** Bounded during outages: beyond this, oldest keys are dropped (reported). */
const NET_ACC_MAX_KEYS = 8000;
let netFlushTimer: NodeJS.Timeout | null = null;

const netsEnabled = (): boolean => process.env.HORSE_NET_ROLLUP_ENABLED !== 'false';

/** Accumulate one settled hand's exact nets for every horse dealt in. */
export function accumulateHorseNets(input: HorseReviewInput): void {
  try {
    if (!netsEnabled() || !input.handId) return;
    const bb = input.bigBlind > 0 ? input.bigBlind : 1;
    const day = input.playedAt.slice(0, 10);
    const dealtCount = input.holeCardsAll.size || input.roster.length;
    const format = input.tournamentId ? 'tournament' : dealtCount === 2 ? 'hu_cash' : 'cash';
    const returnedBy = new Map<string, number>();
    for (const w of input.winners ?? []) {
      if (!w?.userId) continue;
      returnedBy.set(w.userId, (returnedBy.get(w.userId) ?? 0) + (w.amount ?? 0));
    }
    for (const p of input.roster) {
      if (!p.isHorse || !p.userId) continue;
      const invested = input.contributions.get(p.userId) ?? 0;
      const returned = returnedBy.get(p.userId) ?? 0;
      if (invested === 0 && returned === 0) continue; // dealt in but never posted
      const key = `${p.userId}|${day}|${input.gameVariant}|${format}`;
      const acc = netAcc.get(key) ?? { hands: 0, netBB: 0 };
      acc.hands += 1;
      acc.netBB += (returned - invested) / bb;
      netAcc.set(key, acc);
    }
    if (netAcc.size > NET_ACC_MAX_KEYS) {
      // An outage has backed us up far beyond a realistic key space
      // (584 horses x variants x formats x a few days). Drop oldest-first
      // and SAY SO — silent loss is the house failure mode.
      let toDrop = netAcc.size - NET_ACC_MAX_KEYS;
      for (const k of netAcc.keys()) {
        if (toDrop-- <= 0) break;
        netAcc.delete(k);
      }
      reportError(
        new Error(`net accumulator overflow - dropped oldest keys (cap ${NET_ACC_MAX_KEYS})`),
        'HorseHandReview.netOverflow'
      );
    }
    if (!netFlushTimer) {
      netFlushTimer = setInterval(() => {
        void flushHorseNets().catch((err: unknown) => reportError(err, 'HorseHandReview.netFlush'));
      }, NET_FLUSH_MS);
      netFlushTimer.unref?.();
    }
  } catch (err) {
    reportError(err, 'HorseHandReview.accumulateNets');
  }
}

/** Drain up to `max` accumulated keys into RPC row shapes (exported for tests). */
export function drainHorseNets(max: number = NET_BATCH_MAX): Array<{
  horse_user_id: string;
  day: string;
  game_variant: string;
  format: string;
  hands: number;
  net_bb: number;
}> {
  const rows: Array<{
    horse_user_id: string;
    day: string;
    game_variant: string;
    format: string;
    hands: number;
    net_bb: number;
  }> = [];
  for (const [key, acc] of netAcc) {
    if (rows.length >= max) break;
    const [horse, day, variant, format] = key.split('|');
    rows.push({
      horse_user_id: horse,
      day,
      game_variant: variant,
      format,
      hands: acc.hands,
      net_bb: r2(acc.netBB),
    });
    netAcc.delete(key);
  }
  return rows;
}

async function flushHorseNets(): Promise<void> {
  const rows = drainHorseNets();
  if (rows.length === 0) return;
  const { error } = await supabase.rpc('fn_horse_daily_nets_add', { p_rows: rows });
  if (error) {
    reportError(new Error(error.message), 'HorseHandReview.netFlushRpc');
    // Merge the batch back so a transient outage loses nothing; the additive
    // upsert makes the eventual retry safe.
    for (const row of rows) {
      const key = `${row.horse_user_id}|${row.day}|${row.game_variant}|${row.format}`;
      const acc = netAcc.get(key) ?? { hands: 0, netBB: 0 };
      acc.hands += row.hands;
      acc.netBB += row.net_bb;
      netAcc.set(key, acc);
    }
  }
}

let pruneArmed = false;

/**
 * Record 20bb+ horse hands for review. Fire-and-forget, never throws.
 */
export async function recordHorseHandReviews(input: HorseReviewInput): Promise<void> {
  try {
    // V16: the real-nets aggregate sees EVERY hand, not just the 20bb flags,
    // and has its own kill switch (HORSE_NET_ROLLUP_ENABLED).
    accumulateHorseNets(input);
    if (!enabled() || !input.handId) return;
    const rows = buildReviewRows(input);
    if (rows.length === 0) return;

    // ignoreDuplicates = ON CONFLICT DO NOTHING, and .select() returns only
    // the rows actually INSERTED — so a re-processed hand (settlement retry)
    // inserts nothing, returns nothing, and the rollup below adds nothing.
    // Without this, a retry would dedupe the rows but double-count the
    // rollup.
    const { data: inserted, error } = await supabase
      .from('horse_hand_reviews')
      .upsert(rows as never[], { onConflict: 'hand_id,horse_user_id', ignoreDuplicates: true })
      .select('horse_user_id');
    if (error) {
      reportError(new Error(error.message), 'HorseHandReview.insert');
      return;
    }
    const insertedIds = new Set(
      ((inserted ?? []) as Array<{ horse_user_id: string }>).map((r) => r.horse_user_id)
    );

    // Rollup, one RPC per INSERTED row (rows per hand are 1-3; volume tiny).
    const day = input.playedAt.slice(0, 10);
    for (const row of rows) {
      if (!insertedIds.has(row.horse_user_id)) continue;
      const { error: rerr } = await supabase.rpc('fn_hhr_rollup_add', {
        p_horse: row.horse_user_id,
        p_day: day,
        p_variant: row.game_variant,
        p_is_win: row.net_bb > 0,
        p_net_bb: row.net_bb,
        p_tags: row.leak_tags,
      });
      if (rerr) {
        reportError(new Error(rerr.message), 'HorseHandReview.rollup');
        break;
      }
    }

    // Retention: prune once per process lifetime, well after boot.
    if (!pruneArmed) {
      pruneArmed = true;
      setTimeout(
        () => {
          // supabase-js builders are PromiseLike without .catch — wrap in a
          // real Promise so the rejection handler exists and is typed.
          void (async () => {
            const { error: perr } = await supabase.rpc('sp_prune_horse_hand_reviews');
            if (perr) reportError(new Error(perr.message), 'HorseHandReview.prune');
          })().catch((err: unknown) => reportError(err, 'HorseHandReview.prune'));
        },
        10 * 60 * 1000
      );
    }
  } catch (err) {
    reportError(err, 'HorseHandReview.record');
  }
}
