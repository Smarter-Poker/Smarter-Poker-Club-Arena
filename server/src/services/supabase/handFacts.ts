/**
 * ca_hand_facts writer — the durable per-human-per-hand stats fact row.
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * `hand_history` is purged after 7 days, stores hole cards only for players
 * who reached showdown (32.5% of hands), and stores no all-in equity at all.
 * Its `actions` JSON also omits blinds and antes, so every net figure
 * reconstructed from it undercounts by the forced money — `buildHandHistoryTiers`
 * says so honestly with `contributedIncludesBlinds: false`.
 *
 * None of that is recoverable after the fact. So the stats page cannot show a
 * player their own folded holdings, their exact result, whether they ran above
 * or below all-in EV, or who has been taking chips off them — not because the
 * engine does not know, but because the engine knew and then threw it away.
 *
 * This module catches those values at settlement, while they are still in
 * memory, and writes one durable row per HUMAN seat per hand. Horses get no
 * rows: they are 99.97% of hand volume and nobody will ever read their stats
 * page, which is what keeps this table roughly four orders of magnitude
 * smaller than hand_history and lets it be retained indefinitely.
 *
 * DESIGN CONSTRAINT: this file and its two call sites are deliberately small
 * and self-contained. HandController.ts (79KB), ServerTableEngineBase.ts
 * (85KB) and ServerTableEngineRunout.ts (66KB) are all above the deploy
 * channel's per-file ceiling, so ZERO edits are made to any of them.
 *
 * SECURITY: hole_cards written here include cards that never went to showdown.
 * The table's RLS policy (`user_id = auth.uid()`) is the only thing keeping one
 * player from reading another's mucked hand. Any SECURITY DEFINER RPC over this
 * table must assert the caller's identity — DEFINER bypasses RLS.
 */

import { supabase } from './client.js';
import { reportError } from '../errorReporter.js';
import { allocateWeightedShareCents } from '../rakeAllocation.js';

// ═══════════════════════════════════════════════════════════════════════════
// 1. ALL-IN EQUITY EVIDENCE
// ═══════════════════════════════════════════════════════════════════════════
//
// The engine marks exactly one existing action per active player at the
// ALL_IN_RUNOUT boundary, then attaches the first computed equity to that same
// object. The action array commits atomically with hand_history. There is no
// process-local cache to lose on a crash, handoff, failed fact write, or late
// event broadcast; a missing equity value remains an explicit durable gap.

// ═══════════════════════════════════════════════════════════════════════════
// 1b. RUN-IT-TWICE LIFECYCLE TELEMETRY
// ═══════════════════════════════════════════════════════════════════════════
//
// Dan 2026-08-21, from live play: "RUN IT TWICE DOESN'T ACTUALLY WORK, IT
// DOESN'T RUN THE BOARD OR TURN OR RIVER TWICE, IT DOESN'T AWARD A POT TO THE
// WINNERS OR ANYTHING, AND THERE IS NO OPTION TO RUN IT THREE TIMES."
//
// Every link in that chain reads as correct on inspection - the offer gate is
// permissive, the chooser is pre-seeded into acceptedBy, the horses answer,
// the modal renders a 3-run button when maxRuns is 3, and the engine suites
// pass. And yet it does not happen. The reason nobody can close that gap is
// that a RIT hand leaves NO TRACE: currentHandRitBoards reaches the chip
// verifier and stops, hand_history has no RIT column, and community_cards2
// belongs to double-board bomb pots. You cannot tell a hand that ran twice
// from one that did not, so "did the offer even fire?" has never been
// answerable.
//
// This makes it answerable. Every RIT event that passes through the hub is
// recorded, so ONE live all-in says exactly where the chain stops:
//   rit_offer            -> the engine offered, and to whom
//   rit_chooser_decided  -> the chooser answered, and with how many runs
//   rit_resolved         -> it actually ran, with the board count
// No row for a hand with a 2+ way all-in means the offer never fired at all.
//
// Same shape as the equity capture above: intercepted in TableStateHub (a
// small file) rather than in Runout.ts, which is over the deploy channel's
// per-file ceiling. Fire-and-forget, fully swallowed - telemetry must never
// affect a hand.

const RIT_EVENT_TYPES = new Set([
  'rit_offer',
  'rit_chooser_decided',
  'rit_accepted',
  'rit_declined',
  // 'rit_resolved' is the RunItTwiceEngine's INTERNAL event name. What actually
  // travels over the hub when a multi-board hand settles is 'rit_result'
  // (ServerTableEngineRunout). Listening only for 'rit_resolved' meant every
  // resolution was invisible: on 2026-08-21 the table showed 17 offers, 17
  // chooser decisions and ZERO resolutions, which reads as "RIT never
  // completes" when in fact all 17 hands had settled across multiple boards.
  // Both names are accepted so neither rename can blind this again.
  'rit_resolved',
  'rit_result',
  /**
   * A hand that ran multiple boards WITHOUT anyone being asked (2026-08-25).
   *
   * `run_it_mode` mandatory_twice / mandatory_three skip the offer entirely —
   * there is no chooser to elect and nothing to time out, so a mandatory hand
   * emits no rit_offer and no rit_chooser_decided. Without a name of its own
   * it would be a multi-board resolution with no antecedent, which reads in
   * the telemetry exactly like the 2026-08-21 defect this file exists to stop
   * (results with no offers). It is also the only way to tell a table where
   * the host compelled the runs from one where the players agreed to them.
   */
  'rit_mandatory',
  // The outcome that produces ONE board: the chooser picking 1, an all-in
  // opponent declining, or nobody answering in time. Added 2026-08-23 with the
  // event itself. Recording it is the whole point of having it — a single-run
  // outcome used to be indistinguishable, in the data as well as on screen,
  // from a Run It Twice offer that never resolved at all.
  'rit_single_run',
  // POKERBROS PARITY 2026-08-26: consent progress on the wire. Every accept
  // broadcasts rit_response_update (live checkmarks in the Risk Management
  // panel), and unanimous consent broadcasts rit_all_accepted (the "players
  // have accepted running multi-times" banner). Named here the day they were
  // added so RitTelemetryNames keeps its every-emitted-name-is-captured law.
  'rit_response_update',
  'rit_all_accepted',
  'insurance_offers',
]);

export function captureRitEvent(tableId: string, payload: Record<string, unknown>): void {
  try {
    const type = typeof payload?.type === 'string' ? payload.type : '';
    if (!tableId || !RIT_EVENT_TYPES.has(type)) return;

    // Promise.resolve() wraps the builder: PostgrestFilterBuilder is a
    // THENABLE, not a Promise, so it has no .catch of its own - and the
    // no-unhandled-rejection guard requires one on every fire-and-forget.
    // Same shape EngineWebSocketServer.logConnectionAudit uses.
    void Promise.resolve(
      supabase.from('action_audit_logs').insert({
        action_type: `engine_${type}`,
        user_id: (payload.chooserPlayerId as string) || (payload.player_id as string) || null,
        details: {
          table_id: tableId,
          hand_number: payload.hand_number ?? null,
          chooser: payload.chooserPlayerId ?? null,
          all_players: payload.allPlayerIds ?? null,
          max_runs: payload.maxRuns ?? null,
          chosen_runs: payload.chosenRuns ?? null,
          pot: payload.pot ?? null,
          offers: Array.isArray(payload.offers) ? (payload.offers as unknown[]).length : null,
        },
      })
    ).catch(() => {
      /* a telemetry insert must never surface at the table */
    });
  } catch {
    /* never affect gameplay */
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. PURE HELPERS (exported for unit test — these are where the bugs live)
// ═══════════════════════════════════════════════════════════════════════════

const RANK_ORDER: Record<string, number> = {
  '2': 2,
  '3': 3,
  '4': 4,
  '5': 5,
  '6': 6,
  '7': 7,
  '8': 8,
  '9': 9,
  T: 10,
  J: 11,
  Q: 12,
  K: 13,
  A: 14,
};

/**
 * Canonical 169-grid key for a two-card holding: 'AA', 'AKs', '72o'.
 *
 * Returns null for anything that is not exactly two cards, which is how PLO
 * (4-6 cards) opts out: a 13x13 grid cannot represent an Omaha starting hand,
 * so `hand_class` stays NULL and the heatmap shows a categorical breakdown for
 * those variants instead of a grid full of nonsense.
 */
export function computeHandClass(cards: Array<{ rank?: string; suit?: string }>): string | null {
  if (!Array.isArray(cards) || cards.length !== 2) return null;
  const [a, b] = cards;
  if (!a?.rank || !b?.rank || !a?.suit || !b?.suit) return null;

  const ra = RANK_ORDER[a.rank];
  const rb = RANK_ORDER[b.rank];
  if (!ra || !rb) return null;

  const hi = ra >= rb ? a : b;
  const lo = ra >= rb ? b : a;

  if (hi.rank === lo.rank) return `${hi.rank}${lo.rank}`;
  return `${hi.rank}${lo.rank}${hi.suit === lo.suit ? 's' : 'o'}`;
}

const LATE_NAMES = ['CO', 'HJ', 'LJ'];
const EARLY_NAMES = ['UTG', 'UTG+1'];

/**
 * Position from the AUTHORITATIVE button seat and the set of seats actually
 * dealt in — not from preflop action order.
 *
 * This matters: fn_process_hand_position_stats infers position from who acted
 * first, which silently drops any player who folded without acting, so its
 * numbers are biased toward players who played back. Deriving from the button
 * is exact for everyone dealt a hand.
 *
 * Vocabulary is a superset of ca_player_stats_full's (BTN SB BB UTG UTG+1 MP
 * CO), adding LJ and HJ at larger tables. '+1' spelling matches the existing
 * RPC deliberately so the two never disagree on a shared position name.
 */
export function derivePosition(seat: number, buttonSeat: number, dealtSeats: number[]): string {
  const seats = [...new Set(dealtSeats)].sort((x, y) => x - y);
  const n = seats.length;
  if (n === 0) return 'UNKNOWN';
  if (n === 1) return 'BTN';

  const myIdx = seats.indexOf(seat);
  if (myIdx < 0) return 'UNKNOWN';

  // The button may have folded/left; fall back to the next occupied seat.
  let btnIdx = seats.indexOf(buttonSeat);
  if (btnIdx < 0) {
    btnIdx = seats.findIndex((s) => s > buttonSeat);
    if (btnIdx < 0) btnIdx = 0;
  }

  const offset = (myIdx - btnIdx + n) % n;

  // Heads-up: the button posts the small blind and there is no separate SB seat.
  if (n === 2) return offset === 0 ? 'BTN' : 'BB';

  if (offset === 0) return 'BTN';
  if (offset === 1) return 'SB';
  if (offset === 2) return 'BB';

  const fromButton = n - offset; // 1 = CO, 2 = HJ, 3 = LJ
  const fromBB = offset - 2; // 1 = UTG, 2 = UTG+1

  if (fromButton <= LATE_NAMES.length && fromButton <= fromBB) {
    return LATE_NAMES[fromButton - 1];
  }
  if (fromBB <= EARLY_NAMES.length) {
    return EARLY_NAMES[fromBB - 1];
  }
  return 'MP';
}

export interface HandAction {
  seat: number;
  userId?: string;
  action: string;
  amount?: number;
  timestamp?: number;
  stage: string;
  allInRunout?: true;
  allInRunoutStreet?: 'preflop' | 'flop' | 'turn';
  allInEquity?: number;
  /** Exact side-pot-aware expected chips returned at the runout boundary. */
  allInEvReturned?: number;
  /** Reproducible worker evidence stored with the same atomic action row. */
  allInEquityVersion?: string;
  allInEquityExact?: boolean;
  allInEquityRunouts?: number;
  allInEquitySeed?: number;
  allInEquityInputHash?: string;
}

export interface FlowFlags {
  vpip: boolean;
  pfr: boolean;
  three_bet: boolean;
  four_bet: boolean;
  faced_three_bet: boolean;
  folded_to_three_bet: boolean;
  had_cbet_flop_opp: boolean;
  cbet_flop: boolean;
  saw_flop: boolean;
  went_to_showdown: boolean;
  won_at_showdown: boolean;
  aggressive_actions: number;
  passive_actions: number;
  was_all_in: boolean;
  all_in_street: string | null;
}

/**
 * Whether a settlement row owes an all-in equity figure. This reads only the
 * marker frozen into hand_history.actions; no process-local observation can
 * become authority for a durable stat.
 */
export function allInEquityIsOwed(input: {
  wentToShowdown: boolean;
  runoutStreet: string | null;
}): boolean {
  if (!input.wentToShowdown) return false;
  return input.runoutStreet !== null && input.runoutStreet !== 'river';
}

const AGGRESSIVE = new Set(['bet', 'raise', 'all_in']);
const PASSIVE = new Set(['call', 'check']);

/**
 * Derive every flow flag for one player from the hand's action log.
 *
 * Note on blinds: the action log contains no blind or ante postings (only
 * PLAYER_ACTION events reach it). That is exactly right for VPIP — a big blind
 * who checks has not voluntarily put money in — and it is why the money
 * figures elsewhere in this module come from the engine's contributions map
 * rather than from these actions.
 */
export function deriveFlowFlags(
  userId: string,
  actions: HandAction[],
  opts: {
    boardLength: number;
    returned: number;
    /** userIds who never folded — 2+ means a showdown happened. */
    nonFoldedCount: number;
  }
): FlowFlags {
  const mine = actions.filter((a) => a.userId === userId);
  const preflop = actions.filter((a) => a.stage === 'preflop');

  let aggressive = 0;
  let passive = 0;
  let wasAllIn = false;
  let allInStreet: string | null = null;
  for (const a of mine) {
    if (AGGRESSIVE.has(a.action)) aggressive++;
    else if (PASSIVE.has(a.action)) passive++;
    if ((a.action === 'all_in' || a.allInRunout === true) && !wasAllIn) {
      wasAllIn = true;
      allInStreet = a.stage || null;
    }
  }

  // Walk preflop in order, tracking the voluntary raise count and the level,
  // so an all-in can be classified as a raise or a call rather than assumed.
  let raiseCount = 0;
  let level = 0;
  let myRaiseIndex = -1; // which voluntary raise (0-based) was mine
  let pfr = false;
  let threeBet = false;
  let fourBet = false;
  let vpip = false;
  let lastAggressorPreflop: string | null = null;
  let facedThreeBet = false;
  let foldedToThreeBet = false;
  /** Set once we make an aggressive action AFTER being 3-bet. */
  let respondedToThreeBet = false;
  /**
   * The raise count at the moment we were 3-bet. If another raise lands before
   * we act, whatever we do next is a response to THAT raise, not to the 3-bet.
   */
  let raiseCountAtThreeBet = -1;

  for (const a of preflop) {
    const isMine = a.userId === userId;
    const amt = a.amount ?? 0;

    if (a.action === 'fold') {
      // Only a fold that is still ANSWERING the 3-bet counts. Once we have
      // acted on it (by 4-betting), a later fold is a fold to the 4-bet or
      // 5-bet, not to the 3-bet. Without `respondedToThreeBet` this latched on
      // any subsequent preflop fold and inflated fold-to-3-bet with traffic
      // that had nothing to do with 3-bets.
      // Three conditions, and all three are needed:
      //   facedThreeBet          - we opened and were 3-bet at all
      //   !respondedToThreeBet   - we have not already 4-bet (a later fold is
      //                            then a fold to the 4-bet or 5-bet)
      //   raiseCount unchanged   - nobody has COLD 4-BET over the top since;
      //                            otherwise we are folding to that raise, and
      //                            that is ordinary multiway traffic, not a
      //                            corner case.
      if (isMine && facedThreeBet && !respondedToThreeBet && raiseCount === raiseCountAtThreeBet) {
        foldedToThreeBet = true;
      }
      continue;
    }

    if (isMine && (a.action === 'call' || AGGRESSIVE.has(a.action))) vpip = true;

    const raisesLevel = AGGRESSIVE.has(a.action) && amt > level;
    if (raisesLevel) {
      if (isMine) {
        pfr = true;
        if (facedThreeBet) respondedToThreeBet = true;
        if (myRaiseIndex < 0) myRaiseIndex = raiseCount;
        // Blinds never reach the action log, so the open is raise index 0,
        // the 3-bet is index 1 and the 4-bet is index 2.
        if (raiseCount === 1) threeBet = true;
        if (raiseCount === 2) fourBet = true;
      } else if (myRaiseIndex === 0 && raiseCount === 1) {
        // FIX 2026-08-21: this used to be `myRaiseIndex >= 0 && raiseCount >
        // myRaiseIndex`, i.e. "someone re-raised after me" — which also fired
        // when WE were the 3-bettor and villain 4-bet. Fold-to-3-bet was
        // therefore inflated by every fold to a 4-bet.
        //
        // A 3-bet is the SECOND voluntary raise, so facing one means we made
        // the FIRST (myRaiseIndex === 0) and this is raise index 1. Note a
        // cold-caller who then faces a squeeze is deliberately not counted:
        // the standard definition scopes this stat to openers, which is also
        // what makes it comparable to other trackers.
        facedThreeBet = true;
        // raiseCount is incremented just below, so record the post-increment
        // value: that is what it will still equal if nobody raises again.
        raiseCountAtThreeBet = raiseCount + 1;
      }
      raiseCount++;
      level = amt;
      lastAggressorPreflop = a.userId ?? null;
    }
  }

  const iFolded = mine.some((a) => a.action === 'fold');

  // FIX 2026-08-21: this used to be `!iFolded`, which scans EVERY street — so a
  // player who called preflop, saw the flop, and folded to a c-bet was recorded
  // as never having seen the flop. That collapsed saw_flop into roughly
  // went_to_showdown and biased every continuation metric: worst of all it made
  // had_cbet_flop_opp false for a preflop raiser who c-bet and then folded to a
  // raise, so cbet% was measured only over the c-bets that WORKED.
  //
  // The fold that decides whether you saw a flop is the PREFLOP one.
  const foldedPreflop = mine.some((a) => a.stage === 'preflop' && a.action === 'fold');
  const sawFlop = !foldedPreflop && opts.boardLength >= 3;
  const hadCbetOpp = sawFlop && lastAggressorPreflop === userId;

  let cbetFlop = false;
  if (hadCbetOpp) {
    const flop = actions.filter((a) => a.stage === 'flop');
    const firstAggro = flop.find((a) => AGGRESSIVE.has(a.action));
    cbetFlop = !!firstAggro && firstAggro.userId === userId;
  }

  // A showdown happened iff two or more players were still live at the end.
  // This is exact, and unlike hand_history.hole_cards it does not conflate
  // "reached showdown" with "had their cards revealed". Here `iFolded` across
  // all streets IS the right test - folding on the river still means you did
  // not reach showdown.
  const wentToShowdown = !iFolded && opts.nonFoldedCount >= 2;

  return {
    vpip,
    pfr,
    three_bet: threeBet,
    four_bet: fourBet,
    faced_three_bet: facedThreeBet,
    folded_to_three_bet: foldedToThreeBet,
    had_cbet_flop_opp: hadCbetOpp,
    cbet_flop: cbetFlop,
    saw_flop: sawFlop,
    went_to_showdown: wentToShowdown,
    won_at_showdown: wentToShowdown && opts.returned > 0,
    aggressive_actions: aggressive,
    passive_actions: passive,
    was_all_in: wasAllIn,
    all_in_street: allInStreet,
  };
}

const r2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Maximum chips a player can win, given everyone's total contribution.
 * Classic side-pot formula: you can win at most what you matched from each
 * opponent, plus your own stake.
 *
 * Used to keep all-in EV honest when there is a side pot — without it, a short
 * stack all-in for 50 against two players in for 100 would be credited with
 * equity in chips they were never eligible to win.
 */
export function maxWinnable(myInvested: number, allInvested: number[]): number {
  let total = 0;
  for (const other of allInvested) total += Math.min(other, myInvested);
  return total;
}

export interface TransferRow {
  winnerId: string;
  loserId: string;
  amount: number;
}

/**
 * Head-to-head chip attribution at HAND level, proportional to each loser's
 * share of the hand's total losses:
 *
 *   transfer(w, l) = net_w * (|net_l| / totalLosses)
 *
 * Chips are conserved exactly. It is exactly right whenever there is a single
 * pot or a single winner — the overwhelming majority of hands — and
 * approximates only in multiway side-pot situations.
 *
 * Rake is deliberately attributed to nobody: total wins fall short of total
 * losses by exactly the rake, so each loser's attributed outflow is their loss
 * minus their share of the rake. The house took that, not the villain.
 */
export function computeTransfers(nets: Map<string, number>): TransferRow[] {
  const winners: Array<[string, number]> = [];
  const losers: Array<[string, number]> = [];
  for (const [uid, net] of nets) {
    if (net > 0.005) winners.push([uid, net]);
    else if (net < -0.005) losers.push([uid, -net]);
  }
  if (winners.length === 0 || losers.length === 0) return [];

  let totalLosses = 0;
  for (const [, loss] of losers) totalLosses += loss;
  if (totalLosses <= 0) return [];

  const out: TransferRow[] = [];
  for (const [winnerId, won] of winners) {
    // LARGEST REMAINDER, added 2026-08-21. Rounding each pair independently
    // left the pair-sums short of `won` by up to half a cent per loser, and
    // that drift accumulates monotonically in the Nemesis aggregate - the one
    // number this table exists to produce. Allocating whole cents and then
    // handing the leftover to the largest remainders makes the split sum to
    // `won` EXACTLY, which is what lets the module claim chip conservation.
    const eligible = losers.filter(([loserId]) => loserId !== winnerId);
    if (eligible.length === 0) continue;

    let eligibleLoss = 0;
    for (const [, loss] of eligible) eligibleLoss += loss;
    if (eligibleLoss <= 0) continue;

    const wonCents = Math.round(won * 100);
    const parts = eligible.map(([loserId, loss]) => {
      const exact = (wonCents * loss) / eligibleLoss;
      const floor = Math.floor(exact);
      return { loserId, cents: floor, remainder: exact - floor };
    });

    const allocated = parts.reduce((s, p) => s + p.cents, 0);
    let leftover = wonCents - allocated;
    // Ties broken by the original order, so the same inputs always produce the
    // same rows - this write is idempotent on (hand_id, winner_id, loser_id).
    const byRemainder = [...parts].sort((a, b) => b.remainder - a.remainder);
    for (let i = 0; leftover > 0 && i < byRemainder.length; i++, leftover--) {
      byRemainder[i].cents += 1;
    }

    for (const p of parts) {
      // The DB has CHECK (amount > 0); a zero-cent share is dropped, not
      // clamped. Those are genuinely sub-cent slices of a tiny pot.
      if (p.cents > 0) {
        out.push({ winnerId, loserId: p.loserId, amount: p.cents / 100 });
      }
    }
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. THE WRITE
// ═══════════════════════════════════════════════════════════════════════════

export interface HandFactsInput {
  handId: string;
  tableId: string;
  clubId?: string | null;
  tournamentId?: string | null;
  handNumber: number;
  gameVariant: string;
  bigBlind: number;
  playedAt: string;
  buttonSeat?: number | null;
  rakeAmount: number;
  boardLength: number;
  /** Every seat dealt in: userId -> { seat, cards }. Authority for who played. */
  holeCardsAll: Map<string, { seat: number; cards: unknown }>;
  /** userId -> totalInvested, INCLUDING blinds/antes, net of uncalled refund. */
  contributions: Map<string, number>;
  winners: Array<{ userId: string; amount: number }>;
  actions: HandAction[];
  /**
   * Seat roster with horse flags. Humans always get fact rows; horses get them
   * when the table runs NIT Game - see the note over `writeHandFacts`.
   */
  roster: Array<{ userId: string; isHorse: boolean }>;
  /**
   * `tables.nit_game`. Retained as CONTEXT on the written row, not as a gate:
   * fact rows are written for every seat everywhere since 2026-09-05. It still
   * matters to a reader, because a VPIP measured where a floor is enforced is
   * not the same measurement as one taken where the horse chose its own width.
   */
  nitGame?: boolean;
  /**
   * BOMB POTS COUNT (Dan 2026-09-05): "VPIP NEEDS TO WORK FOR EVERY HAND, BOMB
   * POTS COUNT AS A HAND. ANY HAND YOU VOLUNTARILY PUT IN POT BUT INCLUDING
   * ALL BOMB POTS." A bomb hand has no preflop street - everyone antes and
   * sees the flop - so the action-log rule below could never mark anyone as
   * having put money in. In a bomb hand every player dealt in did.
   */
  isBombPot?: boolean;
}

/**
 * Build and persist ca_hand_facts + ca_hand_transfers for one hand.
 *
 * Fire-and-forget and NEVER throws. It is called from inside logHandHistory,
 * which runs inside `runStep('hand_history', moneyCritical = true, ...)` — a
 * throw there raises a CRITICAL financial alert, and a stats row failing to
 * write is emphatically not a financial incident.
 */
export async function writeHandFacts(input: HandFactsInput): Promise<void> {
  try {
    if (!input.handId) return;

    /**
     * ── HORSES ARE PLAYERS, AND A RULE NEEDS EVIDENCE (Dan 2026-08-27) ──
     *
     * `fn_nit_evictions` had a horse-only predicate removed on 2026-08-27 so
     * the fleet could be stood up by the maintain-VPIP rule like anybody else.
     * That fix could never bite, because the rule is judged by `fn_nit_check`,
     * which reads `ca_hand_facts`, and this function wrote rows for humans
     * only. A horse's VPIP was therefore not "low", it was UNKNOWABLE: both
     * branches of fn_nit_check compare a sample count against a floor, and a
     * horse's sample was permanently zero, so `0 >= 100` was false and every
     * horse returned `within_limits` for ever.
     *
     * Proved against production on 2026-08-27 inside a rolled-back
     * transaction: with NIT Game set to demand a 99% VPIP - a threshold no
     * player alive can meet - the human at the table was evicted on
     * `career_vpip` (24.6% over 544 hands) and the horse beside them came back
     * `ok: true, within_limits`.
     *
     * PLATFORM-WIDE FROM 2026-09-05, and it was Dan's call to make: "YES
     * PLATFORM WIDE." The nit-table scoping meant a horse's VPIP was knowable
     * only where a rule already judged it, so nobody could answer whether the
     * fleet plays a realistic distribution anywhere else - the question that
     * decides whether a watching human can pick the horses out with a HUD.
     *
     * THE BILL, measured 2026-09-05 before switching it on: 653,719 hands and
     * 3.41 seats per hand in 24h is ~2.23M rows a day, and this table runs 575
     * bytes a row, so ~1.28 GB a day and ~38 GB a month. `ca_hand_facts` had
     * NO retention of any kind - so platform-wide without a prune is an
     * unbounded table, and the migration that ships with this change adds one
     * on the same 7-day horse retention `hand_history_retention_policy`
     * already uses. Human rows are kept forever, exactly as there. Steady
     * state is ~9 GB rather than growing without limit.
     */
    const factIds = new Set(input.roster.map((p) => p.userId).filter(Boolean));
    if (factIds.size === 0) return; // nobody to store

    const dealtSeats: number[] = [];
    for (const v of input.holeCardsAll.values()) {
      if (typeof v?.seat === 'number') dealtSeats.push(v.seat);
    }
    const playersDealt = dealtSeats.length || input.roster.length;

    // Gross awarded per user (post-rake — winners receive net of it).
    //
    // KNOWN SCOPE LIMIT: this is POT money only. Bad-beat jackpot payouts,
    // insurance settlements and 7-2 bounties all move chips at this same
    // settlement and are invisible here, so a player who hits a jackpot will
    // show a large negative `net` on the very hand that paid them. Those flows
    // live on their own tables and are not part of "how did I do at poker",
    // which is what this column answers - but anyone reconciling ca_hand_facts
    // against a wallet balance needs to know it.
    const returnedBy = new Map<string, number>();
    for (const w of input.winners ?? []) {
      if (!w?.userId) continue;
      returnedBy.set(w.userId, r2((returnedBy.get(w.userId) ?? 0) + (w.amount ?? 0)));
    }

    // Everyone who was dealt in, whether human or horse — nets across the whole
    // table are needed for correct head-to-head attribution.
    const participants = new Set<string>([
      ...input.holeCardsAll.keys(),
      ...input.contributions.keys(),
      ...returnedBy.keys(),
    ]);

    const nets = new Map<string, number>();
    for (const uid of participants) {
      const invested = r2(input.contributions.get(uid) ?? 0);
      const returned = r2(returnedBy.get(uid) ?? 0);
      nets.set(uid, r2(returned - invested));
    }

    const nonFoldedCount = (() => {
      const folded = new Set(
        input.actions.filter((a) => a.action === 'fold' && a.userId).map((a) => a.userId as string)
      );
      let live = 0;
      for (const uid of participants) if (!folded.has(uid)) live++;
      return live;
    })();

    // Without a real big blind every bb-normalised column would be written as
    // RAW CHIPS - a plausible-looking number 10x out at a 5/10 table, which
    // then poisons the EV curve and the heatmap colour scales quietly. Refuse
    // the hand instead: a missing row is visible, a wrong row is not.
    const bb = input.bigBlind;
    if (!Number.isFinite(bb) || bb <= 0) {
      reportError(
        new Error('writeHandFacts: non-positive big blind'),
        'writeHandFacts.badBigBlind',
        {
          handId: input.handId,
          bigBlind: input.bigBlind,
        }
      );
      return;
    }

    // Everyone actually DEALT IN, which is the honest basis for "hands played
    // together". Transfers cannot supply this: two players who both lose a
    // hand exchange no chips and so produce no transfer row between them, and
    // a transfer-derived count would silently omit exactly those hands.
    const dealtIds =
      input.holeCardsAll.size > 0 ? [...input.holeCardsAll.keys()] : [...participants];

    const factRows: Record<string, unknown>[] = [];

    // WEIGHTED CONTRIBUTED RAKE (Dan 2026-08-29): rake_paid uses the SAME
    // canonical allocator as the money pipeline (rake_attributions /
    // RakebackSettler), so the stats ledger and the financial ledger agree to
    // the cent — the old inline `rake * invested / total` float split could
    // drift a cent from the authoritative allocation on remainder hands.
    const rakeShares = allocateWeightedShareCents(Number(input.rakeAmount ?? 0), [
      ...input.contributions.entries(),
    ]);

    for (const uid of participants) {
      if (!factIds.has(uid)) continue; // humans, plus horses at NIT tables

      const seatInfo = input.holeCardsAll.get(uid);
      const invested = r2(input.contributions.get(uid) ?? 0);
      const returned = r2(returnedBy.get(uid) ?? 0);
      const net = r2(returned - invested);

      const cards = Array.isArray(seatInfo?.cards)
        ? (seatInfo!.cards as Array<{ rank?: string; suit?: string }>)
        : null;

      const flags = deriveFlowFlags(uid, input.actions, {
        boardLength: input.boardLength,
        returned,
        nonFoldedCount,
      });
      // A bomb pot is a voluntary pot for everyone dealt into it (Dan
      // 2026-09-05). The hand row was always written; the flag was not.
      if (input.isBombPot) flags.vpip = true;

      // All-in EV. Outside an all-in the EV series equals the actual series by
      // construction, which is the correct behaviour for a luck graph: the only
      // thing being adjusted for is the runout of a committed stack.
      let allInEquity: number | null = null;
      let evReturned: number | null = null;
      let evNet = net;

      const runoutMarkers = input.actions.filter(
        (action) => action.userId === uid && action.allInRunout === true
      );
      if (runoutMarkers.length > 1) {
        throw new Error(`writeHandFacts: duplicate all-in runout marker for ${uid}`);
      }
      const runoutMarker = runoutMarkers[0] ?? null;
      const eq = runoutMarker?.allInEquity;
      const expectedReturn = runoutMarker?.allInEvReturned;
      if (eq !== undefined && (!Number.isFinite(eq) || eq < 0 || eq > 1)) {
        throw new Error(`writeHandFacts: invalid all-in equity for ${uid}`);
      }
      if (
        expectedReturn !== undefined &&
        (!Number.isFinite(expectedReturn) || expectedReturn < 0)
      ) {
        throw new Error(`writeHandFacts: invalid all-in expected return for ${uid}`);
      }
      if ((eq === undefined) !== (expectedReturn === undefined)) {
        throw new Error(`writeHandFacts: incomplete all-in equity witness for ${uid}`);
      }
      if (
        eq !== undefined &&
        (runoutMarker?.allInEquityVersion !== 'layered-settlement-v1' ||
          typeof runoutMarker.allInEquityExact !== 'boolean' ||
          !Number.isSafeInteger(runoutMarker.allInEquityRunouts) ||
          (runoutMarker.allInEquityRunouts ?? 0) <= 0 ||
          !Number.isSafeInteger(runoutMarker.allInEquitySeed) ||
          !/^[a-f0-9]{64}$/.test(runoutMarker.allInEquityInputHash ?? ''))
      ) {
        throw new Error(`writeHandFacts: incomplete all-in equity provenance for ${uid}`);
      }

      // FIX 2026-08-21: was_all_in used to come from the action log alone, and
      // the action log CANNOT see an all-in made by calling. HandController
      // sets is_all_in on a call that consumes the stack but still records the
      // action as 'call' - so the covering player who snaps off a shove, and
      // the short stack who calls one, both looked "not all-in" and were
      // dropped from the EV adjustment. That is one whole side of most all-in
      // confrontations missing from the luck graph.
      //
      // The marker is attached to every active player's last canonical action
      // at ALL_IN_RUNOUT, including calls, forced blind/ante all-ins, and the
      // covering stack. Its own action stage remains the personal commit
      // street; allInRunoutStreet separately records when betting ended.
      const inAllInRunout = runoutMarker !== null;
      const wasAllIn = flags.was_all_in || inAllInRunout;
      const allInEquityOwed = allInEquityIsOwed({
        wentToShowdown: flags.went_to_showdown,
        runoutStreet: runoutMarker?.allInRunoutStreet ?? null,
      });

      if (typeof eq === 'number') {
        allInEquity = eq;
        // The worker freezes every physical pot layer, its eligible field,
        // hi/lo split, board/run share, odd unit and post-deduction penny
        // scaling at the all-in boundary. A whole-field percentage cannot be
        // multiplied back into an unequal-stack side pot without lying.
        evReturned = r2(expectedReturn as number);
        evNet = r2(evReturned - invested);
      }

      factRows.push({
        hand_id: input.handId,
        user_id: uid,
        club_id: input.clubId ?? null,
        table_id: input.tableId,
        tournament_id: input.tournamentId ?? null,
        played_at: input.playedAt,
        game_variant: input.gameVariant,
        // `bb`, not the raw input: big_blind is NOT NULL, and a null here would
        // be omitted from the JSON and 400 the entire batch upsert.
        big_blind: bb,
        seat: seatInfo?.seat ?? null,
        position:
          typeof seatInfo?.seat === 'number' && typeof input.buttonSeat === 'number'
            ? derivePosition(seatInfo.seat, input.buttonSeat, dealtSeats)
            : 'UNKNOWN',
        players_dealt: playersDealt,
        opponent_ids: dealtIds.filter((id) => id !== uid),
        /* ═══ A HAND NOBODY PAID INTO IS NOT RECORDED (Dan 2026-09-01) ══
           Dan, verbatim: "MUCKED HANDS SHOULDN'T BE RECORDED AND TRACKED,
           ONLY HANDS WHERE THE HERO PUTS CHIPS IN POT."

           `invested` is the engine's own contributions map, so 0 means no
           chips of this player's reached the pot at all - not a blind, not an
           ante. They were dealt in and folded for free. 640 of the 2,265 rows
           in this table on the day of the ruling, 28%, were exactly that:
           the exact holding of a hand nobody played, kept forever.

           WHAT IS KEPT, AND WHY IT IS NOT THE SAME THING. `hand_class` stays.
           It is the 169-bucket label, not a holding: it carries no suit
           identity and no board, and it is the DENOMINATOR of the only chart
           that reads this column. `ca_player_hand_grid`'s default view is
           "how often you played this hand", which is
           `hands_vpip / hands` per class - drop the folded-for-free rows and
           every cell reads 100% and the feature is gone rather than improved.
           The grid never selects hole_cards at all; only the per-cell
           drill-down does, and its example hands are now hands that were
           actually played, which is what you would want from it anyway.

           Enforced again at the database in
           `20260901_no_cards_for_hands_nobody_paid_into.sql`, by a trigger
           that NULLS rather than rejects - a CHECK would 400 the whole batch
           upsert and lose every other player's stats row with it. */
        hole_cards: invested > 0 ? cards : null,
        hand_class: cards ? computeHandClass(cards) : null,
        invested,
        returned,
        net,
        net_bb: r2(net / bb),
        // FIX 2026-08-21: this was hardcoded 0, so every row claimed the player
        // paid no rake. It is the one column here that is genuinely
        // unrecoverable later - hand_history.rake_amount is hand-level and is
        // purged at 7 days - so "win rate net of rake" and any rake-contribution
        // analysis would have been lost forever for hands written before now.
        //
        // Contribution-weighted, matching how the engine itself apportions rake
        // (atomic_distribute_rake takes p_contributions).
        rake_paid: rakeShares.get(uid) ?? 0,
        vpip: flags.vpip,
        pfr: flags.pfr,
        three_bet: flags.three_bet,
        four_bet: flags.four_bet,
        faced_three_bet: flags.faced_three_bet,
        folded_to_three_bet: flags.folded_to_three_bet,
        had_cbet_flop_opp: flags.had_cbet_flop_opp,
        cbet_flop: flags.cbet_flop,
        saw_flop: flags.saw_flop,
        went_to_showdown: flags.went_to_showdown,
        won_at_showdown: flags.won_at_showdown,
        aggressive_actions: flags.aggressive_actions,
        passive_actions: flags.passive_actions,
        was_all_in: wasAllIn,
        // The player's OWN commit street wins over the runout street. equity
        // .street is the board length when the runout broadcast fired, so a
        // preflop shove into two opponents who then contest a flop was being
        // recorded as an all-in "on the flop" - a street the player never
        // chose to commit on. Fall back to the runout street only when the
        // action log has nothing (i.e. they got all-in by calling).
        all_in_street: wasAllIn ? (flags.all_in_street ?? runoutMarker?.stage ?? null) : null,
        all_in_at_risk: wasAllIn ? invested : null,
        all_in_equity_owed: allInEquityOwed,
        all_in_equity: allInEquity,
        ev_returned: evReturned,
        ev_net: evNet,
        ev_net_bb: r2(evNet / bb),
      });
    }

    if (factRows.length === 0) return;

    const { error: factErr } = await supabase
      .from('ca_hand_facts')
      .upsert(factRows, { onConflict: 'hand_id,user_id', ignoreDuplicates: true });
    if (factErr) reportError(factErr, 'writeHandFacts.facts', { handId: input.handId });

    // Head-to-head transfers. Only rows touching a human are stored — a horse
    // beating another horse is not a rivalry anybody will read about.
    const transfers = computeTransfers(nets)
      .filter((t) => factIds.has(t.winnerId) || factIds.has(t.loserId))
      .map((t) => ({
        hand_id: input.handId,
        winner_id: t.winnerId,
        loser_id: t.loserId,
        amount: t.amount,
        played_at: input.playedAt,
        club_id: input.clubId ?? null,
        table_id: input.tableId,
      }));

    if (transfers.length > 0) {
      const { error: xferErr } = await supabase
        .from('ca_hand_transfers')
        .upsert(transfers, { onConflict: 'hand_id,winner_id,loser_id', ignoreDuplicates: true });
      if (xferErr) reportError(xferErr, 'writeHandFacts.transfers', { handId: input.handId });
    }
  } catch (err) {
    // Swallow. See the doc comment: this runs inside a money-critical step.
    try {
      reportError(err, 'writeHandFacts.unhandled', { handId: input?.handId });
    } catch {
      /* reporting must not throw either */
    }
  }
}
