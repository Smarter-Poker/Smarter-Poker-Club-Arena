/**
 * Supabase helpers — the 4-tier hand history writer (Bible V8 §2.18).
 *
 * Split out of the 1,474-line `src/services/supabase.ts` module on 2026-08-08
 * (deploy tooling caps a single file at ~50 KB). This is a pure move: function
 * bodies are byte-identical to the original — the only edits are module
 * boundaries and the import of the shared client from `./client.js`.
 * `src/services/supabase.ts` remains as a barrel re-exporting every submodule,
 * so no import anywhere else in the codebase changed.
 */

import { supabase } from './client.js';
import { reportError } from '../errorReporter.js';
import { writeHandFacts } from './handFacts.js';
import { recordHorseHandReviews } from '../HorseHandReview.js';
import { readScopeOf } from '../../engine/HorseMind.js';
import { getLiveHorseDecisionWorker } from '../../engine/horseDecision/index.js';
import { wakeHandProjection } from './handProjection.js';

export interface AtomicHandCommitInput {
  stacks: Array<{
    user_id: string;
    stack: number;
    stack_before: number;
  }>;
  rake: number;
  bbj: number;
  ref?: string | null;
  inflow?: number | null;
  /**
   * Exact protocol-2 database authority. Both fields are present together for
   * verified cash and tournament engines; omitting both selects only the
   * rolling-upgrade protocol-1 wrapper.
   */
  leaseInstanceId?: string;
  leaseGeneration?: string;
  /**
   * Immutable work which must survive the exact dealer after the accepted
   * hand transaction returns. Presence selects the 12-argument protocol-2
   * RPC; the database hashes and stores it on the atomic hand receipt before
   * either becomes visible.
   */
  postCommitObligations?: {
    version: 1;
    time_banks: Array<{
      user_id: string;
      uses_remaining: number;
      seconds_remaining: number;
    }>;
    rake: Record<string, unknown> | null;
    bbj_contribution: Record<string, unknown> | null;
    promo_playthrough: Array<Record<string, unknown>>;
    insurance: Array<Record<string, unknown>>;
    pending_addons: { enabled: true; max_buy_in: number | null } | null;
  };
  /**
   * Canonical facts independently carried by the accepted-hand payload. The
   * 12-argument database door binds its obligation narrative to these values
   * before storing either one. The extra JSON key is intentionally ignored by
   * the hand_history row inserter but remains covered by the atomic hand hash.
   */
  acceptedPostCommitFacts?: {
    contributions: Record<string, number>;
    returned_uncalled: Record<string, number>;
    insurance: Array<Record<string, unknown>>;
  };
  /**
   * Local distributed-lease fence, invoked immediately before every retry of
   * the authoritative PostgreSQL transaction. It is deliberately not part of
   * the RPC payload's generation. Together they close both a persistent-
   * UNKNOWN local retry and a stale continuation running after DB takeover.
   */
  assertLeaseAuthority?: () => void;
}

/**
 * Log hand history — every hand documented for audit and replay.
 */
/**
 * Bible V8 §2.18: 4-tier Hand History system
 *
 * Tier 1: raw_events      — Every action with timestamps (audit/dispute)
 * Tier 2: audit_log       — Normalized format for compliance review
 * Tier 3: player_summaries — Per-player view (what they can see in their history)
 * Tier 4: dispute_review  — Full data package for dispute resolution
 *
 * CORRECTION 2026-08-20: the four tiers are DERIVED, not stored. See the long
 * note above insertHandHistoryRow() for the measurement that forced this — in
 * short, the columns never existed, every hand paid for a guaranteed-failing
 * write to attempt them, and all four are pure functions of columns this row
 * already stores. buildHandHistoryTiers() below materialises them on demand.
 */
export async function logHandHistory(params: {
  tableId: string;
  /**
   * `tables.nit_game`. Passed through to writeHandFacts so a horse at a NIT
   * table produces the VPIP evidence the rule is judged on. See the note over
   * writeHandFacts for why the rule could not bite without it.
   */
  nitGame?: boolean;
  /** The table's VPIP floor in percent (0 = none). See recordHorseHandReviews. */
  vpipFloor?: number;
  tournamentId?: string;
  handNumber: number;
  gameVariant: string;
  smallBlind: number;
  bigBlind: number;
  potSize: number;
  rakeAmount: number;
  bbjAmount?: number;
  communityCards: string[];
  /** DOUBLE-BOARD BOMB POT 2026-08-20: board 2 (empty on single-board hands). */
  communityCards2?: string[];
  /** TRIPLE-BOARD BOMB POT 2026-08-27: board 3 (empty below three boards). */
  communityCards3?: string[];
  /**
   * BOMB POT STANDARDIZATION 2026-08-27 (spec §20): the bomb facts frozen at
   * trigger time — why the hand was a bomb, the equal forced ante, and how
   * many boards were actually dealt. Written to hand_history.bomb_pot as
   * jsonb; NULL on every normal hand.
   */
  bombPot?: {
    trigger_reason: string;
    ante_amount: number;
    board_count: number;
    /** VARIANT OVERRIDE 2026-08-28 (spec §10.1): the variant the bomb hand was dealt as. */
    variant?: string;
  } | null;
  /**
   * COMPLETENESS PASS 2026-08-26: run-it-twice boards 2..N (engine card
   * strings, run order). Written to hand_history.rit_boards — NULL on every
   * single-run hand so historical rows and normal hands look identical.
   * Before this column, a RIT hand was indistinguishable in the database:
   * the extra boards were smuggled through `actions` as `rit_board_N:`
   * pseudo-entries, which replayers had to parse back out.
   */
  ritBoards?: string[][];
  // Round 38 — wall-clock timestamps. startedAt is captured at HAND_START
  // in ServerTableEngine; endedAt is stamped here at write time.
  startedAt?: number;
  endedAt?: number;
  winners: {
    userId: string;
    amount: number;
    potIndex?: number;
    hand?: { name: string; ranking: number };
  }[];
  /**
   * WHO WON EACH RUN (2026-09-04). `winners` is one aggregated entry per
   * player - the whole paid total under BOARD 1's hand name - so a run-it-3-
   * times hand where one player took Two Pair, a Straight and Trips was
   * recorded as "Two Pair"; a split was two totals with no board on either
   * (Dan, hand #6145364: "results that weren't accurate"). This is the
   * per-board record the felt reads off pot_win, persisted. Amounts are the
   * engine's pre-rake board shares. Written as NULL when there is one board,
   * so ordinary rows are unchanged. Column: hand_history.winners_by_board.
   */
  winnersByBoard?: {
    board: number;
    userId: string;
    amount: number;
    handName?: string;
    /** HI-LO: the entry for the low half. See HandEvent WINNERS.winnersByBoard. */
    low?: boolean;
  }[];
  /**
   * POT-LEVEL SETTLEMENT (Dan section 29, 2026-08-25).
   *
   * `winners[].potIndex` has been persisted since Bible V8 §2.7 and has been
   * uninterpretable the whole time, because nothing recorded what the pots
   * WERE. This is that record: one entry per pot in pot order, with the
   * players who were entitled to contest it.
   *
   * Optional so every other caller of logHandHistory is unaffected, and
   * written as NULL when empty so the two million historical rows and a
   * fold-around hand look the same to a reader.
   */
  pots?: { index: number; amount: number; eligible: string[] }[];
  /**
   * THE BOMB POT'S OWN BREAKDOWN, WRITTEN WITH THE HAND AND NOT AFTER IT.
   *
   * One row per (pot layer, board, hi/lo side, winner). Until 2026-09-06 these
   * were a SECOND write, fired after this one and deliberately unawaited so it
   * could never fail a hand. That instinct is right for a hand in progress and
   * wrong as an architecture: two writes with no transaction between them means
   * one of them can be the only one that lands. Measured on production that
   * hour: 3 of 125 bomb pots had no award units at all - the pot paid, the rake
   * taken, and no record of which board or which player got which share.
   *
   * Passed here, they go through fn_ca_insert_hand_with_awards in ONE round
   * trip and ONE transaction, so the hot path still costs exactly one request
   * (which the retry-queue design below deliberately bought) and the breakdown
   * can no longer be the half that goes missing.
   */
  bombAwardUnits?: {
    pot_index: number;
    board: number;
    side: string;
    user_id: string;
    amount: number;
    hand_name?: string | null;
  }[];
  /**
   * THE HAND'S OWN ID, MINTED BY THE ENGINE BEFORE ANYTHING IS WRITTEN.
   *
   * `hand_history.id` defaults to `gen_random_uuid()`, so for its whole life
   * this row's identity was decided by the INSERT - and settlement needs that
   * identity BEFORE the insert, because `atomic_distribute_rake` takes it as
   * `p_hand_id` and everything downstream keys on it. When the insert failed
   * or was slow and the hand went to the retry queue, the rake was banked with
   * `p_hand_id => NULL`, and a null there is not a small gap:
   *
   *   - `rake_attributions` keys on hand_id, so NOBODY at that table earned
   *     anything from the hand - no VIP points, no agent or super-agent
   *     commission, no rakeback basis. Measured 2026-09-07: 173 cash hands in
   *     24 hours, every one of them with zero attribution rows. Horses and
   *     humans alike (CLAUDE.md 10.5);
   *   - `uq_rake_records_hand_id` is `UNIQUE (hand_id) WHERE hand_id IS NOT
   *     NULL`, so it dedupes nothing when the id is null and an in-line retry
   *     books the club a second time;
   *   - every later reader - the 15-minute re-drive, the hourly repair - asks
   *     "does a rake_records row name this hand?", is told no, and banks it
   *     AGAIN. 384 hands between 2026-09-02 and 2026-09-07 were booked twice,
   *     719.49 chips of rake and 93.14 of BBJ drop that no pot ever paid.
   *
   * Passing the id in removes the null rather than compensating for it
   * (CLAUDE.md 10.12): the hand carries one identity from settlement onward,
   * whether its row lands in line, from the queue five minutes later, or not
   * at all. The unique index then does its job, the attribution is written
   * once, and no repair can see the hand as unbanked.
   */
  handId?: string;
  players: { userId: string; username: string; seat: number; stack: number; cards: string[] }[];
  actions: {
    seat: number;
    userId?: string;
    action: string;
    amount?: number;
    timestamp?: number;
    stage: string;
  }[];
  showdownResults?: {
    userId: string;
    handRanking: number;
    handName: string;
    kickers: number[];
    holeCards: { rank: string; suit: string }[];
  }[];
  /**
   * Server-authored Daily Missions facts for this hand. Persisting the facts
   * on the same retryable hand-history row makes mission projection survive a
   * transient database outage without delaying money settlement.
   */
  dailyMissionEvents?: Array<{
    user_id: string;
    amounts: Record<string, number>;
    magnitudes: Record<string, number>;
    /** Exact threshold values; absent on rows written by older engines. */
    values?: Partial<Record<'big_pots' | 'strong_hands', number[]>>;
  }>;
  /**
   * ASSISTANT FIX 2026-08-16: dealer/button seat for this hand.
   *
   * Without it no positional analysis is possible at all — seat 3 is UTG in
   * one hand and the cutoff two hands later, so "you open too wide from early
   * position", the most common leak in low-stakes poker, was uncomputable.
   * The engine has always tracked this (currentHandDealerSeat); it was simply
   * never persisted.
   */
  buttonSeat?: number;
  /**
   * STATS FACT LAYER 2026-08-21 — inputs for ca_hand_facts.
   *
   * All four are already in engine memory at the single call site
   * (ServerTableEngineSettlement.postHandTasks) and were previously discarded.
   * They are optional so that nothing else calling this function has to change,
   * and so a caller that cannot supply them simply skips the fact write.
   *
   * `contributions` is the important one: it is SeatPlayer.totalInvested, which
   * includes blinds, antes, dead blinds and straddles and is net of a returned
   * uncalled bet. It is the only exact net available — reconstructing it from
   * `actions` undercounts by the forced money, which is why
   * buildHandHistoryTiers() flags its own figure `contributedIncludesBlinds:
   * false`.
   */
  clubId?: string | null;
  /** userId -> totalInvested (includes blinds/antes). */
  contributions?: Map<string, number>;
  /** Every seat dealt in: userId -> { seat, cards }. Includes folded players. */
  holeCardsAll?: Map<string, { seat: number; cards: unknown }>;
  /** Seat roster with horse flags. Only humans get fact rows. */
  roster?: Array<{ userId: string; isHorse: boolean }>;
  /**
   * SHOWDOWN POLISH 2026-08-25: what the table actually SAW at showdown —
   * one entry per showdown participant with reveal order and the muck
   * ruling. Revealed entries carry the hand identity; mucked entries
   * deliberately do NOT (participants can read this row back, and a mucked
   * range stays private — the 2026-08-17 leak rule). Written to the
   * `showdown` jsonb column (migration 20260825_hand_history_showdown_reveal).
   * Replays and dispute review render the reveal sequence from this.
   */
  showdownReveal?: Array<{
    user_id: string;
    seat: number;
    reveal_order: number;
    mucked: boolean;
    hand_name?: string;
    hand_description?: string;
  }>;
  /**
   * The authoritative hand commit.  When supplied, the hand row is not an
   * independent best-effort insert: stacks, the row, tournament chip mirror,
   * bomb units, immutable bust generation and projection outbox all go through
   * fn_ca_commit_hand_settlement in one PostgreSQL transaction.
   */
  atomicCommit?: AtomicHandCommitInput;
}): Promise<{
  handId: string | null;
  wroteAwardUnits: boolean;
  settlementCommitted: boolean;
  stackResult?: Record<string, unknown>;
}> {
  // Round 38 fix: stamp started_at/ended_at + RETURNING id so the caller
  // can FK rake_records.hand_id back to this hand_history row.
  const startedAtIso = params.startedAt
    ? new Date(params.startedAt).toISOString()
    : new Date().toISOString();
  const endedAtIso = params.endedAt
    ? new Date(params.endedAt).toISOString()
    : new Date().toISOString();

  // ── Personal-assistant inputs (ASSISTANT FIX 2026-08-16) ────────────
  // `hand_history.hole_cards` and `.board` have existed as columns for a long
  // time and NOTHING has ever written to them: 0 populated rows out of 56,594
  // hands a day. Meanwhile the leak detector selects exactly those two columns
  // (`hero_cards:hole_cards, board`) to attach a worked example to every leak
  // it reports — so every example it produced showed the player a leak with no
  // hand and no board attached.
  //
  // Only SHOWDOWN-revealed holdings go in. That is information the whole table
  // already saw face-up, so a hand participant reading this column learns
  // nothing new. Mucked cards are deliberately never stored: persisting them
  // would let anyone who played the hand mine their opponents' mucked ranges
  // afterwards, which is a game-integrity problem, not a feature.
  const holeCardsByUser: Record<string, { rank: string; suit: string }[]> = {};
  for (const sd of params.showdownResults ?? []) {
    if (sd.userId && sd.holeCards?.length) holeCardsByUser[sd.userId] = sd.holeCards;
  }
  const holeCardsPayload = Object.keys(holeCardsByUser).length > 0 ? holeCardsByUser : null;
  const boardPayload = params.communityCards?.length ? params.communityCards : null;

  const row = {
    // See `handId` on the params above. Omitted entirely when the caller did
    // not mint one, so the column keeps its gen_random_uuid() default and
    // every other caller of this function is byte-identical to before.
    ...(params.handId ? { id: params.handId } : {}),
    table_id: params.tableId,
    tournament_id: params.tournamentId || null,
    hand_number: params.handNumber,
    game_variant: params.gameVariant,
    small_blind: params.smallBlind,
    big_blind: params.bigBlind,
    pot_size: params.potSize,
    rake_amount: params.rakeAmount,
    bbj_amount: params.bbjAmount || 0,
    community_cards: params.communityCards,
    // DOUBLE-BOARD BOMB POT 2026-08-20: null (not []) on single-board hands
    // so existing consumers see no change. Column added by migration
    // 20260820 bomb_pot_double_board.
    community_cards2: params.communityCards2?.length ? params.communityCards2 : null,
    // TRIPLE-BOARD BOMB POT 2026-08-27: board 3 + frozen bomb facts (spec
    // §20). Both NULL on normal hands. Columns added by migration
    // 20260827_bomb_pot_standardization.
    community_cards3: params.communityCards3?.length ? params.communityCards3 : null,
    bomb_pot: params.bombPot ?? null,
    // COMPLETENESS PASS 2026-08-26: RIT boards 2..N, first-class. NULL (not
    // []) on single-run hands so historical rows and normal hands look
    // identical. Column added by migration 20260826_hand_history_rit_boards.
    rit_boards: params.ritBoards?.length ? params.ritBoards : null,
    started_at: startedAtIso,
    ended_at: endedAtIso,
    winners: params.winners,
    // Multi-board hands, and any hand with a LOW half (2026-09-04): those are
    // the hands whose merged `winners` cannot tell the story. NULL keeps every
    // other single-board row byte-identical.
    winners_by_board: params.winnersByBoard?.some((w) => w.board > 1 || w.low)
      ? params.winnersByBoard
      : null,
    // Dan section 29. NULL rather than [] on a hand with no recorded
    // breakdown, so "this hand predates the column" and "this hand had one
    // uncontested pot" are not the same value to attributeKnockout().
    pots: params.pots?.length ? params.pots : null,
    players: params.players,
    actions: params.actions,
    hole_cards: holeCardsPayload,
    board: boardPayload,
    button_seat: params.buttonSeat ?? null,
    // SHOWDOWN POLISH 2026-08-25: null (not []) on a hand with no showdown,
    // so "predates the column" and "no showdown happened" read the same as
    // every other nullable jsonb here.
    showdown: params.showdownReveal?.length ? params.showdownReveal : null,
    daily_mission_events: params.dailyMissionEvents?.length ? params.dailyMissionEvents : null,
    // RETENTION FIX 2026-08-21: has_human has existed since the retention work
    // and NOTHING has ever set it — it was NULL on all 1,509,240 rows. It is
    // the flag sp_prune_hand_history() uses to spare hands with a human in
    // them from the 7-day purge, so for its entire existence the purge has
    // been deleting human hands along with the horse traffic it was aimed at.
    // Undefined (not false) when the caller cannot tell us, so we never assert
    // "no humans here" on a hand we simply have no roster for.
    ...(params.roster ? { has_human: params.roster.some((p) => !p.isHorse) } : {}),
  };

  const bombUnits = (params.bombAwardUnits ?? []).map((u) => ({
    table_id: params.tableId,
    hand_number: params.handNumber,
    pot_index: u.pot_index,
    board: u.board ?? 1,
    side: u.side ?? 'high',
    user_id: u.user_id,
    amount: u.amount,
    hand_name: u.hand_name ?? null,
  }));
  const inserted = await insertHandHistoryRow(row, 'settlement', bombUnits, params.atomicCommit);
  const handId = inserted.id;
  const wroteUnitsAtomically = inserted.wroteUnits;
  if (handId === null && !params.atomicCommit) {
    // Every in-line attempt failed. Hand it to the background queue rather
    // than losing the hand — see enqueueHandHistory().
    enqueueHandHistory(row, bombUnits);
  }

  // V28 AUDIT FIX (2026-08-29): observe regardless of whether the history row
  // landed. ROOT-CAUSE CAPACITY FIX (2026-09-08): HorseMind now lives beside
  // HorseLogic in the sole worker FIFO. Enqueueing establishes the ordering:
  // this observation is ahead of every decision the table can request next.
  // Waiting for its ACK here would instead hold this table's settlement behind
  // older work from every other table in the process. Graceful worker shutdown
  // drains every accepted entry, so the durable hand commit can return as soon
  // as the observation has been accepted into the FIFO.
  try {
    const handKey = `${params.tableId}:${params.handNumber}`;
    const observation = getLiveHorseDecisionWorker().observeCompletedHand({
      generation: params.handNumber,
      fence: [
        params.tableId,
        params.handNumber,
        params.atomicCommit?.leaseGeneration ?? 'legacy',
        'observe',
      ].join(':'),
      handKey,
      actions: params.actions,
      bigBlind: params.bigBlind,
      showdown: params.showdownReveal ?? null,
      // V45: the hand's scope - card family and how many were dealt in.
      scope: readScopeOf(
        params.gameVariant,
        params.holeCardsAll?.size ?? params.roster?.length ?? params.players?.length ?? 0
      ),
    });
    void observation.catch((error) =>
      reportError(error, 'HandHistory.horse_mind_observation_failed')
    );
  } catch (error) {
    reportError(error, 'HandHistory.horse_mind_observation_failed');
    /* observation must never endanger settlement */
  }

  // STATS FACT LAYER 2026-08-21. Durable per-human-per-hand row for the stats
  // page: exact net, own hole cards on every hand (not just showdowns),
  // all-in EV, and head-to-head chip flow. Deliberately NOT awaited — this is
  // a stats write inside a money-critical settlement step, and writeHandFacts
  // never throws, so the hand must not wait on it or be endangered by it.
  if (handId && params.contributions && params.holeCardsAll && params.roster) {
    void writeHandFacts({
      handId,
      tableId: params.tableId,
      clubId: params.clubId ?? null,
      tournamentId: params.tournamentId ?? null,
      handNumber: params.handNumber,
      gameVariant: params.gameVariant,
      bigBlind: params.bigBlind,
      playedAt: endedAtIso,
      buttonSeat: params.buttonSeat ?? null,
      rakeAmount: params.rakeAmount,
      boardLength: params.communityCards?.length ?? 0,
      holeCardsAll: params.holeCardsAll,
      contributions: params.contributions,
      winners: params.winners,
      actions: params.actions,
      roster: params.roster,
      // The rule and its evidence must cover the same seats. See writeHandFacts.
      nitGame: params.nitGame,
      // Bomb pots count as VPIP for everyone dealt in (Dan 2026-09-05).
      isBombPot: Boolean(params.bombPot),
    });
    // (V16 deep-read observation moved ABOVE the handId gate — V28 audit.)

    // HORSE HAND REVIEW 2026-08-26 (Dan): every horse that won or lost 20bb+
    // in this hand gets a review row with leak tags — same exact in-memory
    // inputs as the fact write above, same fire-and-forget contract.
    void recordHorseHandReviews({
      handId,
      tableId: params.tableId,
      clubId: params.clubId ?? null,
      tournamentId: params.tournamentId ?? null,
      gameVariant: params.gameVariant,
      bigBlind: params.bigBlind,
      playedAt: endedAtIso,
      potSize: params.potSize,
      board: params.communityCards ?? null,
      holeCardsAll: params.holeCardsAll,
      contributions: params.contributions,
      winners: params.winners,
      actions: params.actions,
      roster: params.roster,
      // 2026-09-05: the rake is part of the result (horse_daily_nets.rake_bb),
      // and the button places the blinds for horse_daily_play.
      rakeAmount: params.rakeAmount,
      // 2026-09-06: THE DROP IS THE RAKE AND THE JACKPOT. On 2026-09-06 the
      // fleet's residual after rake was -1,778bb and the day's BBJ drop was
      // 1,761bb - a 1% match. Both halves of the drop must reach the horse
      // row or the tuner reads the house take as a leak.
      bbjAmount: params.bbjAmount ?? 0,
      buttonSeat: params.buttonSeat ?? null,
      // 2026-09-06: a floored table's play is measured separately - the
      // horse is required to be loose there.
      vpipFloor: params.vpipFloor ?? 0,
    });
  }

  /* wroteAwardUnits says the breakdown went in with the row, in one
     transaction. False means the hand took the plain insert (no units to
     carry, or the atomic call failed and the row is queued) - and the caller's
     fallback upsert is then the only thing that will write them. */
  /* Only the atomic insert's own success counts. The duplicate-recovery path
     inside insertHandHistoryRow returns an EXISTING hand id after its RPC
     rolled back, so the units in this call were never written - reporting true
     there would skip the caller's fallback and lose them. */
  return {
    handId,
    wroteAwardUnits: wroteUnitsAtomically,
    settlementCommitted: inserted.settlementCommitted,
    stackResult: inserted.stackResult,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// THE WRITE ITSELF — retry, idempotency, and a durable-ish background queue
// ═══════════════════════════════════════════════════════════════════════════════
//
// 2026-08-20. Two defects, found by tracing the only open financial_alerts
// signal (rake_records rows with a null hand_id) back through the edge logs.
//
// DEFECT 1 — every hand made a guaranteed-failing write first.
//   This function used to insert with four extra JSONB columns (raw_events,
//   audit_log, player_summaries, dispute_review — "Bible V8 §2.18 4-tier hand
//   history") and fall back to an insert without them "if the columns don't
//   exist yet". The columns have NEVER existed: supabase/migrations/
//   20260417_hand_history_4tier.sql was written on 2026-04-17 and never
//   applied. So for four months EVERY hand did two PostgREST round-trips — a
//   400 followed by a 201. Measured in edge_logs: 138 x 400 + 138 x 201 in the
//   same minute, every minute, ~238,000 wasted failing requests a day. The
//   "graceful fallback" is exactly what kept it invisible.
//
//   The migration is deliberately NOT being applied. All four tiers are pure
//   functions of columns this row already stores: raw_events is `actions`
//   re-keyed, audit_log is the row's own scalars re-packed, player_summaries is
//   derived from players + winners + actions, and dispute_review is literally
//   the other three concatenated with showdown_results and community_cards.
//   hand_history is already 10 GB over 2.45M rows and takes 238,583 rows a day;
//   storing three redundant copies of the same payload would roughly quadruple
//   that growth for zero new information. buildHandHistoryTiers() below
//   materialises the same four tiers on demand from a stored row, so §2.18 is
//   satisfied by derivation instead of by triplication.
//
// DEFECT 2 — a transient failure lost the hand permanently.
//   The insert had no retry. Measured over 3 days: 320 rake rows written with a
//   null hand_id, and for 315 of them NO hand_history row exists at all — those
//   hands are unauditable, absent from player history, and missing from the
//   leaderboard's hand_history trigger. The failures are not spread out: all
//   320 land in 32 distinct minutes, 291 of them inside 14 minutes that had 5+
//   failures, peaking at 57 in one minute across 44 different tables. During
//   those windows hand_history writes drop to literally zero platform-wide
//   (199/min -> 52 -> 0 -> 61 -> 217 on 2026-08-19 01:06-01:08) while the much
//   smaller atomic_distribute_rake RPC still gets through. That is a load /
//   availability window, not a bad payload — which is precisely the profile
//   worth retrying.
//
// So: retry in line for the short blips, and queue for the long ones. Both are
// idempotent through uq_hand_history_global_hand_number, the existing partial
// unique index on hand_number WHERE hand_number >= 1000000 — every globally
// allocated hand number is covered by it, so "did my write actually land?" is a
// single indexed lookup. Below 1000000 the number is only per-table unique, so
// those hands are never retried (a retry there could duplicate).

type HandHistoryRow = Record<string, unknown> & { hand_number: number; table_id: string };

/** Only globally allocated hand numbers are unique platform-wide. */
const GLOBAL_HAND_NUMBER_FLOOR = 1_000_000;

/** Did this hand already land? Cheap: one indexed lookup on a unique index. */
async function findExistingHandId(row: HandHistoryRow): Promise<string | null> {
  if (row.hand_number < GLOBAL_HAND_NUMBER_FLOOR) return null;
  const { data, error } = await supabase
    .from('hand_history')
    .select('id')
    .eq('hand_number', row.hand_number)
    .limit(1)
    .maybeSingle();
  if (error) return null;
  return data?.id ?? null;
}

/**
 * Insert one hand_history row.
 *
 * ONE attempt. This is deliberate, and it is a correction of this module's own
 * first version — see the note below.
 *
 * REVIEW FIX 2026-08-20: the first version retried three times in line, with
 * 250ms/900ms backoff and an existence pre-check before each retry. On paper
 * that was "~1.15s worst case". In production it was far worse, because the
 * backoff is not what dominates:
 *
 *   * a fully failing hand issued FIVE PostgREST requests, not one
 *     (3 inserts + 2 pre-checks), and
 *   * the shared client aborts at DB_TIMEOUT_MS = 15s (services/supabase/
 *     client.ts), not instantly.
 *
 * The outage mode this retry exists for is a hung socket, not a fast 5xx. So
 * the real worst case was 5 x 15s + 1.15s = ~76s per hand — awaited inside
 * postHandTasks, which ServerTableEngineDealing awaits at the top of every
 * dealing-loop iteration. That table deals nothing for the duration, and
 * postHandTasks never calls markProgress(), so the 90s watchdog
 * (ServerTableEngineBase.WATCHDOG_IDLE_MS) runs the whole time. One failing
 * hand could therefore trip the watchdog and kill the engine for a restart —
 * turning a transient write outage into a fleet-wide restart cascade, on all
 * 44 tables at once, since the failures are correlated by construction.
 *
 * It was also a 5x request amplification with zero jitter, aimed at a PostgREST
 * that had just gone to zero. That makes an outage longer, not shorter.
 *
 * So the hot path is back to exactly one request — the same cost as before any
 * of this work — and ALL retrying happens in the background queue below, where
 * it costs no table any dealing time. The queue does the existence pre-check,
 * so the lost-response case is still handled; it just is not handled while a
 * table sits idle waiting for it.
 */
async function insertHandHistoryRow(
  row: HandHistoryRow,
  origin: 'settlement' | 'retry-queue',
  bombAwardUnits: Record<string, unknown>[] = [],
  atomicCommit?: AtomicHandCommitInput
): Promise<{
  id: string | null;
  wroteUnits: boolean;
  settlementCommitted: boolean;
  stackResult?: Record<string, unknown>;
}> {
  if (atomicCommit) {
    type AtomicCommitResult = Record<string, unknown> & {
      success?: boolean;
      atomic_hand_commit?: boolean;
      history_id?: string;
      reason?: string;
      error?: unknown;
    };
    const hasLeaseInstance = typeof atomicCommit.leaseInstanceId === 'string';
    const hasLeaseGeneration = typeof atomicCommit.leaseGeneration === 'string';
    const hasPostCommitObligations = atomicCommit.postCommitObligations !== undefined;
    if (hasLeaseInstance !== hasLeaseGeneration) {
      throw new Error('atomic hand commit refused (incomplete_lease_authority)');
    }
    if (
      hasLeaseInstance &&
      (atomicCommit.leaseInstanceId!.trim().length === 0 ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          atomicCommit.leaseGeneration!
        ))
    ) {
      throw new Error('atomic hand commit refused (invalid_lease_authority)');
    }
    if (hasPostCommitObligations && !hasLeaseInstance) {
      throw new Error('atomic hand commit refused (post_commit_requires_exact_lease)');
    }
    if (hasPostCommitObligations && !atomicCommit.acceptedPostCommitFacts) {
      throw new Error('atomic hand commit refused (post_commit_facts_missing)');
    }
    // Capture the complete accepted request before yielding. Engine-owned arrays
    // may change while a response is lost; a retry must retain the original facts.
    const payload = structuredClone({
      p_table_id: row.table_id,
      p_hand_number: row.hand_number,
      p_stacks: atomicCommit.stacks,
      p_rake: atomicCommit.rake,
      p_bbj: atomicCommit.bbj,
      p_ref: atomicCommit.ref ?? null,
      p_inflow: atomicCommit.inflow ?? null,
      p_hand_row: atomicCommit.acceptedPostCommitFacts
        ? {
            ...row,
            _accepted_post_commit_facts: atomicCommit.acceptedPostCommitFacts,
          }
        : row,
      p_units: bombAwardUnits,
      ...(hasLeaseInstance
        ? {
            p_instance_id: atomicCommit.leaseInstanceId!,
            p_lease_generation: atomicCommit.leaseGeneration!,
          }
        : {}),
      ...(hasPostCommitObligations
        ? { p_post_commit_obligations: atomicCommit.postCommitObligations! }
        : {}),
    });
    let lastError = 'no response';

    // Every retry is the same idempotent transaction.  This loop exists only
    // for the ambiguous transport case: a lost HTTP response may follow a
    // committed hand.  There is no alternate writer and no per-seat fallback.
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        atomicCommit.assertLeaseAuthority?.();
        const { data, error } = await supabase.rpc('fn_ca_commit_hand_settlement', payload);
        const result = (data ?? {}) as AtomicCommitResult;
        if (!error && result.success === true && result.atomic_hand_commit === true) {
          if (hasPostCommitObligations && result.post_commit_obligations !== true) {
            throw new Error('atomic hand commit refused (missing_post_commit_receipt)');
          }
          const historyId = typeof result.history_id === 'string' ? result.history_id : '';
          if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(historyId)) {
            throw new Error(
              `atomic hand commit refused (invalid_receipt): ${JSON.stringify(result)}`
            );
          }
          const requestedHistoryId = payload.p_hand_row.id;
          if (
            typeof requestedHistoryId === 'string' &&
            historyId.toLowerCase() !== requestedHistoryId.toLowerCase()
          ) {
            throw new Error('atomic hand commit refused (receipt_identity_mismatch)');
          }
          // The authoritative transaction is already committed. Projection
          // is work-triggered and deliberately outside the dealing barrier;
          // its outbox row remains the crash/lost-notification authority.
          void wakeHandProjection().catch((err) =>
            reportError(err, 'HandProjection.commit_wake_failed', {
              handId: historyId,
              handNumber: row.hand_number,
            })
          );
          return {
            id: historyId,
            wroteUnits: bombAwardUnits.length > 0,
            settlementCommitted: true,
            stackResult: result,
          };
        }
        if (!error && result.success === false && result.reason !== 'in_flight') {
          throw new Error(
            `atomic hand commit refused (${result.reason ?? 'unknown'}): ${String(result.error ?? JSON.stringify(result))}`
          );
        }
        lastError = error?.message ?? String(result.reason ?? result.error ?? 'in_flight');
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        // A semantic refusal is deterministic. Retrying it would only hide a
        // broken invariant behind delay.
        if (/atomic hand commit refused/.test(lastError)) throw err;
      }

      if (attempt < 5) {
        await new Promise((resolve) => setTimeout(resolve, 200 * 2 ** (attempt - 1)));
      }
    }

    throw new Error(
      `[DB] authoritative hand commit failed for table ${row.table_id} hand #${row.hand_number} after 5 identical attempts: ${lastError}`
    );
  }

  /* ONE TRANSACTION WHEN THERE IS A BREAKDOWN TO KEEP (2026-09-06).
     fn_ca_insert_hand_with_awards writes the hand row and its bomb award units
     together or writes neither. Still exactly ONE request, so the amplification
     this function's header warns about is unchanged. Non-bomb hands - which is
     nearly all of them - take the plain insert and are untouched. */
  /* THE ID WE ASKED FOR, WHEN WE ASKED FOR ONE (2026-09-07). Settlement now
     mints the hand's uuid before any write (see `handId` on logHandHistory's
     params), so a successful insert whose RESPONSE we could not read is still
     a hand whose identity we know. Without this the id came only from the
     response body, and "the write landed but the answer did not" was
     indistinguishable from "the write failed" - which is how a hand ended up
     banking its rake against a null id. Null for every caller that mints
     nothing, exactly as before. */
  const minted = typeof row.id === 'string' ? row.id : null;

  if (bombAwardUnits.length > 0) {
    const { data, error } = await supabase.rpc('fn_ca_insert_hand_with_awards', {
      p_row: row,
      p_units: bombAwardUnits,
    });
    if (!error)
      return {
        id: (data as string | null) ?? minted,
        wroteUnits: true,
        settlementCommitted: true,
      };
    if (error.code === '23505') {
      /* An earlier attempt landed and its response was lost. Its units went in
         with it - but THIS call's did not, because the RPC rolled back whole,
         so wroteUnits stays false and the caller's fallback still runs. */
      const existing = await findExistingHandId(row);
      if (existing || minted)
        return { id: existing ?? minted, wroteUnits: false, settlementCommitted: true };
    }
    if (origin === 'settlement') {
      reportError(
        new Error(
          `[DB] atomic hand+award-unit insert failed for table ${row.table_id} ` +
            `hand #${row.hand_number}: ${error.message ?? String(error)}. ` +
            'Queued for background retry.'
        ),
        'logHandHistory.insert_with_awards_failed'
      );
    }
    return { id: null, wroteUnits: false, settlementCommitted: false };
  }

  const { data, error } = await supabase
    .from('hand_history')
    .insert(row)
    .select('id')
    .maybeSingle();

  if (!error) return { id: data?.id ?? minted, wroteUnits: false, settlementCommitted: true };

  // A duplicate means an earlier attempt landed after all (its response was
  // lost). PostgREST returns the Postgres SQLSTATE verbatim in the body.
  // With a minted id it can also be OUR OWN row's primary key, which is the
  // same good news said a different way.
  if (error.code === '23505') {
    const existing = await findExistingHandId(row);
    if (existing || minted)
      return { id: existing ?? minted, wroteUnits: false, settlementCommitted: true };
  }

  if (origin === 'settlement') {
    reportError(
      new Error(
        `[DB] hand_history insert failed for table ${row.table_id} ` +
          `hand #${row.hand_number}: ${error.message ?? String(error)}. ` +
          `Queued for background retry.`
      ),
      'logHandHistory.insert_failed'
    );
  }
  return { id: null, wroteUnits: false, settlementCommitted: false };
}

// ── Background retry queue ────────────────────────────────────────────────────
//
// The hot path gets ONE attempt (see insertHandHistoryRow). Everything else
// happens here, where it costs no table any dealing time. That matters: the
// outages this exists for are 30-120 second windows in which platform-wide
// hand_history writes go to zero, and a hand's payload only exists in memory at
// settlement — it cannot be reconstructed from anything later. So the choice is
// hold it or lose it, and holding it must not stall the room.
//
// This is in-process: a crash during an outage still loses the hand. It
// converts "one timeout loses a hand forever" into "only a crash during an
// outage does".

interface QueuedHand {
  row: HandHistoryRow;
  /**
   * THE BREAKDOWN RIDES WITH THE ROW (2026-09-06).
   *
   * Without this the queue was a second way to lose exactly what the atomic
   * insert exists to protect: a bomb hand that missed its first attempt was
   * replayed here with no award units, written with no award units, and the
   * settlement-side fallback that would have caught it had returned long
   * before. The hand came back; the record of which board and which player won
   * which share did not.
   */
  units: Record<string, unknown>[];
  attempts: number;
  queuedAt: number;
  bytes: number;
}

/**
 * REVIEW FIX 2026-08-20: bounded by BYTES as well as by count.
 *
 * The original bound was "2,000 payloads x ~4 KB = ~8 MB". 4 KB is the MEDIAN
 * hand. Measured against the real row shape, a 9-max PLO hand with a capped
 * raise war is ~16 KB retained, so a full queue of those is ~31 MB, not 8 —
 * and the count cap gave no warning of that. Whichever limit binds first wins.
 */
const MAX_QUEUE = 2_000;
const MAX_QUEUE_BYTES = 24 * 1024 * 1024;
const MAX_QUEUE_ATTEMPTS = 20;
/**
 * REVIEW FIX 2026-08-20: 50 every 20s is a ceiling of 150 hands/min. The
 * platform averages 166/min and peaks at 217/min — the drain could not outrun
 * its own inflow, so a long outage would grow the queue faster than it drained
 * it even after service returned. 200 every 5s with 8-way concurrency is
 * ~2,400/min, an order of magnitude of headroom.
 */
const DRAIN_INTERVAL_MS = 5_000;
const DRAIN_BATCH = 200;
const DRAIN_CONCURRENCY = 8;
/** After a fully failed pass, wait longer before hammering a service that is down. */
const MAX_BACKOFF_SKIPS = 12; // 12 x 5s = 60s ceiling

const pendingHands: QueuedHand[] = [];
let pendingBytes = 0;
let inFlight = 0;
let droppedForCapacity = 0;
let drainTimer: NodeJS.Timeout | null = null;
let drainPromise: Promise<DrainSummary> | null = null;
let consecutiveFailedPasses = 0;
let skipsRemaining = 0;

export interface DrainSummary {
  scanned: number;
  written: number;
  stillPending: number;
  exhausted: number;
  /** Recovered hands whose rake row could not be linked (it did not exist yet). */
  unlinked: number;
  /** True when another drain was already running and this call joined it. */
  joined: boolean;
}

const emptySummary = (): DrainSummary => ({
  scanned: 0,
  written: 0,
  stillPending: pendingHands.length + inFlight,
  exhausted: 0,
  unlinked: 0,
  joined: false,
});

/** Cheap size estimate. Exact enough to bound memory; not worth JSON.stringify. */
function estimateBytes(row: HandHistoryRow): number {
  let n = 512; // scalars + object overhead
  for (const key of ['actions', 'players', 'winners', 'hole_cards', 'board'] as const) {
    const v = row[key];
    if (Array.isArray(v)) n += v.length * 180;
    else if (v && typeof v === 'object') n += Object.keys(v).length * 180;
  }
  return n;
}

function enqueueHandHistory(row: HandHistoryRow, units: Record<string, unknown>[] = []): void {
  if (row.hand_number < GLOBAL_HAND_NUMBER_FLOOR) {
    // Not reachable today — allocateGlobalHandNumber refuses to deal rather than
    // return a number below the floor — but a silent `return` here would be a
    // per-hand data loss with no signal if that ever regresses.
    reportError(
      new Error(
        `[DB] hand_history for table ${row.table_id} hand #${row.hand_number} cannot be ` +
          `queued: hand numbers below ${GLOBAL_HAND_NUMBER_FLOOR} are not globally unique, ` +
          `so a retry could duplicate the hand. The hand has no history row.`
      ),
      'logHandHistory.below_global_floor'
    );
    return;
  }

  // REVIEW FIX 2026-08-20: deep-copy before holding it. `row.actions` and
  // `row.winners` alias the engine's live currentHandActions/currentHandWinners
  // arrays. Today dealHand REASSIGNS those rather than clearing in place, so
  // this is safe — but one `.length = 0` anywhere in the engine would silently
  // empty every queued hand, and the failure would be invisible. Only runs on
  // the failure path, so it costs nothing in normal operation.
  const held: HandHistoryRow = structuredClone(row);
  const bytes = estimateBytes(held);

  while (
    pendingHands.length > 0 &&
    (pendingHands.length >= MAX_QUEUE || pendingBytes + bytes > MAX_QUEUE_BYTES)
  ) {
    const dropped = pendingHands.shift()!;
    pendingBytes -= dropped.bytes;
    droppedForCapacity++;
    if (droppedForCapacity % 100 === 1) {
      reportError(
        new Error(
          `[DB] hand_history retry queue is full (${pendingHands.length} rows, ` +
            `${Math.round(pendingBytes / 1024)} KB); ${droppedForCapacity} hand(s) dropped. ` +
            `hand_history has been unwritable for a sustained period.`
        ),
        'logHandHistory.queue_overflow'
      );
    }
  }

  pendingHands.push({
    row: held,
    units: structuredClone(units),
    attempts: 0,
    queuedAt: Date.now(),
    bytes,
  });
  pendingBytes += bytes;
}

/**
 * A hand written late still has to be linked to the rake row that was banked
 * for it at settlement time, or the money stays unattributable — which is the
 * financial_alerts signal that started this investigation.
 * atomic_distribute_rake stamps metadata->>'hand_number', so the link is exact.
 *
 * Returns the number of rake rows linked (0 or 1). Zero is NOT an error: a
 * tournament hand or a zero-rake hand has no rake row, and during an outage the
 * rake write can fail too — FeeReconciler creates that row later, and it
 * resolves the hand id itself at that point precisely because this call
 * cannot (see FeeReconciler.resolveHandId).
 */
async function relinkRakeRecord(row: HandHistoryRow, handId: string): Promise<number> {
  const { data, error } = await supabase.rpc('fn_relink_rake_record_to_hand', {
    p_table_id: row.table_id,
    p_hand_number: row.hand_number,
    p_hand_id: handId,
  });
  if (error) {
    reportError(error, 'logHandHistory.relink_rake_failed');
    return 0;
  }
  return typeof data === 'number' ? data : 0;
}

/**
 * Notified when a hand the queue was holding finally lands.
 *
 * REVIEW FIX 2026-08-20: `hand_history_saved` was emitted only on the in-line
 * path. A hand recovered by this queue never got one, so the client fell back
 * to its "my most recent hand" lookup — and for a recovered hand that lookup is
 * GUARANTEED to return the wrong hand, because later hands have landed since.
 * The event exists precisely to remove that race; it has to fire here too.
 *
 * A module-level hook rather than a per-entry closure: the queue can hold a
 * payload for minutes, and capturing an engine callback per hand would keep
 * dead tables alive and fire into torn-down state.
 */
let recoveredHandler:
  | ((info: { tableId: string; handNumber: number; handId: string }) => void)
  | null = null;

export function onHandHistoryRecovered(
  fn: ((info: { tableId: string; handNumber: number; handId: string }) => void) | null
): void {
  recoveredHandler = fn;
}

async function processQueuedHand(entry: QueuedHand, summary: DrainSummary): Promise<void> {
  entry.attempts++;
  let handId = await findExistingHandId(entry.row);
  if (!handId)
    handId = (await insertHandHistoryRow(entry.row, 'retry-queue', entry.units ?? [])).id;

  if (handId) {
    summary.written++;
    if (recoveredHandler) {
      try {
        recoveredHandler({
          tableId: entry.row.table_id,
          handNumber: entry.row.hand_number,
          handId,
        });
      } catch (err) {
        reportError(err, 'logHandHistory.recovered_handler_failed');
      }
    }
    // Only cash hands that actually took rake can have a row to link.
    const rake = Number(entry.row.rake_amount ?? 0);
    const bbj = Number(entry.row.bbj_amount ?? 0);
    if (!entry.row.tournament_id && (rake > 0 || bbj > 0)) {
      if ((await relinkRakeRecord(entry.row, handId)) === 0) summary.unlinked++;
    }
    return;
  }

  if (entry.attempts >= MAX_QUEUE_ATTEMPTS) {
    summary.exhausted++;
    reportError(
      new Error(
        `[DB] hand_history for table ${entry.row.table_id} hand #${entry.row.hand_number} ` +
          `gave up after ${entry.attempts} attempts over ` +
          `${Math.round((Date.now() - entry.queuedAt) / 1000)}s. The hand has no history row.`
      ),
      'logHandHistory.retry_exhausted'
    );
    return;
  }

  requeue(entry);
}

function requeue(entry: QueuedHand): void {
  pendingHands.push(entry);
  pendingBytes += entry.bytes;
}

/**
 * Drain the queue.
 *
 * @param deadlineMs absolute wall clock after which no NEW entry is started.
 *        Entries not started are left queued, untouched.
 *
 * REVIEW FIX 2026-08-20, three defects in the first version:
 *   1. it returned a no-op summary when a drain was already running, so
 *      GameServer.stop()'s flush loop saw "no progress" and gave up
 *      immediately — the 6s budget was never used. Concurrent callers now JOIN
 *      the in-flight drain instead.
 *   2. it spliced a batch off the queue and had no try/catch, so a single throw
 *      from any await discarded every remaining entry in that batch. Each entry
 *      is now individually guarded and re-queued on throw.
 *   3. its deadline was only checked BETWEEN whole passes, so "never block a
 *      shutdown for more than ~6s" was not true of a pass that itself took
 *      minutes. It is checked per entry now.
 */
export function drainHandHistoryQueue(deadlineMs?: number): Promise<DrainSummary> {
  if (drainPromise) {
    return drainPromise.then((s) => ({ ...s, joined: true }));
  }
  if (pendingHands.length === 0) return Promise.resolve(emptySummary());

  drainPromise = (async (): Promise<DrainSummary> => {
    const summary = emptySummary();
    const batch = pendingHands.splice(0, DRAIN_BATCH);
    for (const e of batch) pendingBytes -= e.bytes;
    inFlight = batch.length;
    summary.scanned = batch.length;

    let next = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        if (deadlineMs !== undefined && Date.now() >= deadlineMs) return;
        const i = next++;
        if (i >= batch.length) return;
        const entry = batch[i];
        try {
          await processQueuedHand(entry, summary);
        } catch (err) {
          // Never lose the payload to an unexpected throw.
          reportError(err, 'logHandHistory.drain_entry_failed');
          requeue(entry);
        } finally {
          inFlight--;
        }
      }
    };

    try {
      await Promise.all(
        Array.from({ length: Math.min(DRAIN_CONCURRENCY, batch.length) }, () => worker())
      );
    } finally {
      // Anything the deadline stopped us from starting goes back untouched.
      for (let i = next; i < batch.length; i++) {
        requeue(batch[i]);
        inFlight--;
      }
      if (inFlight < 0) inFlight = 0;
      summary.stillPending = pendingHands.length + inFlight;
    }

    // Back off when a whole pass achieved nothing — the service is down, and
    // hammering it is how an outage gets extended rather than ridden out.
    if (summary.scanned > 0 && summary.written === 0) {
      consecutiveFailedPasses++;
      skipsRemaining = Math.min(consecutiveFailedPasses, MAX_BACKOFF_SKIPS);
    } else if (summary.written > 0) {
      consecutiveFailedPasses = 0;
      skipsRemaining = 0;
    }
    return summary;
  })();

  return drainPromise.finally(() => {
    drainPromise = null;
  });
}

export function startHandHistoryRetry(): void {
  if (drainTimer) return;
  drainTimer = setInterval(() => {
    if (skipsRemaining > 0) {
      skipsRemaining--;
      return;
    }
    void drainHandHistoryQueue()
      .then((s) => {
        if (s.written > 0 || s.exhausted > 0 || s.unlinked > 0) {
          console.log(
            `[HandHistoryRetry] wrote ${s.written}, exhausted ${s.exhausted}, ` +
              `${s.unlinked} awaiting a rake row, ${s.stillPending} still queued`
          );
        }
      })
      .catch((err) => reportError(err, 'logHandHistory.drain_failed'));
  }, DRAIN_INTERVAL_MS);
  drainTimer.unref?.();
}

export function stopHandHistoryRetry(): void {
  if (drainTimer) clearInterval(drainTimer);
  drainTimer = null;
}

/**
 * Queue depth INCLUDING the batch currently in flight.
 *
 * REVIEW FIX 2026-08-20: this used to return only pendingHands.length, so while
 * a drain held up to a full batch in memory the depth read as 0 — which made
 * GameServer.stop() skip its flush entirely and under-report the loss alarm.
 */
export function handHistoryQueueDepth(): number {
  return pendingHands.length + inFlight;
}

/** Test/observability hook: bytes currently held. */
export function handHistoryQueueBytes(): number {
  return pendingBytes;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Bible V8 §2.18 — the four tiers, DERIVED
// ═══════════════════════════════════════════════════════════════════════════════

/** A row as it is actually stored in hand_history (snake_case). */
export interface StoredHandHistoryRow {
  id?: string;
  table_id: string;
  tournament_id?: string | null;
  hand_number: number;
  game_variant: string;
  small_blind: number;
  big_blind: number;
  pot_size: number;
  rake_amount: number;
  bbj_amount?: number | null;
  community_cards?: string[] | null;
  board?: unknown;
  hole_cards?: Record<string, { rank: string; suit: string }[]> | null;
  button_seat?: number | null;
  started_at?: string | null;
  ended_at?: string | null;
  created_at?: string | null;
  winners?:
    | {
        userId: string;
        amount: number;
        potIndex?: number;
        hand?: { name: string; ranking: number };
      }[]
    | null;
  players?: { userId: string; username: string; seat: number; stack: number }[] | null;
  actions?:
    | {
        seat: number;
        userId?: string;
        action: string;
        amount?: number;
        timestamp?: number;
        stage: string;
      }[]
    | null;
}

/**
 * Materialise the 4-tier hand-history package from a STORED hand_history row.
 *
 * This is the code that used to run on every settlement and write four extra
 * JSONB columns. It runs on demand instead, because every tier is a pure
 * function of what the row already stores:
 *
 *   Tier 1 raw_events       <- actions (re-keyed with a sequence number and a
 *                              resolved userId)
 *   Tier 2 audit_log        <- the row's own scalar columns, re-packed
 *   Tier 3 player_summaries <- players + winners + actions
 *   Tier 4 dispute_review   <- the other three, plus the board, the revealed
 *                              holdings and the button
 *
 * Storing them cost three redundant copies of the largest payload on the
 * platform (hand_history takes 238,583 rows and roughly a gigabyte a day) and
 * added no information.
 *
 * REVIEW FIXES 2026-08-20 — the first version was dead code AND wrong in three
 * ways, which mattered because "the tiers are derivable" is the stated reason
 * for not applying supabase/migrations/20260417_hand_history_4tier.sql:
 *
 *   1. It took the SETTLEMENT input shape (camelCase: tableId, handNumber,
 *      communityCards) while its own doc said to call it with a row read back
 *      out of hand_history — which is snake_case. There was no adapter, so it
 *      could not actually be called the documented way at all. It now takes the
 *      stored row.
 *   2. It called the stack `startStack`. It is the ENDING stack: settlement
 *      mutates SeatedPlayer.stack in place (bounties, payouts) BEFORE
 *      postHandTasks runs, and that same array is what is persisted. Dispute
 *      tooling trusting `startStack` would have been wrong on every hand. It is
 *      `stackAfterSettlement` now, and the starting stack is reconstructed
 *      where the data allows it.
 *   3. It called the winner's award `netResult`. It is gross — the player's own
 *      contributions were never subtracted, and every loser read 0 rather than
 *      their loss. It is `amountWon` now, with `contributed` and `net` derived
 *      from the action log so the honest number is available too.
 *
 * `contributed` is reconstructed per street from the action log: bet/raise and
 * all-in amounts are the raise-TO level for that street, so a player's street
 * contribution is the maximum level they reached on it, while a call adds
 * chips directly. Blinds and antes are NOT in the action log, so this
 * undercounts by the forced money — `contributedIncludesBlinds: false` says so
 * rather than quietly pretending otherwise.
 */
export function buildHandHistoryTiers(hand: StoredHandHistoryRow) {
  const players = hand.players ?? [];
  const actions = hand.actions ?? [];
  const winners = hand.winners ?? [];
  const board = hand.community_cards ?? [];

  const rawEvents = actions.map((a, idx) => ({
    seq: idx,
    seat: a.seat,
    userId: a.userId || players.find((p) => p.seat === a.seat)?.userId || 'unknown',
    action: a.action,
    amount: a.amount ?? 0,
    stage: a.stage,
    timestamp: a.timestamp ?? 0,
  }));

  const auditLog = {
    table_id: hand.table_id,
    tournament_id: hand.tournament_id ?? null,
    hand_number: hand.hand_number,
    game_variant: hand.game_variant,
    blinds: { sb: hand.small_blind, bb: hand.big_blind },
    pot_size: hand.pot_size,
    rake: hand.rake_amount,
    bbj_fee: hand.bbj_amount ?? 0,
    board,
    button_seat: hand.button_seat ?? null,
    player_count: players.length,
    action_count: actions.length,
    went_to_showdown: Object.keys(hand.hole_cards ?? {}).length > 0,
    started_at: hand.started_at ?? null,
    ended_at: hand.ended_at ?? null,
    created_at: hand.created_at ?? null,
  };

  /** Chips a seat put in voluntarily, per the action log (excludes blinds/antes). */
  const contributedBySeat = new Map<number, number>();
  const levelByStreet = new Map<string, number>(); // `${seat}:${stage}` -> highest level
  for (const a of actions) {
    const key = `${a.seat}:${a.stage}`;
    const amt = a.amount ?? 0;
    if (amt <= 0) continue;
    if (a.action === 'bet' || a.action === 'raise' || a.action === 'all_in') {
      // These carry the raise-TO level for the street; take the highest.
      levelByStreet.set(key, Math.max(levelByStreet.get(key) ?? 0, amt));
    } else if (a.action === 'call') {
      // A call records the chips actually added.
      levelByStreet.set(key, (levelByStreet.get(key) ?? 0) + amt);
    }
  }
  for (const [key, level] of levelByStreet) {
    const seat = Number(key.split(':')[0]);
    contributedBySeat.set(
      seat,
      Math.round(((contributedBySeat.get(seat) ?? 0) + level) * 100) / 100
    );
  }

  const playerSummaries = players.map((p) => {
    const winRecord = winners.find((w) => w.userId === p.userId);
    const playerActions = actions.filter((a) => a.seat === p.seat || a.userId === p.userId);
    const amountWon = winRecord ? winRecord.amount : 0;
    const contributed = contributedBySeat.get(p.seat) ?? 0;
    return {
      userId: p.userId,
      username: p.username,
      seat: p.seat,
      /**
       * The stack AFTER settlement — payouts and bounties are already applied.
       * `hand_history.players[].stack` has always meant this; only the old
       * label said otherwise.
       */
      stackAfterSettlement: p.stack,
      /** Reconstructed: what they held before the pot was awarded. */
      stackBeforePayout: Math.round((p.stack - amountWon) * 100) / 100,
      amountWon,
      contributed,
      net: Math.round((amountWon - contributed) * 100) / 100,
      contributedIncludesBlinds: false,
      handName: winRecord?.hand?.name ?? null,
      handRanking: winRecord?.hand?.ranking ?? null,
      revealedCards: hand.hole_cards?.[p.userId] ?? null,
      actionCount: playerActions.length,
      folded: playerActions.some((a) => a.action === 'fold'),
      wentAllIn: playerActions.some((a) => a.action === 'all_in'),
    };
  });

  return {
    raw_events: rawEvents,
    audit_log: auditLog,
    player_summaries: playerSummaries,
    dispute_review: {
      raw_events: rawEvents,
      audit_log: auditLog,
      player_summaries: playerSummaries,
      community_cards: board,
      revealed_hole_cards: hand.hole_cards ?? {},
      pot_breakdown: winners,
      button_seat: hand.button_seat ?? null,
      integrity_hash: `${hand.table_id}:${hand.hand_number}`,
    },
  };
}
