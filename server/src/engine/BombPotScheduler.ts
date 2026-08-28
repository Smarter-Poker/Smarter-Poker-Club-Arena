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
 *     actual bomb-hand start, the orbit anchor re-anchors on the bomb hand's
 *     dealer seat.
 *
 * The scheduler holds no money and no cards; it is deliberately a pure state
 * machine over (settings, dealerSeat, dealtInCount, now) so it can be tested
 * exhaustively without an engine (BombPotScheduler.test.ts).
 */

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
  /** Present when isBombPot — frozen into the hand config for hand history. */
  triggerReason?: BombPotTriggerMode;
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
 * table". Mirrored by the tables_bomb_pot_variant_check DB constraint.
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
  /** once_per_orbit: the seat the button must cross to complete the orbit. */
  private orbitAnchorSeat: number | null = null;
  /** once_per_orbit: the dealer seat of the previous hand. */
  private lastDealerSeat: number | null = null;

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
    if (!s.enabled) {
      // Off-switch mid-session: drop all pending state so re-enabling starts
      // a fresh schedule rather than detonating a stale token.
      this.reset();
      return { isBombPot: false };
    }

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
        if (!this.pending && nowMs >= this.nextDueAtMs) {
          // One token regardless of how many intervals elapsed while the
          // table sat idle or paused (spec §4.3 "no catch-up spam", T04).
          this.pending = true;
          this.pendingReason = 'timed';
        }
        break;
      }

      case 'once_per_orbit': {
        if (this.orbitAnchorSeat === null) {
          // First hand of tracking: this dealer seat anchors the orbit.
          this.orbitAnchorSeat = dealerSeat;
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
      }
      if (s.triggerMode === 'once_per_orbit') {
        // The bomb hand's dealer seat anchors the next orbit (§4.2).
        this.orbitAnchorSeat = dealerSeat;
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
      // The button did not move (e.g. a single seat dealt around) — with one
      // effective seat every hand completes an orbit.
      return true;
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
    if (s.triggerMode !== 'every_n_hands') return this.pending ? 1 : null;
    if (this.pending) return 1;
    return Math.max(1, s.frequency - this.handsSinceBomb);
  }

  /** timed mode: epoch ms when the next bomb becomes due (null otherwise). */
  nextBombDueAt(s: BombPotSchedulerSettings): number | null {
    if (!s.enabled || s.triggerMode !== 'timed') return null;
    return this.nextDueAtMs;
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

  private reset(): void {
    this.handsSinceBomb = 0;
    this.pending = false;
    this.pendingReason = undefined;
    this.nextDueAtMs = null;
    this.orbitAnchorSeat = null;
    this.lastDealerSeat = null;
  }
}
