/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * HORSE MIND — Real-Time Opponent Intelligence (V3 — 2026-07-23)
 * ═══════════════════════════════════════════════════════════════════════════════
 * The V3 upgrade layer on top of the V2 decision engine. HorseLogic computes
 * WHAT the hand is worth; HorseMind computes WHO it is worth it against.
 *
 * Capabilities (all real-time, all inside the millisecond decision budget):
 *  1. LIVE OPPONENT STATS — VPIP / PFR / 3-bet / aggression factor /
 *     fold-vs-aggression per player, accumulated from the action stream the
 *     engine already passes to every decision. No DB reads, no async, bounded
 *     memory. Works identically for horses and real players at the table.
 *  2. RANGE READING — each live opponent's preflop line THIS hand (limp /
 *     open / call / 3-bet / blind-check) maps to a hand-strength band,
 *     tightened or loosened by that specific player's observed PFR & 3-bet
 *     tendencies. A nit's open means a different range than a maniac's.
 *     V5 (2026-07-24): the band keeps narrowing street by street — every
 *     postflop bet or raise raises the floor of the read.
 *  3. RANGE-CONDITIONED SAMPLING — the Monte Carlo equity loop deals opponent
 *     hole cards FROM their read range instead of uniformly at random. Top
 *     pair vs a 3-bettor is finally priced like top pair vs a 3-bettor.
 *  4. EXPLOIT ADJUSTMENTS — bluff more into players who fold too much, value
 *     bet thinner and bluff less into stations, call down lighter vs maniacs,
 *     respect the raises of passive players. Confidence-weighted so small
 *     samples do not cause wild adjustments.
 *  5. BOARD TEXTURE — wetness scoring (flush/straight coordination, pairing)
 *     drives bet sizing (small on dry, big on wet) and bluff discipline.
 *  6. BLOCKER AWARENESS — nut-flush-blocker and top-straight-blocker checks
 *     upgrade bluff candidate selection on coordinated boards.
 *
 * ZERO external dependencies beyond engine types. All state is in-process,
 * bounded, and shared across tables (stats are per-player, table-agnostic).
 * NEVER refer to the horses as "bots" — they are HORSES only.
 */

import type { Card, SeatPlayer, ActionRecord } from '../types.js';
import { RANK_VALUES } from './PokerEngine.js';

// ─────────────────────────────────────────────────────────────────────────────
// OPPONENT STATS
// ─────────────────────────────────────────────────────────────────────────────

export interface OpponentStats {
  /** distinct hands this player has been observed in */
  hands: number;
  /** hands where they voluntarily put money in preflop */
  vpip: number;
  /** hands where their first voluntary preflop action was a raise */
  pfr: number;
  /** hands where they re-raised preflop */
  threeBet: number;
  /** aggressive actions (bet / raise / full-raise all-in), all streets */
  aggr: number;
  /** passive actions (calls), all streets */
  passive: number;
  /** folds observed (folds face aggression by definition of a legal fold) */
  folds: number;
  /** times they faced aggression (called, raised over, or folded to a bet) */
  facedAggr: number;
}

const freshStats = (): OpponentStats => ({
  hands: 0,
  vpip: 0,
  pfr: 0,
  threeBet: 0,
  aggr: 0,
  passive: 0,
  folds: 0,
  facedAggr: 0,
});

/** Exploit multipliers derived from a specific opponent's tendencies. */
export interface ExploitProfile {
  /** multiply bluff/semi-bluff frequency by this (1 = neutral) */
  bluffMod: number;
  /** >1 = call their aggression lighter; <1 = respect it more */
  callDownMod: number;
  /** >1 = value bet thinner into this player */
  valueThinMod: number;
}

const NEUTRAL_EXPLOIT: ExploitProfile = { bluffMod: 1, callDownMod: 1, valueThinMod: 1 };

// ─────────────────────────────────────────────────────────────────────────────
// BOARD TEXTURE
// ─────────────────────────────────────────────────────────────────────────────

export interface BoardTexture {
  /** 0 = bone dry, 1 = maximally coordinated */
  wetness: number;
  /** 3+ cards of one suit on board */
  monotone: boolean;
  /** exactly 2 of one suit (flush draw possible) */
  twoTone: boolean;
  paired: boolean;
  /** 3+ ranks within a 5-rank window (straights live) */
  straighty: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// HORSE MIND
// ─────────────────────────────────────────────────────────────────────────────

const MAX_TRACKED_PLAYERS = 4000;
const MAX_SEEN_ACTIONS = 60_000;
const MAX_HAND_FLAGS = 20_000;

export class HorseMind {
  private static stats = new Map<string, OpponentStats>();
  /** dedupe of processed ActionRecords across repeated decide() calls */
  private static seenActions = new Set<string>();
  /** per (handKey|userId) preflop-participation flags already counted */
  private static handFlags = new Set<string>();

  // ───────────────────────────────────────────────────────────────────────────
  // OBSERVATION — ingest the action stream (idempotent, bounded)
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Ingest the current hand's action history. Called at the top of every
   * horse decision; every record is processed exactly once no matter how many
   * times the same history is replayed across turns or tables.
   */
  static observe(history: ActionRecord[] | undefined, _players: SeatPlayer[]): void {
    if (!history || history.length === 0) return;

    // Bounded-memory guards: generation-swap when limits are hit.
    if (this.seenActions.size > MAX_SEEN_ACTIONS) this.seenActions.clear();
    if (this.handFlags.size > MAX_HAND_FLAGS) this.handFlags.clear();
    if (this.stats.size > MAX_TRACKED_PLAYERS) this.stats.clear();

    // The first action's timestamp identifies the hand (stable across turns).
    const handKey = `${history[0].timestamp}:${history[0].userId}`;
    let preflopRaises = 0;

    for (const a of history) {
      const preflop = a.stage === 'preflop';
      const isAggr = a.action === 'bet' || a.action === 'raise' || (a.action === 'all_in' && a.isFullRaise === true);
      const actKey = `${a.timestamp}:${a.userId}:${a.action}:${a.amount}`;
      const isNew = !this.seenActions.has(actKey);
      if (isNew) this.seenActions.add(actKey);

      let s = this.stats.get(a.userId);
      if (!s) {
        s = freshStats();
        this.stats.set(a.userId, s);
      }

      if (isNew) {
        // Hand participation (once per hand per player)
        const seenKey = `${handKey}|${a.userId}|seen`;
        if (!this.handFlags.has(seenKey)) {
          this.handFlags.add(seenKey);
          s.hands++;
        }

        // Preflop VPIP / PFR / 3-bet (first voluntary action only)
        if (preflop) {
          const voluntary = a.action === 'call' || a.action === 'bet' || a.action === 'raise' || a.action === 'all_in';
          if (voluntary) {
            const vKey = `${handKey}|${a.userId}|vpip`;
            if (!this.handFlags.has(vKey)) {
              this.handFlags.add(vKey);
              s.vpip++;
              if (isAggr) {
                s.pfr++;
                if (preflopRaises >= 1) s.threeBet++;
              }
            }
          }
        }

        // Aggression factor + fold-vs-aggression, all streets
        if (isAggr) s.aggr++;
        else if (a.action === 'call') {
          s.passive++;
          s.facedAggr++;
        } else if (a.action === 'fold') {
          s.folds++;
          s.facedAggr++;
        }
      }

      if (preflop && isAggr) preflopRaises++;
    }
  }

  /** Read-only access for diagnostics/tests. */
  static getStats(userId: string): OpponentStats | undefined {
    return this.stats.get(userId);
  }

  /** Test hook: wipe all memory. */
  static reset(): void {
    this.stats.clear();
    this.seenActions.clear();
    this.handFlags.clear();
  }

  // ───────────────────────────────────────────────────────────────────────────
  // RANGE READING — preflop line THIS hand -> strength band, stat-adjusted
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Returns the [lo, hi] preflop-strength band this opponent's current-hand
   * line represents, or null when nothing is known (sample uniformly).
   * Bands are in the same 0..1 percentile space as the preflop classifiers.
   */
  static bandFor(
    userId: string,
    history: ActionRecord[] | undefined,
    bigBlind: number
  ): [number, number] | null {
    if (!history || history.length === 0) return null;

    let raisesBefore = 0;
    let line: 'none' | 'limp' | 'call' | 'open' | 'threebet' | 'check' = 'none';
    // V5 (2026-07-24): dynamic hand reading — postflop actions keep narrowing
    // the band. Track the streets on which this player bet/raised.
    const aggrStreets = new Set<string>();
    for (const a of history) {
      const isAggr = a.action === 'bet' || a.action === 'raise' || (a.action === 'all_in' && a.isFullRaise === true);
      if (a.stage !== 'preflop') {
        if (a.userId === userId) {
          if (a.action === 'fold') return null;
          if (isAggr) aggrStreets.add(a.stage);
        }
        continue;
      }
      if (a.userId === userId) {
        if (isAggr) {
          line = raisesBefore >= 1 ? 'threebet' : 'open';
        } else if (a.action === 'call') {
          // Only upgrade a limp to call-of-raise; never downgrade a raise line
          if (line === 'none' || line === 'limp' || line === 'check') {
            line = raisesBefore >= 1 ? 'call' : 'limp';
          }
        } else if (a.action === 'check' && line === 'none') {
          line = 'check';
        } else if (a.action === 'fold') {
          return null; // folded players are not sampled anyway
        }
      }
      if (isAggr) raisesBefore++;
    }
    void bigBlind;

    if (line === 'none') return null;

    let lo: number;
    let hi: number;
    switch (line) {
      case 'limp':
        lo = 0.15; hi = 0.72; // speculative + traps; excludes pure junk & most premiums
        break;
      case 'call':
        lo = 0.3; hi = 0.86; // calling a raise: playables, minus junk, minus most 4-bet hands
        break;
      case 'open':
        lo = 0.4; hi = 1.0;
        break;
      case 'threebet':
        lo = 0.62; hi = 1.0;
        break;
      case 'check':
      default:
        lo = 0.0; hi = 0.8; // BB free check: capped range
        break;
    }

    // Adjust by observed tendencies (confidence-weighted).
    const s = this.stats.get(userId);
    if (s && s.hands >= 8) {
      const conf = Math.min(1, s.hands / 25);
      const pfrRate = s.pfr / s.hands;
      if (line === 'open' || line === 'threebet') {
        if (pfrRate < 0.1) lo += 0.12 * conf; // a nit raised: tighten the read
        else if (pfrRate > 0.3) lo -= 0.1 * conf; // a maniac raised: widen it
      }
      const vpipRate = s.vpip / s.hands;
      if (line === 'limp' || line === 'call') {
        if (vpipRate > 0.5) lo -= 0.08 * conf; // loose caller: more junk in range
        else if (vpipRate < 0.18) lo += 0.08 * conf; // tight caller: real hand
      }
    }

    // V5: every postflop street they bet or raised narrows the read upward.
    // A flop-and-turn barreller is priced as strong, not as their preflop
    // range. Capped so even a triple barrel leaves bluffs in the range.
    if (aggrStreets.size > 0) {
      lo += Math.min(0.2, aggrStreets.size * 0.07);
      hi = Math.min(1, hi + 0.05); // aggression uncaps the top of the range
    }

    lo = Math.max(0, Math.min(0.9, lo));
    hi = Math.max(lo + 0.1, Math.min(1, hi));
    return [lo, hi];
  }

  /**
   * V5: true when the previous street checked through — nobody bet or raised
   * on it. A missed c-bet / checked-through street caps the field's ranges
   * and invites a probe.
   */
  static streetCheckedThrough(
    history: ActionRecord[] | undefined,
    prevStage: 'flop' | 'turn'
  ): boolean {
    if (!history || history.length === 0) return false;
    let sawStreet = false;
    for (const a of history) {
      if (a.stage !== prevStage) continue;
      sawStreet = true;
      if (a.action === 'bet' || a.action === 'raise' || a.action === 'all_in') return false;
    }
    return sawStreet;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // EXPLOIT PROFILE — how to deviate vs this specific player
  // ───────────────────────────────────────────────────────────────────────────

  static exploit(userId: string): ExploitProfile {
    const s = this.stats.get(userId);
    if (!s || s.hands < 10) return NEUTRAL_EXPLOIT;

    const conf = Math.min(1, s.hands / 30);
    const blend = (target: number) => 1 + (target - 1) * conf;

    let bluffMod = 1;
    let callDownMod = 1;
    let valueThinMod = 1;

    // Fold-vs-aggression: bluff the folders, hammer value into the stations.
    if (s.facedAggr >= 8) {
      const foldRate = s.folds / s.facedAggr;
      if (foldRate > 0.62) bluffMod = blend(1.45);
      else if (foldRate < 0.35) {
        bluffMod = blend(0.55);
        valueThinMod = blend(1.25);
      }
    }

    // Aggression factor: maniacs get called down lighter; passives get respect.
    const af = s.aggr / Math.max(1, s.passive);
    if (s.aggr + s.passive >= 12) {
      if (af > 2.5) callDownMod = blend(1.2);
      else if (af < 0.7) callDownMod = blend(0.85);
    }

    return { bluffMod, callDownMod, valueThinMod };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // BOARD TEXTURE
  // ───────────────────────────────────────────────────────────────────────────

  static texture(board: Card[]): BoardTexture {
    if (!board || board.length < 3) {
      return { wetness: 0.3, monotone: false, twoTone: false, paired: false, straighty: false };
    }

    const suitCount = new Map<string, number>();
    const rankCount = new Map<number, number>();
    const ranks: number[] = [];
    for (const c of board) {
      suitCount.set(c.suit, (suitCount.get(c.suit) || 0) + 1);
      const r = RANK_VALUES[c.rank];
      rankCount.set(r, (rankCount.get(r) || 0) + 1);
      ranks.push(r);
    }
    const maxSuit = Math.max(...suitCount.values());
    const monotone = maxSuit >= 3;
    const twoTone = maxSuit === 2;
    const paired = [...rankCount.values()].some((c) => c >= 2);

    // Straight coordination: 3+ distinct ranks inside any 5-rank window
    const unique = [...new Set(ranks)].sort((a, b) => a - b);
    let straighty = false;
    for (let i = 0; i < unique.length; i++) {
      let inWindow = 1;
      for (let j = i + 1; j < unique.length; j++) {
        if (unique[j] - unique[i] <= 4) inWindow++;
      }
      if (inWindow >= 3) {
        straighty = true;
        break;
      }
    }
    // Ace-low wheel window
    if (!straighty && unique.includes(14)) {
      const lows = unique.filter((r) => r <= 5).length;
      if (lows >= 2) straighty = true;
    }

    let wetness = 0;
    if (monotone) wetness += 0.4;
    else if (twoTone) wetness += 0.18;
    if (straighty) wetness += 0.3;
    // Mid-card boards connect with more ranges than ace-high dry boards
    const high = Math.max(...ranks);
    if (high <= 11) wetness += 0.12;
    if (paired) wetness -= 0.08; // paired boards kill draw combos
    wetness = Math.max(0, Math.min(1, wetness));

    return { wetness, monotone, twoTone, paired, straighty };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // BLOCKERS — is this hand a GOOD bluff candidate on this board?
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * True when hero holds a card that meaningfully blocks the nuts:
   * the ace (or king) of a 2-3 flush-suit board without the flush itself,
   * or a card completing the board's top straight.
   */
  static hasBlocker(hole: Card[], board: Card[]): boolean {
    if (!board || board.length < 3 || !hole || hole.length === 0) return false;

    // Flush blockers
    const suitCount = new Map<string, number>();
    for (const c of board) suitCount.set(c.suit, (suitCount.get(c.suit) || 0) + 1);
    for (const [suit, count] of suitCount) {
      if (count >= 2) {
        const heroSuited = hole.filter((c) => c.suit === suit);
        const hasAceBlocker = heroSuited.some((c) => c.rank === 'A' || c.rank === 'K');
        // Holding A/K of the suit WITHOUT a made flush = prime bluff blocker
        if (hasAceBlocker && heroSuited.length + count < 5) return true;
      }
    }

    // Top-straight blockers: hero holds a rank that completes the highest
    // straight the board allows.
    const boardRanks = [...new Set(board.map((c) => RANK_VALUES[c.rank]))].sort((a, b) => b - a);
    for (const hc of hole) {
      const hr = RANK_VALUES[hc.rank];
      let within = 0;
      for (const br of boardRanks) {
        if (Math.abs(hr - br) <= 4 && hr !== br) within++;
      }
      if (within >= 3 && hr >= 10) return true;
    }
    return false;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // RANGE-BAND SAMPLING SUPPORT
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Build the per-opponent band list for an equity simulation: live (unfolded,
   * not-hero) opponents in table order, each mapped through bandFor().
   */
  static bandsForOpponents(
    heroSeat: number,
    players: SeatPlayer[],
    history: ActionRecord[] | undefined,
    bigBlind: number
  ): Array<[number, number] | null> {
    const bands: Array<[number, number] | null> = [];
    for (const p of players) {
      if (p.seat === heroSeat || p.is_folded || p.is_sitting_out) continue;
      bands.push(this.bandFor(p.user_id, history, bigBlind));
    }
    return bands;
  }

  /**
   * Aggregate exploit profile of the live opposition. When heads-up this is
   * simply that player's profile; multiway it is the confidence-weighted blend
   * (bluffs must get through EVERYONE, so the blend leans conservative).
   */
  static tableExploit(heroSeat: number, players: SeatPlayer[]): ExploitProfile {
    const opps = players.filter((p) => p.seat !== heroSeat && !p.is_folded && !p.is_sitting_out);
    if (opps.length === 0) return NEUTRAL_EXPLOIT;
    if (opps.length === 1) return this.exploit(opps[0].user_id);

    let bluffMod = 1;
    let callDownMod = 0;
    let valueThinMod = 0;
    for (const o of opps) {
      const e = this.exploit(o.user_id);
      bluffMod = Math.min(bluffMod, e.bluffMod); // weakest link gates bluffs
      callDownMod += e.callDownMod;
      valueThinMod += e.valueThinMod;
    }
    return {
      bluffMod,
      callDownMod: callDownMod / opps.length,
      valueThinMod: valueThinMod / opps.length,
    };
  }
}
