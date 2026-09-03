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
  // ── V16 DEEP READS (2026-08-26) — observed once per COMPLETED hand ──
  /** times they called preflop then faced the aggressor's flop c-bet */
  cbetOpps: number;
  /** ... and folded to it */
  cbetFolds: number;
  /** times their open raise got 3-bet */
  f3bOpps: number;
  /** ... and they folded to the 3-bet */
  f3bFolds: number;
  /** showdowns reached after they made a BIG river bet (>= 20bb) */
  bigBetSD: number;
  /** ... where the shown hand was two pair or better (value, not air) */
  bigBetSDStrong: number;
  // ── V23 RIVER READS (2026-08-28). The most profitable read in the game:
  // does this player fold rivers? Memory-only until V34 (2026-09-02), when
  // it was found that every deploy forgot the answer for exactly the players
  // the read is for; persisted now, GREATEST-merged like every counter.
  /** times they faced a river bet or raise */
  riverBetOpps: number;
  /** ... and folded to it */
  riverBetFolds: number;
  /** V7 recency window (exponentially decayed) — detects counter-adaptation */
  rHands: number;
  rFolds: number;
  rFacedAggr: number;
  rAggr: number;
  rPassive: number;
  /** V28: checks, lifetime + recent — the missing denominator of the V18
   *  self-image (aggression / actions the table SAW, not aggr / (aggr+calls),
   *  which inverted the read for both the nit and the station). */
  checks: number;
  /** POSTFLOP-ONLY aggression counters (2026-08-31). The classic Aggression
   *  Factor is a postflop statistic: preflop calling is structurally normal
   *  (blinds, position, price), so folding it into the same ratio drags a
   *  loose-preflop / hyper-aggressive-postflop player below the "passive"
   *  bar — and then the horses give that player's POT BETS more respect. */
  postAggr: number;
  postPassive: number;
  rChecks: number;
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
  cbetOpps: 0,
  cbetFolds: 0,
  f3bOpps: 0,
  f3bFolds: 0,
  bigBetSD: 0,
  bigBetSDStrong: 0,
  riverBetOpps: 0,
  riverBetFolds: 0,
  rHands: 0,
  rFolds: 0,
  rFacedAggr: 0,
  rAggr: 0,
  rPassive: 0,
  checks: 0,
  rChecks: 0,
  postAggr: 0,
  postPassive: 0,
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

/** V16: hand names that count as VALUE behind a big river bet. */
const STRONG_HAND_NAMES = new Set([
  'two pair',
  'three of a kind',
  'straight',
  'flush',
  'full house',
  'four of a kind',
  'straight flush',
  'royal flush',
]);

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

/**
 * V12.3: drop the oldest entries until `size` is back under `cap` (a quarter
 * of the cap is reclaimed, so this amortizes to O(1) per observe call).
 * Returns the evicted keys so a parallel dirty-set can be pruned with them.
 * Map and Set iterate in insertion order, which is what makes "oldest" here
 * mean "least recently first seen" — and what keeps hands in flight, always
 * among the newest entries, safe from eviction.
 */
function evictOldest<K>(store: Map<K, unknown> | Set<K>, cap: number): K[] {
  if (store.size <= cap) return [];
  const target = Math.max(0, Math.floor(cap * 0.75));
  const evicted: K[] = [];
  for (const key of store.keys() as IterableIterator<K>) {
    if (store.size - evicted.length <= target) break;
    evicted.push(key);
  }
  for (const key of evicted) (store as Map<K, unknown>).delete(key);
  return evicted;
}

/** A spare, isolated set of HorseMind's state containers (V12.2). Opaque to
 *  callers — create with HorseMind.createSandbox(), use via runInSandbox(). */
export interface HorseMindSandbox {
  stats: Map<string, OpponentStats>;
  seenActions: Set<string>;
  handFlags: Set<string>;
  dirty: Set<string>;
  pairs: Map<string, { n3: number; opp3: number; nR: number; oppR: number }>;
  dirtyPairs: Set<string>;
  plans: Map<string, boolean>;
  /** V23: raise-response plans — see noteRaisePlan. Sandboxed like plans. */
  raisePlans: Map<string, RaiseResponsePlan>;
  /** V39: next-street outlooks — see noteOutlook. Sandboxed like plans. */
  outlooks: Map<string, { good: Set<string>; scare: Set<string> }>;
}

/** V23: what hero decided AT BET TIME it would do about a raise. */
export type RaiseResponsePlan = 'commit' | 'callOnce' | 'foldToRaise';

export class HorseMind {
  private static stats = new Map<string, OpponentStats>();
  /** dedupe of processed ActionRecords across repeated decide() calls */
  private static seenActions = new Set<string>();
  /** per (handKey|userId) preflop-participation flags already counted */
  private static handFlags = new Set<string>();
  /** V12 persistence: userIds whose stats changed since the last DB flush. */
  private static dirty = new Set<string>();
  /** V12 ANTI-EXPLOIT: per-(attacker|victim) aggression targeting counters. */
  private static pairs = new Map<string, { n3: number; opp3: number; nR: number; oppR: number }>();
  private static readonly MAX_PAIRS = 20_000;
  /** V12 persistence: pair keys whose counters changed since the last flush. */
  private static dirtyPairs = new Set<string>();

  // ───────────────────────────────────────────────────────────────────────
  // OBSERVATION — ingest the action stream (idempotent, bounded)
  // ───────────────────────────────────────────────────────────────────────

  /**
   * Ingest the current hand's action history. Called at the top of every
   * horse decision; every record is processed exactly once no matter how many
   * times the same history is replayed across turns or tables.
   */
  static observe(history: ActionRecord[] | undefined, _players: SeatPlayer[]): void {
    if (!history || history.length === 0) return;

    // The first action's timestamp identifies the hand (stable across turns).
    const handKey = `${history[0].timestamp}:${history[0].userId}`;

    // ── BOUNDED-MEMORY GUARDS (V12.3: evict oldest, never clear) ───────────
    // observe() runs at the TOP OF EVERY DECISION and many tables interleave,
    // so a wholesale .clear() could land in the middle of any hand in flight.
    // Every one of them corrupts data when it does, permanently, because the
    // DB merge is GREATEST-monotonic — an inflated counter never comes back:
    //   - clearing seenActions mid-hand makes this hand's already-counted
    //     actions look new again, double-counting aggr/passive/folds/facedAggr,
    //     the recency window, AND the pair counters;
    //   - clearing handFlags mid-hand lets `hands` and `vpip` fire twice for
    //     one hand, so VPIP can exceed hands;
    //   - clearing stats mid-hand leaves the hand flag set, so the wiped
    //     player accumulates actions against hands = 0.
    // A hand-boundary check cannot fix this (with N tables interleaved the
    // "current" hand changes on nearly every call). Evicting the OLDEST
    // entries does: Map and Set both iterate in insertion order, and a hand in
    // flight is by definition among the most recently inserted. Dropping the
    // oldest quarter keeps the caps honest and cannot touch live hands.
    evictOldest(this.seenActions, MAX_SEEN_ACTIONS);
    evictOldest(this.handFlags, MAX_HAND_FLAGS);
    if (this.stats.size > MAX_TRACKED_PLAYERS) {
      // Stats are keyed by player, not by hand, so eviction drops the
      // least-recently-first-seen opponents. Their dirty entries go too — the
      // DB already holds what was flushed, and the merge is monotonic.
      for (const id of evictOldest(this.stats, MAX_TRACKED_PLAYERS)) this.dirty.delete(id);
    }
    if (this.pairs.size > this.MAX_PAIRS) {
      for (const k of evictOldest(this.pairs, this.MAX_PAIRS)) this.dirtyPairs.delete(k);
    }

    let preflopRaises = 0;
    // V12 anti-exploit: who opened this hand, and who bet each street —
    // needed to attribute 3-bets and bet-raises to (attacker, victim) pairs.
    let openerId: string | null = null;
    let streetBettor: string | null = null;
    let curStage: string = 'preflop';
    const pairOf = (attacker: string, victim: string) => {
      const k = `${attacker}|${victim}`;
      let p = this.pairs.get(k);
      if (!p) {
        p = { n3: 0, opp3: 0, nR: 0, oppR: 0 };
        this.pairs.set(k, p);
      }
      // V12 persistence: every pairOf() call site mutates a counter, so the
      // key is dirty by construction.
      this.dirtyPairs.add(k);
      return p;
    };

    for (const a of history) {
      const preflop = a.stage === 'preflop';
      // V28: the street change must be observed BEFORE the stat update reads
      // streetBettor, or the first action of a new street is judged against
      // the previous street's bettor. Moving the reset here is semantically
      // identical for the attribution block below (which used to do it).
      if (a.stage !== curStage) {
        curStage = a.stage;
        streetBettor = null;
      }
      const isAggr =
        a.action === 'bet' ||
        a.action === 'raise' ||
        (a.action === 'all_in' && a.isFullRaise === true);
      // V28 AUDIT FIX: "faced aggression" now means FACED AGGRESSION. The old
      // counters incremented facedAggr on every call and every fold — a limp
      // of the big blind counted as "faced aggression and did not fold", and
      // a raise-OVER a bet (the most aggressive answer there is) was excluded
      // from the denominator entirely. A player who folded 5, called 3 and
      // raised-over 10 read as a 62.5% folder and was classified a nit. Both
      // error directions fed exploit() and through tableExploit every
      // postflop bluff decision on the platform.
      const facingAggr = preflop
        ? preflopRaises >= 1
        : streetBettor != null && streetBettor !== a.userId;
      const actKey = `${a.timestamp}:${a.userId}:${a.action}:${a.amount}`;
      const isNew = !this.seenActions.has(actKey);
      if (isNew) this.seenActions.add(actKey);

      let s = this.stats.get(a.userId);
      if (!s) {
        s = freshStats();
        this.stats.set(a.userId, s);
      }

      if (isNew) {
        this.dirty.add(a.userId); // V12: schedule for the next DB flush
        // Hand participation (once per hand per player)
        const seenKey = `${handKey}|${a.userId}|seen`;
        if (!this.handFlags.has(seenKey)) {
          this.handFlags.add(seenKey);
          s.hands++;
          // V7 counter-adaptation: exponentially-decayed recency window
          // (half-life ~24 hands). Recent behavior shifts — an opponent who
          // STOPPED folding to our bluffs — show up here within ~20 hands
          // while the lifetime stats would take hundreds to move.
          s.rHands++;
          if (s.rHands >= 24) {
            s.rHands /= 2;
            s.rFolds /= 2;
            s.rFacedAggr /= 2;
            s.rAggr /= 2;
            s.rPassive /= 2;
            s.rChecks /= 2;
          }
        }

        // Preflop VPIP / PFR / 3-bet (first voluntary action only)
        if (preflop) {
          const voluntary =
            a.action === 'call' ||
            a.action === 'bet' ||
            a.action === 'raise' ||
            a.action === 'all_in';
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

        // Aggression factor + fold-vs-aggression, all streets (V28: faced-
        // aggression counters gated on facingAggr, raises-over included in
        // the denominator, and checks counted for the V18 self-image).
        if (isAggr) {
          s.aggr++;
          s.rAggr++;
          if (!preflop) s.postAggr++;
          if (facingAggr) {
            s.facedAggr++;
            s.rFacedAggr++;
          }
        } else if (a.action === 'call') {
          s.passive++;
          s.rPassive++;
          if (!preflop) s.postPassive++;
          if (facingAggr) {
            s.facedAggr++;
            s.rFacedAggr++;
          }
        } else if (a.action === 'check') {
          s.checks++;
          s.rChecks++;
        } else if (a.action === 'fold') {
          // A fold with no aggression to face is a blind surrender (SB fold
          // to limps, and the like) — it says nothing about fold-vs-
          // aggression, so it stays out of BOTH sides of that ratio.
          if (facingAggr) {
            s.folds++;
            s.facedAggr++;
            s.rFolds++;
            s.rFacedAggr++;
          }
        }
      }

      // V12 ANTI-EXPLOIT ATTRIBUTION — who attacks whom. isNew-gated so a
      // replayed history never double-counts a pair event. (Street reset
      // moved to the top of the loop — V28.)
      if (preflop) {
        if (isNew && openerId && a.userId !== openerId && preflopRaises === 1) {
          if (isAggr) {
            const p = pairOf(a.userId, openerId);
            p.n3++;
            p.opp3++;
          } else if (a.action === 'call' || a.action === 'fold') {
            pairOf(a.userId, openerId).opp3++;
          }
        }
        if (isAggr && preflopRaises === 0) openerId = a.userId;
      } else {
        if (isNew && streetBettor && a.userId !== streetBettor) {
          // V12.3: classify FIRST. pairOf() creates the entry and marks it
          // dirty, so calling it before the branch minted {0,0,0,0} rows for
          // every non-matching action (a short all-in, a check after a stale
          // bettor). Those rows were flushed to horse_mind_pairs and consumed
          // the MAX_PAIRS budget, whose overflow does a FULL clear() —
          // evicting genuine hunter profiles to make room for empty ones.
          const isRaiseOver =
            a.action === 'raise' || (a.action === 'all_in' && a.isFullRaise === true);
          const isPassiveResponse = a.action === 'call' || a.action === 'fold';
          if (isRaiseOver) {
            const p = pairOf(a.userId, streetBettor);
            p.nR++;
            p.oppR++;
          } else if (isPassiveResponse) {
            pairOf(a.userId, streetBettor).oppR++;
          }
          // ═══ V23 RIVER READS (2026-08-28) ═══ the same street-bettor
          // attribution, read for one more thing: how this player answers
          // RIVER aggression. Fold-to-river-bet is the read that prices both
          // river bluffs and thin value against them.
          if (curStage === 'river' && (isRaiseOver || isPassiveResponse)) {
            s.riverBetOpps++;
            if (a.action === 'fold') s.riverBetFolds++;
          }
        }
        if (isAggr) streetBettor = a.userId;
      }

      if (preflop && isAggr) preflopRaises++;
    }
  }

  // ───────────────────────────────────────────────────────────────────────
  // V12 ANTI-EXPLOIT — is this opponent HUNTING this horse?
  // ───────────────────────────────────────────────────────────────────────

  /**
   * 0..1 score of how hard `oppId` is targeting `heroId` specifically,
   * relative to that opponent's own global aggression rates. 0 = no evidence
   * (small sample, or their aggression toward hero matches how they play
   * everyone). Positive scores mean hero's opens are being 3-bet, and hero's
   * bets raised, at rates their global profile cannot explain — the
   * signature of a player who has singled this horse out.
   */
  static targetingOf(heroId: string, oppId: string): number {
    const p = this.pairs.get(`${oppId}|${heroId}`);
    if (!p) return 0;
    const g = this.stats.get(oppId);
    let score = 0;

    if (p.opp3 >= 6) {
      const pairRate = p.n3 / p.opp3;
      const globalRate = g && g.hands >= 10 ? Math.min(0.5, (g.threeBet / g.hands) * 3) : 0.12;
      const excess = pairRate - Math.max(globalRate * 1.5, 0.18);
      if (excess > 0) score += Math.min(0.6, excess * 1.6);
    }
    if (p.oppR >= 6) {
      const pairRate = p.nR / p.oppR;
      const excess = pairRate - 0.18; // baseline bet-raise rate
      if (excess > 0) score += Math.min(0.5, excess * 1.4);
    }
    return Math.min(1, score);
  }

  /** Test hook: read a pair's raw counters. */
  static getPair(
    attackerId: string,
    victimId: string
  ): { n3: number; opp3: number; nR: number; oppR: number } | undefined {
    return this.pairs.get(`${attackerId}|${victimId}`);
  }

  /** Stable per-hand key shared by observe(), plans, and callers. */
  static handKeyOf(history: ActionRecord[] | undefined): string | null {
    if (!history || history.length === 0) return null;
    return `${history[0].timestamp}:${history[0].userId}`;
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
    this.plans.clear();
    this.raisePlans.clear();
    this.outlooks.clear();
    this.dirty.clear();
    this.pairs.clear();
    this.dirtyPairs.clear();
  }

  // ───────────────────────────────────────────────────────────────────────
  // V12 PERSISTENCE (2026-08-22) — unlimited learning horizon
  // ───────────────────────────────────────────────────────────────────────

  /** Rows changed since the last flush. Snapshots AND clears the dirty set —
   *  the caller owns delivery; on failure it should re-mark via requeue(). */
  static exportDirty(): Array<{ user_id: string } & OpponentStats> {
    const out: Array<{ user_id: string } & OpponentStats> = [];
    for (const id of this.dirty) {
      const s = this.stats.get(id);
      if (s) out.push({ user_id: id, ...s });
    }
    this.dirty.clear();
    return out;
  }

  /** Put ids back on the dirty list after a failed flush. */
  static requeueDirty(ids: string[]): void {
    for (const id of ids) if (this.stats.has(id)) this.dirty.add(id);
  }

  static dirtyCount(): number {
    return this.dirty.size;
  }

  /**
   * Boot-time hydration from the DB. A row is applied only when it knows MORE
   * than memory does (more observed hands) — a late hydrate must never
   * downgrade stats the engine has already been accumulating live.
   * Returns the number of rows applied.
   */
  static importStats(rows: Array<{ user_id: string } & Partial<OpponentStats>>): number {
    let applied = 0;
    for (const r of rows) {
      if (!r || typeof r.user_id !== 'string' || r.user_id.length === 0) continue;
      const existing = this.stats.get(r.user_id);
      const incomingHands = typeof r.hands === 'number' && isFinite(r.hands) ? r.hands : 0;
      if (existing && existing.hands >= incomingHands) continue;
      if (this.stats.size >= MAX_TRACKED_PLAYERS && !existing) continue;
      const num = (v: unknown): number => (typeof v === 'number' && isFinite(v) && v >= 0 ? v : 0);
      // V28 AUDIT FIX: the import REPLACED the whole object, and the fields
      // that were unpersisted at the time (riverBet*, checks, the recency
      // window) came in as 0 — any live sample accumulated before the hydrate
      // was destroyed. Those fields keep the larger of live and incoming, so
      // a hydrate can only add information (V34 persists them, and a
      // snapshot older than that migration still reads them as 0).
      const keep = (live: number | undefined, incoming: number): number =>
        Math.max(existing ? (live ?? 0) : 0, incoming);
      this.stats.set(r.user_id, {
        hands: num(r.hands),
        vpip: num(r.vpip),
        pfr: num(r.pfr),
        threeBet: num(r.threeBet),
        aggr: num(r.aggr),
        passive: num(r.passive),
        folds: num(r.folds),
        facedAggr: num(r.facedAggr),
        cbetOpps: num(r.cbetOpps),
        cbetFolds: num(r.cbetFolds),
        f3bOpps: num(r.f3bOpps),
        f3bFolds: num(r.f3bFolds),
        bigBetSD: num(r.bigBetSD),
        bigBetSDStrong: num(r.bigBetSDStrong),
        riverBetOpps: keep(existing?.riverBetOpps, num(r.riverBetOpps)),
        riverBetFolds: keep(existing?.riverBetFolds, num(r.riverBetFolds)),
        rHands: keep(existing?.rHands, num(r.rHands)),
        rFolds: keep(existing?.rFolds, num(r.rFolds)),
        rFacedAggr: keep(existing?.rFacedAggr, num(r.rFacedAggr)),
        rAggr: keep(existing?.rAggr, num(r.rAggr)),
        rPassive: keep(existing?.rPassive, num(r.rPassive)),
        checks: keep(existing?.checks, num(r.checks)),
        postAggr: keep(existing?.postAggr, num((r as { postAggr?: number }).postAggr)),
        postPassive: keep(existing?.postPassive, num((r as { postPassive?: number }).postPassive)),
        rChecks: keep(existing?.rChecks, num(r.rChecks)),
      });
      applied++;
    }
    return applied;
  }

  /**
   * Pair rows changed since the last flush. Snapshots AND clears the dirty
   * set — the caller owns delivery; on failure it should re-mark via
   * requeueDirtyPairs().
   */
  static exportDirtyPairs(): Array<{
    attacker_id: string;
    victim_id: string;
    n3: number;
    opp3: number;
    nR: number;
    oppR: number;
  }> {
    const out: Array<{
      attacker_id: string;
      victim_id: string;
      n3: number;
      opp3: number;
      nR: number;
      oppR: number;
    }> = [];
    for (const k of this.dirtyPairs) {
      const p = this.pairs.get(k);
      if (!p) continue;
      const sep = k.indexOf('|');
      if (sep <= 0 || sep >= k.length - 1) continue;
      out.push({ attacker_id: k.slice(0, sep), victim_id: k.slice(sep + 1), ...p });
    }
    this.dirtyPairs.clear();
    return out;
  }

  /** Put pair keys back on the dirty list after a failed flush. */
  static requeueDirtyPairs(keys: Array<{ attacker_id: string; victim_id: string }>): void {
    for (const k of keys) {
      const key = `${k.attacker_id}|${k.victim_id}`;
      if (this.pairs.has(key)) this.dirtyPairs.add(key);
    }
  }

  /** V12.3: drop hydrated pair memory (used when a failed stats hydrate forces
   *  a full-window replay, which would otherwise double-count them). The DB
   *  copy is untouched — the next boot restores it. */
  static clearPairs(): void {
    this.pairs.clear();
    this.dirtyPairs.clear();
  }

  static dirtyPairsCount(): number {
    return this.dirtyPairs.size;
  }

  /**
   * Boot-time pair hydration from the DB. A row is applied only when it has
   * seen MORE opportunities (opp3 + oppR) than memory has — a late hydrate
   * must never downgrade counters the engine has been accumulating live.
   * Returns the number of rows applied.
   */
  static importPairs(
    rows: Array<{
      attacker_id: string;
      victim_id: string;
      n3?: number;
      opp3?: number;
      nR?: number;
      oppR?: number;
    }>
  ): number {
    let applied = 0;
    const num = (v: unknown): number =>
      typeof v === 'number' && isFinite(v) && v >= 0 ? Math.floor(v) : 0;
    for (const r of rows) {
      if (!r || typeof r.attacker_id !== 'string' || r.attacker_id.length === 0) continue;
      if (typeof r.victim_id !== 'string' || r.victim_id.length === 0) continue;
      const key = `${r.attacker_id}|${r.victim_id}`;
      const incoming = { n3: num(r.n3), opp3: num(r.opp3), nR: num(r.nR), oppR: num(r.oppR) };
      const existing = this.pairs.get(key);
      if (existing && existing.opp3 + existing.oppR >= incoming.opp3 + incoming.oppR) continue;
      if (!existing && this.pairs.size >= this.MAX_PAIRS) continue;
      this.pairs.set(key, incoming);
      applied++;
    }
    return applied;
  }

  // ───────────────────────────────────────────────────────────────────────
  // V12.2 SANDBOX (2026-08-22) — a pollution-free mind for self-play
  // ───────────────────────────────────────────────────────────────────────

  /**
   * The league runs thousands of synthetic hands inside the production
   * process. Until V12.2 it had to pass `mind:false`, because HorseMind's
   * state is static and shared — observing a synthetic hand would write
   * `league-*` reads into the live opponent memory (and into the DB via the
   * persistence flush). That meant the one layer the league could never
   * measure was the mind itself.
   *
   * A sandbox is a complete spare set of the seven state containers.
   * `runInSandbox` swaps them in, runs the callback, and swaps the live set
   * back in a finally — the callback is SYNCHRONOUS by contract, and every
   * HorseLogic.decide call is synchronous, so nothing else in the process
   * can observe the swapped state: timers and flushes only run when the
   * event loop yields, which it cannot do mid-callback. The sandbox's dirty
   * sets are never exported, so nothing synthetic can reach the DB.
   */
  private static sandboxDepth = 0;

  static createSandbox(): HorseMindSandbox {
    return {
      stats: new Map(),
      seenActions: new Set(),
      handFlags: new Set(),
      dirty: new Set(),
      pairs: new Map(),
      dirtyPairs: new Set(),
      plans: new Map(),
      raisePlans: new Map(),
      outlooks: new Map(),
    };
  }

  static runInSandbox<T>(sandbox: HorseMindSandbox, fn: () => T): T {
    if (this.sandboxDepth > 0) {
      // Nested sandboxes have no use case; refusing beats silently mixing
      // two sandboxes' state.
      throw new Error('HorseMind.runInSandbox: already inside a sandbox');
    }
    const live = {
      stats: this.stats,
      seenActions: this.seenActions,
      handFlags: this.handFlags,
      dirty: this.dirty,
      pairs: this.pairs,
      dirtyPairs: this.dirtyPairs,
      plans: this.plans,
      raisePlans: this.raisePlans,
      outlooks: this.outlooks,
    };
    this.stats = sandbox.stats;
    this.seenActions = sandbox.seenActions;
    this.handFlags = sandbox.handFlags;
    this.dirty = sandbox.dirty;
    this.pairs = sandbox.pairs;
    this.dirtyPairs = sandbox.dirtyPairs;
    this.plans = sandbox.plans;
    this.raisePlans = sandbox.raisePlans;
    this.outlooks = sandbox.outlooks;
    this.sandboxDepth = 1;
    try {
      return fn();
    } finally {
      this.stats = live.stats;
      this.seenActions = live.seenActions;
      this.handFlags = live.handFlags;
      this.dirty = live.dirty;
      this.pairs = live.pairs;
      this.dirtyPairs = live.dirtyPairs;
      this.plans = live.plans;
      this.raisePlans = live.raisePlans;
      this.outlooks = live.outlooks;
      this.sandboxDepth = 0;
    }
  }

  // ───────────────────────────────────────────────────────────────────────
  // RANGE READING — preflop line THIS hand -> strength band, stat-adjusted
  // ───────────────────────────────────────────────────────────────────────

  /**
   * Returns the [lo, hi] preflop-strength band this opponent's current-hand
   * line represents, or null when nothing is known (sample uniformly).
   * Bands are in the same 0..1 percentile space as the preflop classifiers.
   */
  static bandFor(
    userId: string,
    history: ActionRecord[] | undefined,
    bigBlind: number,
    sizedReads: boolean = true,
    board: Card[] | null = null,
    /** V12 out-param: postflop aggression weight + checked-street count for
     *  board-contact conditioning (see HorseEval.simulateEquity). */
    readOut?: { aggrW: number; checked: number; bigBet?: boolean }
  ): [number, number] | null {
    if (!history || history.length === 0) return null;
    const postStagesActed = new Set<string>();

    let raisesBefore = 0;
    let line: 'none' | 'limp' | 'call' | 'open' | 'threebet' | 'fourbet' | 'check' = 'none';
    // V36 (2026-09-02): a BOMB POT has no preflop street. Every hand at the
    // table is a random deal, which is the right BASE — but the postflop
    // narrowing below still applies, and it never did: `line` stayed 'none'
    // and the function returned null, so a player who bet the flop, barrelled
    // the turn and bombed the river of a bomb pot was still sampled from all
    // 1,326 combos. sawPreflop tells the two cases apart.
    let sawPreflop = false;
    let actedPostflop = false;
    // V5 (2026-07-24): dynamic hand reading — postflop actions keep narrowing
    // the band. V7: the narrowing is BET-SIZE AWARE via an exact pot replay —
    // a pot-sized turn barrel narrows far more than a min-bet. Per-street the
    // strongest sizing signal wins.
    const streetWeight = new Map<string, number>();
    // Pot replay state: recorded call amounts are increments; bet/raise/all_in
    // amounts are street totals, so increment = amount - actor's street bet.
    let pot = bigBlind > 0 ? bigBlind * 1.5 : 3; // SB+BB approximation
    let curStreet: string = 'preflop';
    let streetBets = new Map<string, number>();
    for (const a of history) {
      const isAggr =
        a.action === 'bet' ||
        a.action === 'raise' ||
        (a.action === 'all_in' && a.isFullRaise === true);
      const anyChips = isAggr || a.action === 'call' || a.action === 'all_in';
      if (a.stage === 'preflop') sawPreflop = true;
      if (a.stage !== curStreet) {
        curStreet = a.stage;
        streetBets = new Map();
      }
      const prevBet = streetBets.get(a.userId) || 0;
      let increment = 0;
      if (a.action === 'call') increment = a.amount;
      else if (anyChips) increment = Math.max(0, a.amount - prevBet);

      if (a.stage !== 'preflop') {
        if (a.userId === userId) {
          if (a.action === 'fold') return null;
          actedPostflop = true;
          // V28 AUDIT FIX: this used to add on ANY action, including CALL —
          // and readOut.checked below counts "acted with no aggression
          // weight" as a checked street. A player who CALLED two barrels —
          // the strongest passive range in poker — read as checked=2, and
          // the sampler then discarded their trips-or-better at 79%. Hero's
          // equity against a two-street caller was inflated by exactly the
          // top of their range, driving thin value and river bluffs into a
          // range that is calling. A CHECK is capped; a CALL is not.
          if (a.action === 'check') postStagesActed.add(a.stage);
          if (isAggr) {
            const potBefore = Math.max(bigBlind || 1, pot);
            const frac = increment / potBefore;
            // Size class -> narrowing weight. RETUNED (duplicate-deal
            // ablation): absolute size is a FALSE signal against texture-led
            // sizers — good players (and this engine) size UP on wet boards
            // with their whole range, so "big = strong" misreads a wet-board
            // semi-bluff as value and a dry-board value bet as weak. The real
            // signal is the DEVIATION from the texture-expected size: bigger
            // than the board warrants leans value; smaller leans weak.
            // Overbets stay polarized (nuts + bluffs) and narrow least.
            let w = 0.07;
            if (sizedReads) {
              const prefix =
                board && board.length >= 3
                  ? a.stage === 'flop'
                    ? board.slice(0, 3)
                    : a.stage === 'turn'
                      ? board.slice(0, 4)
                      : board.slice(0, 5)
                  : null;
              const expected = prefix ? 0.34 + 0.38 * this.texture(prefix).wetness : 0.55;
              const dev = frac - expected;
              if (frac > 1.3) w = 0.065;
              else if (dev > 0.35) w = 0.085;
              else if (dev < -0.2) w = 0.055;
            }
            streetWeight.set(a.stage, Math.max(streetWeight.get(a.stage) || 0, w));
          }
        }
        if (anyChips) {
          pot += increment;
          streetBets.set(a.userId, prevBet + increment);
        }
        continue;
      }
      if (anyChips) {
        pot += increment;
        streetBets.set(a.userId, prevBet + increment);
      }
      if (a.userId === userId) {
        if (isAggr) {
          // V28 AUDIT FIX: there was no 4-bet tier — any raise with a raise
          // in front read as 'threebet' [0.62, 1.0], the top ~11%. Real
          // 4-bet ranges are the top 2-3%, and this priced hero's hand
          // against a range four times too wide in the BIGGEST preflop pots
          // on the site. raisesBefore >= 2 is a 4-bet (or worse).
          line = raisesBefore >= 2 ? 'fourbet' : raisesBefore >= 1 ? 'threebet' : 'open';
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

    // V36: no preflop street (a bomb pot) and this player has acted postflop
    // — a random starting hand, narrowed by what they did with it.
    const anteOnly = !sawPreflop && actedPostflop;
    if (line === 'none' && !anteOnly) return null;

    let lo: number;
    let hi: number;
    if (line === 'none') {
      lo = 0;
      hi = 1;
    } else
      switch (line) {
        case 'limp':
          lo = 0.15;
          hi = 0.72; // speculative + traps; excludes pure junk & most premiums
          break;
        case 'call':
          lo = 0.3;
          hi = 0.86; // calling a raise: playables, minus junk, minus most 4-bet hands
          break;
        case 'open':
          lo = 0.4;
          hi = 1.0;
          break;
        case 'threebet':
          lo = 0.62;
          hi = 1.0;
          break;
        case 'fourbet':
          // V28: the 4-bet/5-bet tier — premiums plus the occasional bluff.
          lo = 0.86;
          hi = 1.0;
          break;
        case 'check':
        default:
          lo = 0.0;
          hi = 0.8; // BB free check: capped range
          break;
      }

    // Adjust by observed tendencies (confidence-weighted).
    const s = this.stats.get(userId);
    if (s && s.hands >= 8) {
      const conf = Math.min(1, s.hands / 25);
      const pfrRate = s.pfr / s.hands;
      if (line === 'open' || line === 'threebet' || line === 'fourbet') {
        if (pfrRate < 0.1)
          lo += 0.12 * conf; // a nit raised: tighten the read
        else if (pfrRate > 0.3) lo -= 0.1 * conf; // a maniac raised: widen it
      }
      const vpipRate = s.vpip / s.hands;
      if (line === 'limp' || line === 'call') {
        if (vpipRate > 0.5)
          lo -= 0.08 * conf; // loose caller: more junk in range
        else if (vpipRate < 0.18) lo += 0.08 * conf; // tight caller: real hand
      }
    }

    // V5/V7: every postflop street they bet or raised narrows the read
    // upward, weighted by bet size. A flop-and-turn pot-barreller is priced
    // as strong; a pair of min-bets barely moves the read. Capped so even a
    // triple barrel leaves bluffs in the range.
    if (streetWeight.size > 0) {
      let total = 0;
      for (const w of streetWeight.values()) total += w;
      lo += Math.min(0.22, total);
      hi = Math.min(1, hi + 0.05); // aggression uncaps the top of the range
    }
    // V12: expose the postflop line shape for board-contact conditioning.
    if (readOut) {
      let total = 0;
      for (const w of streetWeight.values()) total += w;
      readOut.aggrW = Math.min(0.3, total);
      let checked = 0;
      for (const st of postStagesActed) if (!streetWeight.has(st)) checked++;
      readOut.checked = checked;
      // V16 SIZE-CONDITIONED SAMPLING: did this opponent fire a BIG bet
      // (>= 20bb) on the newest street in the history? A pot-sized-plus
      // barrel is strength-heavier than a stab, and the sampler can use it.
      if (history && history.length > 0) {
        const lastStage = history[history.length - 1].stage;
        for (let i = history.length - 1; i >= 0; i--) {
          const a = history[i];
          if (a.stage !== lastStage) break;
          if (
            a.userId === userId &&
            (a.action === 'bet' || a.action === 'raise' || a.action === 'all_in') &&
            (a.amount ?? 0) >= 20 * (bigBlind > 0 ? bigBlind : 1)
          ) {
            readOut.bigBet = true;
            break;
          }
        }
      }
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

  // ───────────────────────────────────────────────────────────────────────
  // EXPLOIT PROFILE — how to deviate vs this specific player
  // ───────────────────────────────────────────────────────────────────────

  static exploit(userId: string, recencyBlend: boolean = true): ExploitProfile {
    const s = this.stats.get(userId);
    if (!s || s.hands < 10) return NEUTRAL_EXPLOIT;

    const conf = Math.min(1, s.hands / 30);
    const blend = (target: number) => 1 + (target - 1) * conf;

    let bluffMod = 1;
    let callDownMod = 1;
    let valueThinMod = 1;

    // Fold-vs-aggression: bluff the folders, hammer value into the stations.
    // V7 COUNTER-ADAPTATION: blend the lifetime rate with the exponentially
    // decayed recent window. An opponent who ADAPTS — starts calling down the
    // horse that was bluffing them — shifts the blended rate within ~20 hands
    // instead of hundreds, so the exploit backs off before it becomes a leak.
    // RETUNED (duplicate-deal ablation): the recent window only enters the
    // blend when it is STATISTICALLY INCOMPATIBLE with the lifetime rate
    // (change-point gate, ~2 standard errors). Against a stable opponent the
    // gate almost never opens, so the exploit keeps the low-variance lifetime
    // estimate; when an opponent genuinely changes gears the discrepancy is
    // large and persistent, the gate opens, and the blend adapts within ~20
    // hands. Unconditional blending paid a measurable noise tax for a benefit
    // that only exists when opponents actually adapt.
    if (s.facedAggr >= 8) {
      const lifetime = s.folds / s.facedAggr;
      let foldRate = lifetime;
      if (recencyBlend && s.rFacedAggr >= 6) {
        const recent = s.rFolds / s.rFacedAggr;
        const se = Math.sqrt(Math.max(0.04, lifetime * (1 - lifetime)) / s.rFacedAggr);
        if (Math.abs(recent - lifetime) > 2 * se) {
          const wr = Math.min(0.5, s.rFacedAggr / 32);
          foldRate = (1 - wr) * lifetime + wr * recent;
        }
      }
      if (foldRate > 0.62) {
        bluffMod = blend(1.45);
        // V28 AUDIT FIX: valueThinMod was only ever RAISED (stations), so the
        // documented "a nit calls only what a smaller bet asks" half of V18
        // exploit sizing was dead — the consumer multiplies by
        // (valueThinMod - 1) and the term could never be negative. A folder
        // now thins the value bar downward too.
        valueThinMod = blend(0.85);
      } else if (foldRate < 0.35) {
        bluffMod = blend(0.55);
        valueThinMod = blend(1.25);
      }
    }

    // Aggression factor: maniacs get called down lighter; passives get respect.
    // Same change-point gate as the fold-rate blend.
    // POSTFLOP-ONLY AF when there is enough of it (2026-08-31). Measured on
    // 58 live players with real samples: the all-streets ratio misclassified
    // TEN of them across a decision threshold — 2 genuine maniacs read as
    // normal, 8 more mis-bucketed — and the population average moved 1.87 ->
    // 1.37 when preflop calls came out. This ratio decides how much respect
    // an opponent's BETS get, so it must be measured where the bets are.
    // Falls back to the all-streets ratio until the postflop sample exists,
    // so a fresh opponent is never read from three hands of noise.
    const afLifetime =
      s.postPassive + s.postAggr >= 10
        ? s.postAggr / Math.max(1, s.postPassive)
        : s.aggr / Math.max(1, s.passive);
    let af = afLifetime;
    const rN = s.rAggr + s.rPassive;
    if (recencyBlend && rN >= 8) {
      const recentAf = s.rAggr / Math.max(1, s.rPassive);
      if (Math.abs(recentAf - afLifetime) > Math.max(0.6, 0.5 * afLifetime)) {
        const wa = Math.min(0.5, rN / 40);
        af = (1 - wa) * afLifetime + wa * recentAf;
      }
    }
    if (s.aggr + s.passive >= 12) {
      if (af > 2.5) callDownMod = blend(1.2);
      else if (af < 0.7) callDownMod = blend(0.85);
    }

    return { bluffMod, callDownMod, valueThinMod };
  }

  // ───────────────────────────────────────────────────────────────────────
  // V7 BARREL PLANS — per-hand multi-street bluff intent
  // ───────────────────────────────────────────────────────────────────────

  /**
   * When a horse fires a bluff/semi-bluff bet, it decides THEN whether this is
   * a one-and-done stab or a planned multi-street line. The plan is stored per
   * (hand, player) so the next street's decision tells a coherent story
   * instead of re-rolling the dice.
   */
  private static plans = new Map<string, boolean>();
  private static readonly MAX_PLANS = 8000;

  static notePlan(handKey: string | null, userId: string, barrelIntent: boolean): void {
    if (!handKey) return;
    // V28: evict the oldest quarter, never .clear() — see noteRaisePlan.
    if (this.plans.size > this.MAX_PLANS) evictOldest(this.plans, this.MAX_PLANS);
    this.plans.set(`${handKey}|${userId}`, barrelIntent);
  }

  static getPlan(handKey: string | null, userId: string): boolean | undefined {
    if (!handKey) return undefined;
    return this.plans.get(`${handKey}|${userId}`);
  }

  /**
   * ═══ V39 STREET OUTLOOK (2026-09-03) ═══ what the bet was thinking about
   * the next card: the cards that improve hero, the cards that scare hero.
   * Written beside the barrel plan when a bluff / semi-bluff fires; read on
   * the next street against the card that actually arrived. Same bounded
   * map discipline as every plan here.
   */
  private static outlooks = new Map<string, { good: Set<string>; scare: Set<string> }>();

  static noteOutlook(
    handKey: string | null,
    userId: string,
    street: string,
    good: string[],
    scare: string[]
  ): void {
    if (!handKey) return;
    if (this.outlooks.size > this.MAX_PLANS) evictOldest(this.outlooks, this.MAX_PLANS);
    this.outlooks.set(`${handKey}|${userId}|${street}`, {
      good: new Set(good),
      scare: new Set(scare),
    });
  }

  /** How the bet on `street` had classified `cardKey` before it came. */
  static outlookOf(
    handKey: string | null,
    userId: string,
    street: string,
    cardKey: string
  ): 'good' | 'scare' | 'blank' | undefined {
    if (!handKey) return undefined;
    const o = this.outlooks.get(`${handKey}|${userId}|${street}`);
    if (!o) return undefined;
    if (o.good.has(cardKey)) return 'good';
    if (o.scare.has(cardKey)) return 'scare';
    return 'blank';
  }

  /**
   * ═══ V23 RAISE-RESPONSE PLANS (2026-08-28) ═══
   * When a horse bets or raises postflop, it decides THEN what a raise back
   * would mean: commit (range top), call once (medium/draws — see a card,
   * never escalate), or fold (this was a stab). Stored per (hand, player,
   * street) so the answer to a check-raise is the one the bet already gave —
   * the big_fold_river/bet_fold_line reviews are full of lines where the bet
   * and the response to the raise were decided by two different dice rolls.
   */
  private static raisePlans = new Map<string, RaiseResponsePlan>();

  static noteRaisePlan(
    handKey: string | null,
    userId: string,
    street: string,
    plan: RaiseResponsePlan
  ): void {
    if (!handKey) return;
    // V28 AUDIT FIX: .clear() wiped EVERY hand in flight when the cap
    // tripped — the exact wholesale-clear failure mode the V12.3 doctrine at
    // the top of this file forbids for every other container. A cleared plan
    // meant the answer to a check-raise reverted to an independent dice roll:
    // the bet_fold_line reviews this feature exists to eliminate. Evict the
    // oldest quarter instead, like everything else here.
    if (this.raisePlans.size > this.MAX_PLANS) {
      evictOldest(this.raisePlans, this.MAX_PLANS);
    }
    this.raisePlans.set(`${handKey}|${userId}|${street}`, plan);
  }

  static getRaisePlan(
    handKey: string | null,
    userId: string,
    street: string
  ): RaiseResponsePlan | undefined {
    if (!handKey) return undefined;
    return this.raisePlans.get(`${handKey}|${userId}|${street}`);
  }

  /** V23: fold-to-river-bet frequency (0..1), or null below an
   *  8-opportunity sample. Memory-only — see the OpponentStats note. */
  static riverFoldRate(id: string): number | null {
    const s = this.stats.get(id);
    if (!s || s.riverBetOpps < 8) return null;
    return s.riverBetFolds / s.riverBetOpps;
  }

  // ───────────────────────────────────────────────────────────────────────
  // BOARD TEXTURE
  // ───────────────────────────────────────────────────────────────────────

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

  // ───────────────────────────────────────────────────────────────────────
  // BLOCKERS — is this hand a GOOD bluff candidate on this board?
  // ───────────────────────────────────────────────────────────────────────

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
    //
    // V28 AUDIT FIX: two provable misses. (1) No ace-low mapping — on
    // 2-3-4-9-K the nut straight is A-5 and a hero holding the ACE computed
    // |14-2| = 12, so the single best blocker on the board was invisible
    // (texture() next door handles the wheel; the two disagreed). (2) The
    // hr >= 10 floor — on 5-6-7-K-2 the nut straight is 9-8 and a hero
    // holding the NINE was rejected by rank. Blockers below the ten block
    // real straights. The consumer boosts blocker bluffs 1.5x on scare
    // cards, so each miss was a straight loss of bluff frequency exactly
    // where blockers matter most.
    const boardRanks = [...new Set(board.map((c) => RANK_VALUES[c.rank]))].sort((a, b) => b - a);
    const hasWheelWindow = boardRanks.filter((r) => r >= 2 && r <= 5).length >= 3;
    for (const hc of hole) {
      const hr = RANK_VALUES[hc.rank];
      // The ace blocks the wheel when the board carries the low window.
      if (hr === 14 && hasWheelWindow) return true;
      let within = 0;
      for (const br of boardRanks) {
        if (Math.abs(hr - br) <= 4 && hr !== br) within++;
      }
      if (within >= 3 && hr >= 6) return true;
    }
    return false;
  }

  // ───────────────────────────────────────────────────────────────────────
  // RANGE-BAND SAMPLING SUPPORT
  // ───────────────────────────────────────────────────────────────────────

  /**
   * Build the per-opponent band list for an equity simulation: live (unfolded,
   * not-hero) opponents in table order, each mapped through bandFor().
   */
  static bandsForOpponents(
    heroSeat: number,
    players: SeatPlayer[],
    history: ActionRecord[] | undefined,
    bigBlind: number,
    sizedReads: boolean = true,
    board: Card[] | null = null,
    /** V12 out-param: parallel per-opponent postflop reads (same order as
     *  the returned bands) for board-contact conditioning. */
    readsOut?: Array<{ aggrW: number; checked: number; bigBet?: boolean } | null>
  ): Array<[number, number] | null> {
    const bands: Array<[number, number] | null> = [];
    for (const p of players) {
      if (p.seat === heroSeat || p.is_folded || p.is_sitting_out) continue;
      const readOut = readsOut ? { aggrW: 0, checked: 0 } : undefined;
      bands.push(this.bandFor(p.user_id, history, bigBlind, sizedReads, board, readOut));
      if (readsOut)
        readsOut.push(readOut && (readOut.aggrW > 0 || readOut.checked > 0) ? readOut : null);
    }
    return bands;
  }

  /**
   * Aggregate exploit profile of the live opposition. When heads-up this is
   * simply that player's profile; multiway it is the confidence-weighted blend
   * (bluffs must get through EVERYONE, so the blend leans conservative).
   */
  // ───────────────────────────────────────────────────────────────────────
  // V16 DEEP READS (2026-08-26) — full-hand observation at settlement
  // ───────────────────────────────────────────────────────────────────────

  /**
   * Ingest one COMPLETED hand: fold-to-c-bet, fold-to-3-bet, and big-river-
   * bet sizing tells need the whole hand (and the showdown), which the
   * per-decision observe() stream never has. Called once per hand from the
   * settlement path; idempotent per handKey. Best-effort by contract — a
   * malformed history must never throw into settlement.
   */
  static observeHandComplete(
    handKey: string,
    actions: Array<{ userId?: string; action: string; amount?: number; stage: string }> | undefined,
    bigBlind: number,
    showdown?: Array<{ user_id: string; mucked: boolean; hand_name?: string }> | null
  ): void {
    try {
      if (!actions || actions.length === 0 || !handKey) return;
      const flag = `fh|${handKey}`;
      if (this.handFlags.has(flag)) return;
      this.handFlags.add(flag);
      evictOldest(this.handFlags, MAX_HAND_FLAGS);

      const bb = bigBlind > 0 ? bigBlind : 1;
      const touch = (id: string): OpponentStats => {
        let s = this.stats.get(id);
        if (!s) {
          if (this.stats.size >= MAX_TRACKED_PLAYERS) return freshStats(); // discard
          s = freshStats();
          this.stats.set(id, s);
        }
        this.dirty.add(id);
        return s;
      };

      // ── Preflop: opener vs 3-bettor ──
      const pre = actions.filter((a) => a.stage === 'preflop' && a.userId);
      let openerId: string | null = null;
      let openerIdx = -1;
      let threeBetIdx = -1;
      for (let i = 0; i < pre.length; i++) {
        const a = pre[i];
        if (a.action === 'raise' || a.action === 'bet' || a.action === 'all_in') {
          if (openerId === null) {
            openerId = a.userId!;
            openerIdx = i;
          } else if (threeBetIdx === -1 && a.userId !== openerId) {
            threeBetIdx = i;
          }
        }
      }
      if (openerId && threeBetIdx > openerIdx) {
        const s = touch(openerId);
        s.f3bOpps++;
        for (let i = threeBetIdx + 1; i < pre.length; i++) {
          if (pre[i].userId !== openerId) continue;
          if (pre[i].action === 'fold') s.f3bFolds++;
          break; // the opener's FIRST response settles it
        }
      }

      // ── Flop: the aggressor's c-bet and who folded to it ──
      // Preflop aggressor = last preflop raiser.
      let preAggr: string | null = null;
      for (const a of pre) {
        if (a.action === 'raise' || a.action === 'bet' || a.action === 'all_in') {
          preAggr = a.userId!;
        }
      }
      const flop = actions.filter((a) => a.stage === 'flop' && a.userId);
      if (preAggr) {
        let cbetIdx = -1;
        for (let i = 0; i < flop.length; i++) {
          if (flop[i].action === 'bet') {
            if (flop[i].userId === preAggr) cbetIdx = i;
            break; // only the FIRST flop bet can be a c-bet
          }
        }
        if (cbetIdx >= 0) {
          const responded = new Set<string>();
          for (let i = cbetIdx + 1; i < flop.length; i++) {
            const a = flop[i];
            if (a.userId === preAggr || responded.has(a.userId!)) continue;
            responded.add(a.userId!);
            const s = touch(a.userId!);
            s.cbetOpps++;
            if (a.action === 'fold') s.cbetFolds++;
          }
        }
      }

      // ── River: big bets that reached showdown — did they mean it? ──
      if (showdown && showdown.length > 0) {
        const shown = new Map<string, { mucked: boolean; hand_name?: string }>();
        for (const sd of showdown) {
          if (sd?.user_id) shown.set(sd.user_id, sd);
        }
        const counted = new Set<string>();
        for (const a of actions) {
          if (a.stage !== 'river' || !a.userId || counted.has(a.userId)) continue;
          if (a.action !== 'bet' && a.action !== 'raise' && a.action !== 'all_in') continue;
          if ((a.amount ?? 0) < 20 * bb) continue;
          const sd = shown.get(a.userId);
          if (!sd) continue; // bet took it down — no showdown information
          counted.add(a.userId);
          const s = touch(a.userId);
          s.bigBetSD++;
          // A mucked hand after betting big and being called LOST — that is
          // not value. Revealed hands are classified by name.
          if (!sd.mucked && STRONG_HAND_NAMES.has((sd.hand_name ?? '').toLowerCase())) {
            s.bigBetSDStrong++;
          }
        }
      }
    } catch {
      /* full-hand observation is best-effort by contract */
    }
  }

  /** V18 SELF-IMAGE: hero's own recent aggression ratio as the table sees
   *  it - rAggr/(rAggr+rPassive) over the decayed recency window. Null
   *  below a real sample. High = the fleet just watched hero bet a lot. */
  static selfImageOf(id: string): number | null {
    const s = this.stats.get(id);
    if (!s || s.rHands < 8) return null;
    // V28 AUDIT FIX: the denominator was rAggr + rPassive — bets and CALLS
    // only. Checks were counted nowhere, so a tight horse that bet 12 times
    // and checked 40 read as 0.86 "aggressive image" and had its bluffs
    // THROTTLED, while a station's many calls diluted it below 0.35 and got a
    // bluff BOOST — the V18 adjustment fired with the wrong sign for exactly
    // the two profiles it exists to separate. The image the table sees is
    // aggression over every action it watched.
    const acts = s.rAggr + s.rPassive + (s.rChecks ?? 0);
    if (acts < 10) return null;
    return s.rAggr / acts;
  }

  /** Fold-to-c-bet frequency (0..1), or null below a 10-opportunity sample. */
  static foldToCbetOf(id: string): number | null {
    const s = this.stats.get(id);
    if (!s || s.cbetOpps < 10) return null;
    return s.cbetFolds / s.cbetOpps;
  }

  /** Fold-to-3-bet frequency (0..1), or null below an 8-opportunity sample. */
  static foldTo3BetOf(id: string): number | null {
    const s = this.stats.get(id);
    if (!s || s.f3bOpps < 8) return null;
    return s.f3bFolds / s.f3bOpps;
  }

  /** Of their big river bets that reached showdown, the fraction that were
   *  real hands (two pair+). Null below a 5-showdown sample. High = their
   *  big bets mean it; low = they bomb with air. */
  static bigBetValueTendency(id: string): number | null {
    const s = this.stats.get(id);
    if (!s || s.bigBetSD < 5) return null;
    return s.bigBetSDStrong / s.bigBetSD;
  }

  static tableExploit(
    heroSeat: number,
    players: SeatPlayer[],
    recencyBlend: boolean = true
  ): ExploitProfile {
    const opps = players.filter((p) => p.seat !== heroSeat && !p.is_folded && !p.is_sitting_out);
    if (opps.length === 0) return NEUTRAL_EXPLOIT;
    if (opps.length === 1) return this.exploit(opps[0].user_id, recencyBlend);

    // V28 AUDIT FIX: bluffMod was seeded at the NEUTRAL 1 and only ever
    // min'd down — three 70% folders each returning 1.45 produced
    // min(1, 1.45, ...) = 1, so the upward half of the exploit was
    // unreachable in every multiway pot. "Weakest link gates bluffs" means
    // the min of the PROFILES, not the min of the profiles and an arbitrary
    // constant.
    let bluffMod = Infinity;
    let callDownMod = 0;
    let valueThinMod = 0;
    for (const o of opps) {
      const e = this.exploit(o.user_id, recencyBlend);
      bluffMod = Math.min(bluffMod, e.bluffMod); // weakest link gates bluffs
      callDownMod += e.callDownMod;
      valueThinMod += e.valueThinMod;
    }
    if (!isFinite(bluffMod)) bluffMod = 1;
    return {
      bluffMod,
      callDownMod: callDownMod / opps.length,
      valueThinMod: valueThinMod / opps.length,
    };
  }
}
