/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  BOMB POT SCHEDULER — trigger timing for bomb-pot hands
 *  (BOMB POT STANDARDIZATION 2026-08-27, Dan's spec §2.1 / §4)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * One instance per ServerTableEngine (never global — FIX-218 established that
 * cadence must be per-table). The engine calls noteHandStart() exactly once
 * per hand, at the hand boundary, BEFORE the HandConfig is built. The
 * scheduler answers "is this hand a bomb pot, and why".
 *
 * SUPPORTED TRIGGER MODES (spec §2.1):
 *
 *   every_n_hands   The legacy mode: a bomb becomes due every N dealt hands.
 *   once_per_orbit  One bomb per completed dealer-button orbit. Tracked by
 *                   watching the button CROSS its orbit anchor seat, not by
 *                   counting hands — seats joining or leaving mid-orbit must
 *                   neither add nor skip a bomb (spec §4.2, tests T01/T02).
 *   timed           A bomb becomes due every intervalSeconds of SERVER time,
 *                   executed at the next valid hand boundary (spec §4.3).
 *   bomb_pot_only   Every valid hand is a bomb pot (spec §4.4).
 *
 * PENDING-TOKEN SEMANTICS (spec §4.1):
 *   - A due bomb sets ONE pending token. It is never stacked: a table paused
 *     through three timed intervals owes one bomb, not three (test T04).
 *   - The token is consumed only by a hand that actually starts as a bomb,
 *     which requires dealtInCount >= minPlayers. Below the minimum the token
 *     stays pending and normal hands are dealt (spec §3.1 / §19).
 *   - Counters reset from the CONSUMING hand: the timed clock restarts at the
 *     actual bomb-hand start, and the orbit re-anchors on the seat the button
 *     reaches AFTER the bomb — one seat further round, so the bomb button
 *     walks the table instead of parking on one player (2026-08-29; a bomb pot
 *     posts no blinds, so the button is the only positional variable in it).
 *
 * The scheduler holds no money and no cards; it is deliberately a pure state
 * machine over (settings, dealerSeat, dealtInCount, now) so it can be tested
 * exhaustively without an engine (BombPotScheduler.test.ts).
 */

import { bettingStructureFor } from './BettingStructure.js';

/**
 * ── NOBODY TANKS FOR THE BOMB (Dan 2026-09-05) ─────────────────────────────
 *
 * "IN THE ACTION GAME WHEN THERE IS A BOMB POT EVERY 15 MINUTES. WHEN THERE IS
 * 3 MINUTES LEFT, THE 15 MINUTES CONVERTS TO BOMB POT IN 1-5 HANDS (RANDOMLY
 * SELECTED HANDS), SO PLAYERS DON'T TANK AND WAIT, TO GET AN UNFAIR
 * ADVANTAGE."
 *
 * A timed bomb with a visible clock invites the obvious edge: fold fast until
 * the clock is nearly out, then take the full timer on every decision so the
 * bomb lands on you. So inside the last TIMED_ARM_WINDOW_MS of any timed
 * interval the clock is retired and the bomb is instead N hands away, N drawn
 * once, uniformly from 1..TIMED_ARM_MAX_HANDS, at the hand boundary that
 * crosses the line. From then on the felt shows hands, not minutes, and the
 * number cannot be gamed by slowing play. The interval restarts from the bomb
 * hand as before.
 */
export const TIMED_ARM_WINDOW_MS = 3 * 60 * 1000;
export const TIMED_ARM_MIN_HANDS = 1;
export const TIMED_ARM_MAX_HANDS = 5;

/** Uniform integer in [min, max]; `rng` is injectable for the tests. */
export function drawArmedHands(rng: () => number = Math.random): number {
  const span = TIMED_ARM_MAX_HANDS - TIMED_ARM_MIN_HANDS + 1;
  return TIMED_ARM_MIN_HANDS + Math.min(span - 1, Math.floor(rng() * span));
}

export type BombPotTriggerMode = 'every_n_hands' | 'once_per_orbit' | 'timed' | 'bomb_pot_only';

export interface BombPotSchedulerSettings {
  /** Master switch — when false the scheduler is inert and keeps no state. */
  enabled: boolean;
  triggerMode: BombPotTriggerMode;
  /** every_n_hands: a bomb becomes due every N dealt hands. */
  frequency: number;
  /** timed: seconds between due bombs, measured on the server clock. */
  intervalSeconds: number;
  /**
   * A due bomb stays pending until at least this many players are dealt in
   * (spec §3.1, recommended default 3). Clamped at 2 — a bomb pot needs an
   * opponent.
   */
  minPlayers: number;
}

export interface BombPotDecision {
  isBombPot: boolean;
  /**
   * Present when isBombPot — frozen into the hand config for hand history.
   * 'manual_next_hand' (spec §2.1 MANUAL_NEXT_HAND) is produced by the
   * engine's role-gated manual path, never by the scheduler itself.
   */
  triggerReason?: BombPotTriggerMode | 'manual_next_hand';
}

/** Normalize raw table-row values into scheduler settings with spec defaults. */
export function bombPotSettingsFromTable(t: {
  bomb_pot_enabled?: boolean;
  bomb_pot_frequency?: number;
  bomb_pot_trigger_mode?: string | null;
  bomb_pot_interval_seconds?: number | null;
  bomb_pot_min_players?: number;
}): BombPotSchedulerSettings {
  const mode = t.bomb_pot_trigger_mode;
  const triggerMode: BombPotTriggerMode =
    mode === 'once_per_orbit' || mode === 'timed' || mode === 'bomb_pot_only'
      ? mode
      : 'every_n_hands';
  const frequency = Math.max(0, Math.floor(t.bomb_pot_frequency ?? 0));
  const intervalSeconds = Math.max(0, Math.floor(t.bomb_pot_interval_seconds ?? 0));
  // The mode must be able to fire at all, or the table is treated as
  // bomb-pots-off (matches the legacy `enabled && frequency > 0` contract).
  const modeViable =
    triggerMode === 'bomb_pot_only' ||
    triggerMode === 'once_per_orbit' ||
    (triggerMode === 'timed' && intervalSeconds > 0) ||
    (triggerMode === 'every_n_hands' && frequency > 0);
  return {
    enabled: (t.bomb_pot_enabled ?? false) && modeViable,
    triggerMode,
    frequency,
    intervalSeconds,
    minPlayers: Math.max(2, Math.floor(t.bomb_pot_min_players ?? 3)),
  };
}

/**
 * VARIANT OVERRIDE (spec §10.1): the variants a bomb hand may deal when it
 * differs from the table's game. Whitelisted — an unknown value silently
 * playing Hold'em rules on six-card hands is exactly the class of bug the
 * override must never introduce, so anything outside this set means "same as
 * table".
 *
 * MIRRORING NOTE (2026-08-31). tables_bomb_pot_variant_check no longer mirrors
 * this set exactly, and the difference is deliberate. The constraint used to
 * be a single-column `IN` list that could not see game_variant, so the
 * database would store a `plo4` bomb on an `flh` table — a row the engine
 * refuses at deal time but that get_club_home still publishes to the lobby as
 * "PLO4 bomb pots" on a table that only ever deals FLH. It is a two-column
 * constraint now and it enforces the fixed-limit rule below.
 *
 * While rewriting it, `flh` and `flo8` were admitted to the DB whitelist so
 * the LEGAL case — a fixed-limit bomb on a fixed-limit table — is not
 * structurally impossible. They are deliberately NOT admitted here: no
 * control anywhere offers them, and adding an engine capability nothing can
 * reach is the same "finished feature with no switch" shape this audit spent
 * the day removing. A fixed-limit table's bombs deal its own game, which is
 * the correct behaviour and what happens today. Add them here in the commit
 * that adds the control, not before.
 */
const BOMB_VARIANT_WHITELIST = new Set(['nlh', 'plo4', 'plo5', 'plo6']);

/**
 * Resolve the variant a bomb hand actually deals: the configured override
 * when it is whitelisted and genuinely different, otherwise the table's own
 * variant. Pure, so the whitelist rule is unit-testable.
 */
export function resolveBombPotVariant(
  tableVariant: string,
  override: string | null | undefined
): string {
  const o = String(override ?? '').toLowerCase();
  if (!o || !BOMB_VARIANT_WHITELIST.has(o)) return tableVariant;
  /* ── AN OVERRIDE NEVER CROSSES THE FIXED-LIMIT LINE ─────────────────────
     2026-08-31 audit. ServerTableEngineDealing says it plainly where it applies
     this result: "Everything downstream - evaluator, hole-card count, BETTING
     STRUCTURE, horse equity, hand history - reads the HAND's variant". The
     whitelist checked the variant NAME and nothing else.

     Between NO-LIMIT and POT-LIMIT that is fine and deliberate: an NLH table
     whose bombs are PLO4 double boards is the classic bomb pot and the sizing
     rules stay recognisably the same. FIXED LIMIT is a different kind of game.
     Its felt has no raise slider, every wager is a mandatory size, and a street
     is capped at four wagers - so a `plo4` bomb on a Fixed Limit Hold'em table
     handed every seated player one hand of pot-limit poker at a table they had
     sat down at for limit. Nothing warned them and nothing in the hand history
     explained it afterwards.

     The line is crossed in both directions, so it is tested in both: a limit
     table keeps its structure, and a no-limit table cannot be given a limit
     bomb either. An override that would cross it is ignored exactly like an
     unknown one - the bomb plays the table's own game. */
  const tableIsLimit = bettingStructureFor(tableVariant) === 'fixed_limit';
  const overrideIsLimit = bettingStructureFor(o) === 'fixed_limit';
  if (tableIsLimit !== overrideIsLimit) return tableVariant;
  return o;
}

export class BombPotScheduler {
  /** every_n_hands: hands dealt since the last bomb (or since enable). */
  private handsSinceBomb = 0;
  /** The single pending-bomb token (spec §4.1). */
  private pending = false;
  private pendingReason: BombPotTriggerMode | undefined;
  /** timed: epoch ms when the next bomb becomes due. Set on first sighting. */
  private nextDueAtMs: number | null = null;
  /**
   * timed: once the clock enters its last TIMED_ARM_WINDOW_MS, the bomb is
   * this many hands away instead (1 = the next hand). Null while the clock is
   * still the authority. Decremented per dealt hand; the bomb is due at zero.
   */
  private armedHands: number | null = null;

  constructor(private readonly rng: () => number = Math.random) {}
  /** once_per_orbit: the seat the button must cross to complete the orbit. */
  private orbitAnchorSeat: number | null = null;
  /** once_per_orbit: the dealer seat of the previous hand. */
  private lastDealerSeat: number | null = null;
  /**
   * once_per_orbit: hands dealt since the anchor was set, and the size of the
   * most recent field. Together they are the felt countdown — an orbit is one
   * hand per player dealt in. Tracked rather than derived because the
   * scheduler is never told the seat roster, only how many were dealt in.
   */
  private handsSinceAnchor = 0;
  private lastDealtInCount = 0;
  /**
   * once_per_orbit: set on a bomb hand, consumed on the next one. The new
   * anchor is the seat the button reaches AFTER the bomb, which is not known
   * until that hand starts — see the consume branch in noteHandStart.
   */
  private anchorAdvancePending = false;

  /**
   * Call exactly once per hand, at the hand boundary, before HandConfig is
   * built. Advances all trigger clocks and returns whether THIS hand is a
   * bomb pot.
   */
  noteHandStart(
    s: BombPotSchedulerSettings,
    dealerSeat: number,
    dealtInCount: number,
    nowMs: number = Date.now()
  ): BombPotDecision {
    this.started = true;
    if (!s.enabled) {
      // Off-switch mid-session: drop all pending state so re-enabling starts
      // a fresh schedule rather than detonating a stale token.
      this.reset();
      return { isBombPot: false };
    }

    // The size of the field this hand — the length of an orbit, and so the
    // denominator of the once_per_orbit countdown. Recorded for every mode
    // because a table can be reconfigured between hands.
    this.lastDealtInCount = dealtInCount;

    switch (s.triggerMode) {
      case 'bomb_pot_only': {
        // Every valid hand is a bomb; no token bookkeeping needed. Below the
        // minimum the table deals normal hands until players return (§3.1).
        if (dealtInCount >= s.minPlayers) {
          return { isBombPot: true, triggerReason: 'bomb_pot_only' };
        }
        return { isBombPot: false };
      }

      case 'every_n_hands': {
        if (!this.pending) {
          this.handsSinceBomb++;
          if (this.handsSinceBomb >= s.frequency) {
            this.pending = true;
            this.pendingReason = 'every_n_hands';
          }
        }
        break;
      }

      case 'timed': {
        if (this.nextDueAtMs === null) {
          this.nextDueAtMs = nowMs + s.intervalSeconds * 1000;
        }
        if (!this.pending && this.armedHands !== null) {
          // Armed: the bomb is a number of hands away, and this is one of them.
          this.armedHands -= 1;
          if (this.armedHands <= 0) {
            this.armedHands = null;
            this.pending = true;
            this.pendingReason = 'timed';
          }
        } else if (!this.pending && nowMs >= this.nextDueAtMs) {
          // One token regardless of how many intervals elapsed while the
          // table sat idle or paused (spec §4.3 "no catch-up spam", T04).
          this.pending = true;
          this.pendingReason = 'timed';
        } else if (!this.pending && this.nextDueAtMs - nowMs <= TIMED_ARM_WINDOW_MS) {
          // The last three minutes: the clock retires and the bomb becomes
          // 1-5 hands away, drawn once (Dan 2026-09-05). This hand is the
          // first of them, so a draw of 1 makes the NEXT hand the bomb.
          this.armedHands = drawArmedHands(this.rng);
        }
        break;
      }

      case 'once_per_orbit': {
        // The felt countdown's numerator. Counted before the arc test so the
        // hand that completes the orbit is included in the orbit it completes.
        this.handsSinceAnchor++;
        if (this.anchorAdvancePending) {
          // The hand AFTER a bomb: its dealer seat is the new anchor, so the
          // bomb button advances one seat per orbit instead of parking on one
          // player forever. See the consume branch below for the full reason.
          this.anchorAdvancePending = false;
          this.orbitAnchorSeat = dealerSeat;
          this.lastDealerSeat = dealerSeat;
          this.handsSinceAnchor = 0;
          break;
        }
        if (this.orbitAnchorSeat === null) {
          // First hand of tracking: this dealer seat anchors the orbit.
          this.orbitAnchorSeat = dealerSeat;
          this.handsSinceAnchor = 0;
        } else if (
          !this.pending &&
          this.lastDealerSeat !== null &&
          this.buttonCrossedAnchor(this.lastDealerSeat, dealerSeat, this.orbitAnchorSeat)
        ) {
          this.pending = true;
          this.pendingReason = 'once_per_orbit';
        }
        this.lastDealerSeat = dealerSeat;
        break;
      }
    }

    // Consume the single token — only when enough players are dealt in.
    if (this.pending && dealtInCount >= s.minPlayers) {
      const reason = this.pendingReason ?? s.triggerMode;
      this.pending = false;
      this.pendingReason = undefined;
      this.handsSinceBomb = 0;
      if (s.triggerMode === 'timed') {
        // Reset from the ACTUAL bomb-hand start, not the old due time (§4.3).
        this.nextDueAtMs = nowMs + s.intervalSeconds * 1000;
        this.armedHands = null;
      }
      if (s.triggerMode === 'once_per_orbit') {
        /**
         * THE BOMB WALKS THE TABLE (2026-08-29).
         *
         * This set `orbitAnchorSeat = dealerSeat` — the bomb hand's own seat.
         * The bomb fires exactly when the button lands on the anchor, so
         * re-anchoring to the seat it just landed on meant the SAME PLAYER
         * held the button on every bomb pot for the life of the table.
         *
         * That is not a cosmetic repeat. A bomb pot posts no blinds, so the
         * button is the ONLY positional variable in the hand: one seat acted
         * last on every street of every bomb pot, forever, on a table where
         * every player has been forced to ante.
         *
         * Anchoring on the NEXT hand's dealer seat instead advances the anchor
         * by exactly one dealt-in seat per orbit, so the bomb button walks
         * round the table and every player takes it in turn. The seat is not
         * known yet, so the intent is recorded and the next noteHandStart
         * fills it in.
         *
         * THE TRADE, stated plainly: an orbit on an N-handed table is N hands,
         * and this makes the bomb arrive every N+1. It is still never twice in
         * an orbit — which is what the mode promises — and one extra hand is a
         * much smaller cost than one seat owning position on every bomb pot a
         * table ever deals.
         *
         * Under the SEPARATE bomb button policy this is a no-op: that policy
         * rewinds the regular rotation, so the next hand repeats the same
         * dealer seat and the anchor does not move. It does not need to —
         * the bomb button there is its own rotation and already advances.
         */
        this.anchorAdvancePending = true;
        this.handsSinceAnchor = 0;
      }
      return { isBombPot: true, triggerReason: reason };
    }

    return { isBombPot: false };
  }

  /**
   * Did the button, moving clockwise from `from` to `to`, land on or pass the
   * anchor seat? Seat numbers increase clockwise and wrap, and the arc test
   * needs no table-size modulus: the anchor is crossed iff it lies in the
   * clockwise arc (from, to].
   *
   * A vanished anchor seat still registers — the arc contains the NUMBER
   * whether or not a player sits there — which is exactly the spec's "advance
   * the logical anchor without producing an extra bomb" (§4.2).
   */
  private buttonCrossedAnchor(from: number, to: number, anchor: number): boolean {
    if (from === to) {
      /**
       * THE BUTTON DID NOT MOVE, SO NO ORBIT COMPLETED (2026-08-29).
       *
       * This returned `true`, on the reasoning that "a single seat dealt
       * around" completes an orbit every hand. That case cannot occur — a hand
       * needs two players, and ServerTableEngineDealing forces the button
       * across whenever `players.length > 2` precisely so it can never stand
       * still. The branch never fired for the reason it was written.
       *
       * What DOES produce `from === to` is the SEPARATE BOMB BUTTON. On a bomb
       * hand that policy rewinds the regular rotation (`this.lastButtonSeat =
       * prevButtonSeat`) so normal play resumes where it would have been had
       * the bomb not happened — by design. The next hand therefore recomputes
       * the SAME dealer seat, and this branch read that as a completed orbit.
       *
       * The result on any table combining `once_per_orbit` with a separate
       * bomb button — and `once_per_orbit` is what the "Classic Double Board"
       * host preset selects — was a runaway: the bomb hand anchors the orbit
       * on seat S and rewinds, the next hand deals S again, `from === to`
       * arms the token immediately, that hand is a bomb, and it rewinds again.
       * Steady state is a forced ante on EVERY hand, blinds that never post,
       * and a regular button frozen on one seat for the life of the table.
       *
       * A button that has not moved has not passed anything. Say so.
       */
      return false;
    }
    if (to > from) return anchor > from && anchor <= to;
    // Wrapped around the top of the seat numbering.
    return anchor > from || anchor <= to;
  }

  /**
   * Felt countdown for every_n_hands mode: hands until the next bomb
   * (1 = next hand). Null in other modes or when a countdown is meaningless.
   * Matches the legacy `bomb_pot_in` snapshot contract.
   */
  handsUntilDue(s: BombPotSchedulerSettings): number | null {
    if (!s.enabled) return null;
    if (s.triggerMode === 'bomb_pot_only') return 1;
    if (this.pending) return 1;
    /**
     * ONCE PER ORBIT NOW COUNTS DOWN TOO (2026-08-29).
     *
     * This returned `null` for every mode but `every_n_hands`, and the token
     * is set and consumed inside the SAME noteHandStart call, so `this.pending`
     * was only ever observably true while the min-players floor held it back.
     * The felt pill renders only when `bombPotIn` or the timed clock is
     * non-null — so an orbit-mode table showed a player nothing, ever, and the
     * forced ante arrived unannounced.
     *
     * That is the mode the first host preset ("Classic Double Board") selects,
     * and the pill exists specifically so "players see the forced ante coming
     * instead of being ambushed by it".
     *
     * The bomb fires when the button next lands on or passes the anchor, so
     * hands-until-due is the clockwise distance from the current button to the
     * anchor, measured in SEATS DEALT IN — which is what one hand advances the
     * button by. Before the first hand is tracked there is no anchor and no
     * answer, which stays null rather than guessing.
     */
    if (s.triggerMode === 'once_per_orbit') {
      /**
       * An orbit is one hand per player dealt in — that is what "the button
       * goes all the way round" means, and it is the only quantity here that
       * is measured rather than inferred. The arc test in buttonCrossedAnchor
       * stays the authority on when the bomb actually FIRES; this only decides
       * what the pill says while it is coming.
       *
       * Both terms are live numbers: the roster can shrink or grow between
       * hands, so a table that loses a player shortens its own countdown on
       * the next hand rather than promising a bomb that already passed.
       */
      if (this.orbitAnchorSeat === null || this.lastDealtInCount === 0) return null;
      return Math.max(1, this.lastDealtInCount - this.handsSinceAnchor);
    }
    if (s.triggerMode === 'timed') {
      // Armed (the last three minutes): hands, not minutes. Null before that
      // - the clock is the pill then.
      return this.armedHands === null ? null : Math.max(1, this.armedHands);
    }
    if (s.triggerMode !== 'every_n_hands') return null;
    return Math.max(1, s.frequency - this.handsSinceBomb);
  }

  /**
   * timed mode: epoch ms when the next bomb becomes due (null otherwise).
   * Null once the bomb is armed in hands: the clock is retired so nobody can
   * play to it (Dan 2026-09-05); handsUntilDue is the countdown then.
   */
  nextBombDueAt(s: BombPotSchedulerSettings): number | null {
    if (!s.enabled || s.triggerMode !== 'timed') return null;
    if (this.armedHands !== null) return null;
    return this.nextDueAtMs;
  }

  /** timed mode: the armed hands countdown, if the clock has retired. */
  armedHandsUntilDue(): number | null {
    return this.armedHands;
  }

  /** Whether a due bomb is waiting for the next valid hand (any mode). */
  isPending(): boolean {
    return this.pending;
  }

  /**
   * TIMED PERSISTENCE (2026-08-28, spec §4.3): seed the timed clock from the
   * persisted tables.bomb_pot_next_due_at so an engine restart resumes the
   * cycle instead of restarting it. Only fills an EMPTY clock — once the
   * scheduler is running, its own state is the truth. A past timestamp is
   * accepted as-is: noteHandStart turns it into the pending token, which is
   * exactly what "the bomb came due while we were deploying" should mean.
   */
  seedNextDueAt(ms: number): void {
    if (this.nextDueAtMs === null && Number.isFinite(ms) && ms > 0) {
      this.nextDueAtMs = ms;
    }
  }

  /** True until the first noteHandStart — the only window restoreState fills. */
  private started = false;

  /**
   * FULL PERSISTENCE (2026-08-28): the scheduler's complete trigger state,
   * serialized for tables.bomb_pot_sched_state. Written by the engine when it
   * changes; restored once at boot so a deploy costs the orbit tracker and
   * the every-N counter nothing — the same guarantee the timed clock already
   * had. Keys are terse on purpose (one row write per hand on bomb tables).
   */
  exportState(): Record<string, unknown> {
    return {
      h: this.handsSinceBomb,
      p: this.pending,
      r: this.pendingReason ?? null,
      d: this.nextDueAtMs,
      a: this.orbitAnchorSeat,
      l: this.lastDealerSeat,
      // 2026-08-29: the once_per_orbit countdown. Persisted with the rest so a
      // deploy does not blank the felt pill for a whole orbit — the exact
      // guarantee the every-N counter and the timed clock already had.
      o: this.handsSinceAnchor,
      n: this.lastDealtInCount,
      // The pending anchor advance. Lost across a restart this would park the
      // bomb button on one seat for one extra orbit — small, but it is one
      // boolean and the whole point of the flag is that it survives.
      x: this.anchorAdvancePending,
      // The armed hands countdown (Dan 2026-09-05): a deploy inside the last
      // three minutes must not hand the clock back to the table.
      m: this.armedHands,
    };
  }

  /**
   * Restore a persisted state onto a FRESH scheduler (before its first
   * noteHandStart). Anything malformed is ignored field-by-field — a corrupt
   * row degrades to the old restart-resets-the-cycle behaviour, never a
   * crash and never a stuck token from a bad type.
   */
  restoreState(s: unknown): void {
    if (this.started || !s || typeof s !== 'object') return;
    const o = s as Record<string, unknown>;
    if (typeof o.h === 'number' && Number.isFinite(o.h) && o.h >= 0) {
      this.handsSinceBomb = Math.floor(o.h);
    }
    if (typeof o.p === 'boolean') this.pending = o.p;
    if (
      o.r === 'every_n_hands' ||
      o.r === 'once_per_orbit' ||
      o.r === 'timed' ||
      o.r === 'bomb_pot_only'
    ) {
      this.pendingReason = o.r;
    }
    if (typeof o.d === 'number' && Number.isFinite(o.d) && o.d > 0) this.nextDueAtMs = o.d;
    if (typeof o.a === 'number' && Number.isFinite(o.a) && o.a > 0) {
      this.orbitAnchorSeat = Math.floor(o.a);
    }
    if (typeof o.l === 'number' && Number.isFinite(o.l) && o.l > 0) {
      this.lastDealerSeat = Math.floor(o.l);
    }
    if (typeof o.o === 'number' && Number.isFinite(o.o) && o.o >= 0) {
      this.handsSinceAnchor = Math.floor(o.o);
    }
    if (typeof o.n === 'number' && Number.isFinite(o.n) && o.n >= 0) {
      this.lastDealtInCount = Math.floor(o.n);
    }
    if (typeof o.x === 'boolean') this.anchorAdvancePending = o.x;
    if (typeof o.m === 'number' && Number.isFinite(o.m) && o.m > 0) {
      this.armedHands = Math.min(TIMED_ARM_MAX_HANDS, Math.floor(o.m));
    }
  }

  private reset(): void {
    this.handsSinceBomb = 0;
    this.pending = false;
    this.pendingReason = undefined;
    this.nextDueAtMs = null;
    this.orbitAnchorSeat = null;
    this.lastDealerSeat = null;
    this.handsSinceAnchor = 0;
    this.lastDealtInCount = 0;
    this.anchorAdvancePending = false;
    this.armedHands = null;
  }
}
