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
import { UUID_SHAPE } from '../../lib/uuidShape.js';

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

export interface TournamentStackProof {
  written?: unknown;
  tournament_id?: unknown;
  tournament_players_synced?: unknown;
  tournament_player_count?: unknown;
  tournament_player_user_ids?: unknown;
  tournament_player_chips?: unknown;
}

/**
 * One immutable atomic-hand promise owns the complete schema-reload window.
 * The 41-second sleep budget outlives the measured 28-second PostgREST reload;
 * thirteen 15-second request deadlines plus this budget still fit inside the
 * five-minute terminal-settlement barrier. No timer or successor engine ever
 * receives the accepted hand payload.
 */
export const HAND_COMMIT_RETRY_DELAYS_MS: readonly number[] = Object.freeze([
  200, 400, 800, 1_600, 3_000, 5_000, 5_000, 5_000, 5_000, 5_000, 5_000, 5_000,
]);

/**
 * A tournament hand is not committed until the same transaction proves that
 * every live seat target is mirrored into tournament_players.  Keep this
 * verifier in the active atomic-hand path (not the retired standalone stack helper)
 * so a rolling deploy cannot accept an older, partial database receipt.
 */
export function tournamentStackProofIsExact(
  proof: TournamentStackProof,
  expectedTournamentId: string,
  expectedPlayerIds: readonly string[]
): boolean {
  const expectedUsers = expectedPlayerIds.map((userId) => userId.toLowerCase()).sort();
  if (new Set(expectedUsers).size !== expectedPlayerIds.length) return false;

  const returnedUsers = Array.isArray(proof.tournament_player_user_ids)
    ? proof.tournament_player_user_ids.map((userId) =>
        typeof userId === 'string' ? userId.toLowerCase() : null
      )
    : [];
  const returnedChips = Array.isArray(proof.tournament_player_chips)
    ? proof.tournament_player_chips
    : [];
  const written =
    proof.written && typeof proof.written === 'object' && !Array.isArray(proof.written)
      ? (proof.written as Record<string, unknown>)
      : null;
  if (!written) return false;

  const writtenByUser = new Map(
    Object.entries(written).map(([userId, chips]) => [userId.toLowerCase(), Number(chips)])
  );
  const writtenUsers = [...writtenByUser.keys()].sort();
  const chipRows = returnedChips.map((row) => {
    if (!row || typeof row !== 'object') return null;
    const userId = (row as { user_id?: unknown }).user_id;
    const chips = Number((row as { chips?: unknown }).chips);
    if (typeof userId !== 'string' || !Number.isSafeInteger(chips) || chips < 0) return null;
    return { userId: userId.toLowerCase(), chips };
  });

  return (
    String(proof.tournament_id).toLowerCase() === expectedTournamentId.toLowerCase() &&
    proof.tournament_players_synced === true &&
    Number(proof.tournament_player_count) === expectedUsers.length &&
    returnedUsers.length === expectedUsers.length &&
    returnedUsers.every((userId, index) => userId === expectedUsers[index]) &&
    writtenUsers.length === expectedUsers.length &&
    writtenUsers.every((userId, index) => userId === expectedUsers[index]) &&
    chipRows.length === expectedUsers.length &&
    chipRows.every(
      (row, index) =>
        row !== null &&
        row.userId === expectedUsers[index] &&
        row.chips === writtenByUser.get(row.userId)
    )
  );
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
 * The four tiers are derived rather than stored: all four are pure functions
 * of the canonical columns, and buildHandHistoryTiers() materialises them on
 * demand without adding a second persistence path.
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
  /** Exact tournament pot/half awards; merged winner totals lose later pots. */
  perPotAwards?: {
    userId: string;
    amount: number;
    potIndex: number;
    low: boolean;
    board?: number;
  }[];

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
   * Passed here, they go through fn_ca_commit_hand_settlement in the same
   * transaction as the history row, stacks and projection outbox, so the
   * breakdown can no longer be the half that goes missing.
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
   * this row's identity was decided by the INSERT. Settlement needs that
   * identity before its authoritative transaction because every downstream
   * record keys on it. The accepted hand now carries one UUID into the atomic
   * settlement call, so no history-only writer can mint a competing identity.
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
   * (CLAUDE.md 10.12): the hand carries one identity from settlement onward.
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
   * Server-authored Daily Missions facts for this hand. The authoritative
   * transaction persists them with the hand before projection is dispatched.
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
   * The authoritative hand commit. The hand row is never an independent
   * best-effort insert: stacks, the row, tournament chip mirror, bomb units,
   * immutable bust generation and projection outbox all go through
   * fn_ca_commit_hand_settlement in one PostgreSQL transaction.
   */
  atomicCommit: AtomicHandCommitInput;
}): Promise<{
  handId: string;
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
    pots: params.pots?.length
      ? params.pots.map((pot) => ({
          ...pot,
          ...(params.perPotAwards?.length
            ? {
                awards: params.perPotAwards
                  .filter((award) => award.potIndex === pot.index)
                  .map((award) => ({
                    userId: award.userId,
                    amount: award.amount,
                    potIndex: award.potIndex,
                    low: award.low,
                    ...(award.board == null ? {} : { board: award.board }),
                  })),
              }
            : {}),
        }))
      : null,
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
  const inserted = await insertHandHistoryRow(row, bombUnits, params.atomicCommit);
  const handId = inserted.id;

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
        params.atomicCommit.leaseGeneration ?? 'unleased',
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

  return {
    handId,
    settlementCommitted: inserted.settlementCommitted,
    stackResult: inserted.stackResult,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// THE WRITE ITSELF — one idempotent atomic authority
// ═══════════════════════════════════════════════════════════════════════════════

type HandHistoryRow = Record<string, unknown> & { hand_number: number; table_id: string };

/**
 * Commit one accepted hand. Every retry reuses an identical, deeply captured
 * request against the database's idempotent transaction. There is no
 * history-only writer and no process-local recovery owner.
 */
async function insertHandHistoryRow(
  row: HandHistoryRow,
  bombAwardUnits: Record<string, unknown>[],
  atomicCommit: AtomicHandCommitInput
): Promise<{
  id: string;
  settlementCommitted: boolean;
  stackResult?: Record<string, unknown>;
}> {
  type AtomicCommitResult = TournamentStackProof &
    Record<string, unknown> & {
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
      !UUID_SHAPE.test(atomicCommit.leaseGeneration!))
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
  for (let attempt = 0; attempt <= HAND_COMMIT_RETRY_DELAYS_MS.length; attempt++) {
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
        if (
          typeof row.tournament_id === 'string' &&
          !tournamentStackProofIsExact(
            result,
            row.tournament_id,
            atomicCommit.stacks.map((stack) => stack.user_id)
          )
        ) {
          throw new Error('atomic hand commit refused (tournament_stack_proof_invalid)');
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

    const delayMs = HAND_COMMIT_RETRY_DELAYS_MS[attempt];
    if (delayMs !== undefined) {
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw new Error(
    `[DB] authoritative hand commit failed for table ${row.table_id} hand #${row.hand_number} after ${HAND_COMMIT_RETRY_DELAYS_MS.length + 1} identical attempts: ${lastError}`
  );
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
