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
import {
  variantInfo,
  omahaNutStatus,
  nlhNutStatus,
  scoreOmahaHiPartial,
} from '../engine/HorseEval.js';
import { RANK_VALUES, RANKS, SUITS } from '../engine/PokerEngine.js';
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
    /** HandController's discriminator on an all_in: true = full raise,
     *  false = short raise, UNDEFINED = a call-off that never moved the bet. */
    isFullRaise?: boolean;
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
 * How many aggressive actions the horse took on the river. Two or more is a
 * raise war it kept escalating. Shared so the winning and losing sides of that
 * line are counted by the SAME rule - a mirror measured differently is not a
 * denominator.
 */
function riverAggressiveActions(row: {
  heroActions: Array<{ action: string; stage: string; isFullRaise?: boolean }>;
}): number {
  return row.heroActions.filter((a) => a.stage === 'river' && isAggressiveAction(a)).length;
}

/**
 * ═══ A CALL-OFF ALL-IN IS A CALL (2026-09-05) ═══
 *
 * HandController records every all_in with `isFullRaise`: true when it is a
 * full raise, false when it raised currentBet by less than the minimum, and
 * UNDEFINED when the stack did not reach currentBet at all - a call for
 * everything the player had. HorseLogic has read that discriminator since
 * the V28 audit fix (routing: "an all-in call-off is a caller of the price").
 * These detectors never did: every all_in counted as a bet or raise.
 *
 * Measured on 2026-09-04: 450 of 952 river_raise_war tags were a hero bet
 * followed by a hero CALL-off of a shove (the river_raise_paidoff shape, not
 * a war), and 941 of 7,569 river_aggr_lost tags were hands whose only river
 * action by the hero was a call-off. The win-side mirrors (river_aggr_won,
 * river_raise_war_won) share the same function, so the river_aggression_ev
 * headline was contaminated in both directions. Preflop, a call-off looked
 * like a raise and suppressed coldcall_stackoff / limped_pot_bloat.
 *
 * Aggression is bet, raise, or an all_in that MOVED the bet. An all_in with
 * no isFullRaise is a call wherever a detector asks.
 */
export function isAggressiveAction(a: { action: string; isFullRaise?: boolean }): boolean {
  return (
    a.action === 'bet' ||
    a.action === 'raise' ||
    (a.action === 'all_in' && a.isFullRaise !== undefined)
  );
}

function isCallAction(a: { action: string; isFullRaise?: boolean }): boolean {
  return a.action === 'call' || (a.action === 'all_in' && a.isFullRaise === undefined);
}

/**
 * The stack-off bar for the PLO discipline detectors below: a hundred big
 * blinds is a full buy-in at every cash table the fleet plays, so this counts
 * hands where the horse put its WHOLE stack in, not merely a big pot.
 */
const PLO_STACKOFF_BB = 100;

/**
 * Hand categories as `scoreOmahaHiPartial` numbers them (HorseEval): 1 high
 * card, 2 one pair, 3 two pair, 4 trips, 5 straight, 6 flush, 7 full house,
 * 8 quads. Named here because a bare `=== 4` in a detector is unreadable and
 * the ladder is offset from the usual one.
 */
const CAT_ONE_PAIR = 2;
const CAT_TRIPS = 4;
const CAT_FULL_HOUSE = 7;
const CAT_QUADS = 8;

/** Does the board carry a pair (or better) of any rank? */
export function boardHasPair(board: Card[]): boolean {
  const seen = new Set<string>();
  for (const c of board) {
    if (seen.has(c.rank)) return true;
    seen.add(c.rank);
  }
  return false;
}

/**
 * Omaha: is hero's full house the NUT full house on this board? Enumerates
 * every two-card holding from the cards hero cannot see (52 minus the board
 * minus hero's hole cards) and asks whether any of them makes a bigger full
 * house or quads - two hole cards and three board cards, the Omaha rule,
 * which is exactly what scoreOmahaHiPartial does with a two-card hand. A
 * straight flush also beats a boat but is a different leak and is ignored
 * here. ~800 evaluations of a five-card board; only called for a made boat
 * with a full stack in, a few hundred hands a day.
 */
export function omahaBoatIsNut(hole: Card[], board: Card[]): boolean {
  const heroScore = scoreOmahaHiPartial(hole, board);
  const heroCat = Math.floor(heroScore / 0x100000);
  if (heroCat < CAT_FULL_HOUSE) return false;
  const seen = new Set<string>();
  for (const c of hole) seen.add(c.rank + c.suit);
  for (const c of board) seen.add(c.rank + c.suit);
  const unseen: Card[] = [];
  for (const rank of RANKS) {
    for (const suit of SUITS) {
      if (!seen.has(rank + suit)) unseen.push({ rank, suit } as Card);
    }
  }
  const combo: Card[] = new Array(2);
  for (let i = 0; i < unseen.length; i++) {
    combo[0] = unseen[i];
    for (let j = i + 1; j < unseen.length; j++) {
      combo[1] = unseen[j];
      const s = scoreOmahaHiPartial(combo, board);
      if (s <= heroScore) continue;
      const cat = Math.floor(s / 0x100000);
      if (cat === CAT_FULL_HOUSE || cat === CAT_QUADS) return false;
    }
  }
  return true;
}

/**
 * What the FINAL board makes available to somebody else. Omaha plays exactly
 * two hole cards and three board cards, which is what each test below counts:
 *
 *  - fullHouseLive: the board is paired, so any opponent holding the case card
 *    or a pocket pair to another board rank has a boat. (Hero holding trips
 *    THROUGH a paired board is inside this set by construction - which is the
 *    point: trips is the losing end of that board, not the winning one.)
 *  - flushLive: three or more of one suit on the board, so two suited hole
 *    cards complete it.
 *  - straightLive: some five-rank window holds three or more distinct board
 *    ranks, so two hole cards fill it. Same window test `omahaNutStatus` uses
 *    to decide whether hero's own straight is the nut one.
 *
 * This is deliberately a read of the BOARD alone. It asks "was a better hand
 * available here", never "did the opponent have it" - a detector that needed
 * the villain's cards could not run on the hands where they never showed.
 */
export function omahaBoardThreats(board: Card[]): {
  fullHouseLive: boolean;
  flushLive: boolean;
  straightLive: boolean;
} {
  const rankCount = new Map<number, number>();
  const suitCount = new Map<string, number>();
  for (const c of board) {
    const r = RANK_VALUES[c.rank];
    rankCount.set(r, (rankCount.get(r) ?? 0) + 1);
    suitCount.set(c.suit, (suitCount.get(c.suit) ?? 0) + 1);
  }
  const fullHouseLive = [...rankCount.values()].some((n) => n >= 2);
  const flushLive = [...suitCount.values()].some((n) => n >= 3);

  let straightLive = false;
  for (let top = 14; top >= 5 && !straightLive; top--) {
    let onBoard = 0;
    for (let k = 0; k < 5; k++) {
      const r = top - k === 1 ? 14 : top - k; // wheel: the 5-high straight uses the ace
      if (rankCount.has(r)) onBoard++;
    }
    if (onBoard >= 3) straightLive = true;
  }
  return { fullHouseLive, flushLive, straightLive };
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
  heroActions: Array<{ action: string; stage: string; amount?: number; isFullRaise?: boolean }>;
  wentToShowdown: boolean;
}): string[] {
  const tags: string[] = [];
  const vi = variantInfo(row.variant);
  const investedBB = row.invested / (row.bigBlind || 1);

  const folded = row.heroActions.some((a) => a.action === 'fold');
  const raisedOrBet = (stage: string) =>
    row.heroActions.some((a) => a.stage === stage && isAggressiveAction(a));

  /*
   * ═══ THE WIN SIDE OF RIVER AGGRESSION (2026-09-01) ═══
   *
   * Every tag below this point is a LEAK, and a leak is only a leak when the
   * hand lost - hence the early return. That is right for the leak tags and
   * it made one number unreadable.
   *
   * MEASURED on 2026-08-31: `river_aggr_lost` carried 1,545 hands and
   * -97,229bb, roughly five times the entire day's horse net of -19,984bb,
   * and it dominated the tag mix of nine of the ten bleeding horses. It is
   * the largest single line in the audit - and it cannot be acted on, because
   * the tag exists only on losses. There is no denominator. A horse that bets
   * every river and a horse that value-bets perfectly produce the same
   * evidence here, since a winning river bet is stored (5,277 wins were) and
   * simply carries no tag at all.
   *
   * Tuning a river cap on that number would be tuning against a sample
   * selected for being negative. So the mirror is recorded: the same line,
   * the same showdown, the winning outcome. `river_aggr_won` plus
   * `river_aggr_lost` is river aggression's actual EV.
   *
   * It is NOT a leak tag and must never be treated as one. It is named for
   * the outcome so no gate can mistake it, and the self-tuner reads tags by
   * exact name (nonnut_flush_stackoff, big_bet_fold, preflop_stackoff), so
   * nothing downstream picks it up by accident.
   */
  if (row.netBB > 0) {
    if (row.wentToShowdown && raisedOrBet('river')) {
      tags.push('river_aggr_won');
      /*
       * ── 2026-09-02: river_raise_war had the SAME missing denominator ──
       * The block above fixed river_aggr_lost by recording its win side. The
       * war tag, added under it, was left one-sided and reproduced the bug in
       * miniature: measured over 2026-08-28..09-01, river_raise_war carried
       * 1,696 hands and NOT ONE win, because a won war carries no tag at all.
       * On 2026-09-01 it was the worst average line in the whole audit at
       * -87.7bb over 226 hands and it could not be acted on for the reason
       * already written down here - the sample is selected for being
       * negative. Same fix, same naming rule, same exclusion from the tuner.
       */
      if (riverAggressiveActions(row) >= 2) {
        tags.push('river_raise_war_won');
      }
    }
    return tags; // wins carry no LEAK tags (they are still stored)
  }

  // Big loss with a fold at the end: chips went in and then the hand was
  // surrendered — a blown-off bluff or a bet-fold line that cost a stack.
  if (folded && investedBB >= FLAG_BB) {
    tags.push('big_bet_fold');

    // V23 DETECTOR SPLIT (2026-08-28): big_bet_fold has two OPPOSITE fixes.
    // "Got bluffed off the best hand on the river" wants looser catches;
    // "built a huge pot on early streets and then had to let it go" wants
    // tighter pot-building. One tag cannot steer the self-tuner both ways.
    const foldStage = [...row.heroActions].reverse().find((a) => a.action === 'fold')?.stage;
    tags.push(foldStage === 'river' ? 'big_fold_river' : 'big_fold_early');
    // The bet-fold LINE: hero bet or raised the very street it then folded
    // on — it put chips in with a hand it could not defend at that price.
    if (foldStage && raisedOrBet(foldStage)) {
      tags.push('bet_fold_line');
    }
  }

  // ═══ V23 PREFLOP-ENTRY DETECTORS (2026-08-28) ═══ how the horse ENTERED
  // the pot it lost big. detectLeaks only sees hero's own actions, so both
  // reads are from the hero side: the amounts say whether the entry was a
  // limp or a cold-call of a raise.
  const heroPre = row.heroActions.filter((a) => a.stage === 'preflop');
  const heroPreRaised = heroPre.some((a) => isAggressiveAction(a));
  const bb = row.bigBlind || 1;
  if (!heroPreRaised && heroPre.some((a) => isCallAction(a)) && investedBB >= 2 * FLAG_BB) {
    const maxPreCall = Math.max(
      0,
      ...heroPre.filter((a) => isCallAction(a)).map((a) => a.amount ?? 0)
    );
    if (maxPreCall <= bb * 1.05) {
      // Entered for one big blind and lost 40bb+ — limped pots are supposed
      // to stay SMALL; a stack went in behind a passive entry.
      tags.push('limped_pot_bloat');
    } else if (maxPreCall >= bb * 3) {
      // Cold-called a raise (never took the initiative) and lost 40bb+ —
      // the classic dominated-flat: crushed by the range it called.
      tags.push('coldcall_stackoff');
    }
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
    const riverAggrCount = riverAggressiveActions(row);
    if (riverAggrCount >= 2) {
      tags.push('river_raise_war');
    }
    // V23 (2026-08-28): hero bet the river, then CALLED on the river — the
    // only way that sequence exists is a raise arrived and hero paid it off.
    // The V21 war tag needs two aggressive actions; this catches the
    // bet-then-call shape that pays a raise without escalating.
    const acts = row.heroActions.filter((a) => a.stage === 'river');
    const betIdx = acts.findIndex((a) => isAggressiveAction(a));
    if (betIdx >= 0 && acts.slice(betIdx + 1).some((a) => isCallAction(a))) {
      tags.push('river_raise_paidoff');
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

  // V24 KICKER DISCIPLINE (2026-08-30): the 08-29 GTO sweep's three biggest
  // showdown losses were all the same shape — trips on a paired board with a
  // dominated kicker committing a full stack (QT on 2-T-T-5-J for 453.9bb,
  // QJ on J-6-J-T-K for 440bb, AJ on A-3-T-Q-A for 437bb) — and two more in
  // the top five were top pair with a rag kicker jamming 300bb. None of them
  // carried anything beyond the generic river_aggr_lost, because the nut
  // discipline block above knows flushes, straights and boats but nothing on
  // the pair ladder. These tags COUNT the pattern so the self-tuner and the
  // nightly audit can see it; no strategy dial moves here (that needs league
  // measurement per the standing rule).
  if (
    !vi.isOmaha &&
    row.wentToShowdown &&
    row.holeCards &&
    row.holeCards.length === 2 &&
    row.board &&
    row.board.length >= 5 &&
    investedBB >= 2 * FLAG_BB
  ) {
    try {
      const rv = (card: Card): number => RANK_VALUES[card.rank];
      const boardCount = new Map<number, number>();
      for (const bc of row.board) boardCount.set(rv(bc), (boardCount.get(rv(bc)) ?? 0) + 1);
      const [h1, h2] = row.holeCards;
      const r1 = rv(h1);
      const rr2 = rv(h2);
      // Trips by pairing a doubled board rank with EXACTLY one hole card.
      // (Two hole cards of that rank is quads; a kicker that also matches a
      // board rank is a full house — both stronger shapes, both excluded.)
      const tripRank = [...boardCount].find(([r, n]) => n === 2 && (r1 === r) !== (rr2 === r))?.[0];
      if (tripRank !== undefined) {
        const kicker = r1 === tripRank ? rr2 : r1;
        const kickerFillsBoat = (boardCount.get(kicker) ?? 0) >= 1;
        // An ace kicker cannot be out-kicked; anything below it can.
        if (!kickerFillsBoat && kicker < 14) {
          tags.push('weak_kicker_trips_stackoff');
        }
      } else if (r1 !== rr2) {
        // Top pair on an unpaired top rank with a kicker nine or worse.
        const topBoard = Math.max(...boardCount.keys());
        const pairsTop =
          (boardCount.get(topBoard) ?? 0) === 1 && (r1 === topBoard) !== (rr2 === topBoard);
        if (pairsTop) {
          const kicker = r1 === topBoard ? rr2 : r1;
          if (kicker <= 9 && (boardCount.get(kicker) ?? 0) === 0) {
            tags.push('top_pair_weak_kicker_stackoff');
          }
        }
      }
    } catch {
      /* detector is best-effort */
    }
  }

  // ═══ V38 PLO STACKOFF DISCIPLINE (Dan 2026-09-03) ═══════════════════════
  //
  // Dan flagged hand #5428599 (PLO6 1/2, Midway Union): the horse held
  // A-A-J-9-8-4, opened 2.5x, called a pot 3-bet, called a pot-sized flop bet,
  // then bet the paired turn and called off 86% of a 169 stack into a
  // check-raise all-in from the preflop 3-bettor. It had trip nines. The
  // villain had sixes full. Stated accurately: the horse held roughly ten
  // outs to nines-full, so it was a THIN LOSING CALL and not a drawing-dead
  // one - and the larger error was the 2.5x open that built the pot, which is
  // the sizing fix in HorsePreflop.
  //
  // This is the second instance of a shape the 2026-09-02 audit panel had
  // already proposed off hand 103011 - PLO6, turn stackoff, trips into
  // aggression - and NEITHER hand carried a leak tag, because the Omaha nut
  // block above knows flushes, straights and boats and nothing on the trips
  // or one-pair rungs. These tags COUNT the pattern so the self-tuner, the
  // nightly audit and the horses console can see it repeat. NO STRATEGY DIAL
  // MOVES HERE: a stackoff threshold or a calling range is strategy and needs
  // scenario tests plus a league matchup with significance, per the standing
  // rule. A detector is a measurement.
  if (
    vi.isOmaha &&
    row.wentToShowdown &&
    row.holeCards &&
    row.board &&
    row.board.length >= 5 &&
    investedBB >= PLO_STACKOFF_BB
  ) {
    try {
      const st = omahaNutStatus(row.holeCards, row.board);
      if (st.category === CAT_TRIPS) {
        const threats = omahaBoardThreats(row.board);
        if (threats.fullHouseLive || threats.flushLive || threats.straightLive) {
          // ── TRIPS AND SETS ARE NOT THE SAME LEAK (2026-09-05) ──
          // Three of a kind is one category number, but the two shapes are
          // different decisions: TRIPS is one hole card on a board pair (the
          // #5428599 shape, and the 09-02 panel's hand 103011 - both of
          // which this tag was written for); a SET is a pocket pair on an
          // unpaired board, hidden, with boat and straight redraws of its
          // own. Measured 2026-09-04: 275 of 419 plo_naked_trips_stackoff
          // tags were sets on unpaired boards (review 235357: top set on
          // Q-J-T), and HorseLogic's PLO_STACKOFF_TAGS reads this tag as a
          // rate into ploStackoffLoad, so V40 was being pushed by a hand it
          // was never meant to count. The board decides which is which: a
          // category-4 hand on a paired board is trips (a pocket pair on a
          // paired board would be a boat or quads, never trips); on an
          // unpaired board it can only be a set.
          tags.push(boardHasPair(row.board) ? 'plo_naked_trips_stackoff' : 'plo_set_stackoff');
        }
      } else if (st.category === CAT_FULL_HOUSE) {
        // ── THE PLO UNDER-FULL (2026-09-05) ──
        // The V15 nut block knows flushes and straights; nlhNutStatus's
        // `underfull` is hold'em only; and HorseLogic's dominated21 brake
        // excludes Omaha for full houses. So the day's three biggest PLO
        // losses on 2026-09-04 carried no Omaha tag at all: sixes full
        // re-raising a river on 7-4-2-7-6 into sevens full (review 190517,
        // -527bb), fives full of THREES - the worst boat on 5-6-8-3-5 -
        // raising and then shoving over a river 3-bet (182170, -523bb),
        // sixes full of nines 3-betting a paired turn (190109, -519bb).
        // This is the Omaha mirror of the sixes-full-on-JJ66x incident V21
        // was written for. The test is exhaustive and cheap at this rate:
        // is there ANY two-card holding, from the cards hero cannot see,
        // that makes a bigger full house or quads on this exact board.
        if (!omahaBoatIsNut(row.holeCards, row.board)) {
          tags.push('plo_underfull_stackoff');
        }
      } else if (st.category <= CAT_ONE_PAIR) {
        // At most one pair with a full stack in. By the river every redraw has
        // resolved, so a hand that still shows one pair is one that had no
        // wrap, no flush and no nut redraw arrive - the second shape the audit
        // panel proposed (plo_toppair_no_redraw_stackoff).
        tags.push('plo_toppair_no_redraw_stackoff');
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
      .map((a) => ({
        action: a.action,
        stage: a.stage,
        amount: a.amount,
        isFullRaise: a.isFullRaise,
      }));
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
