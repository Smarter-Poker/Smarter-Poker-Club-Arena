/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  SPIN-IT INTRO — the multiplier draw, PokerBros grammar (2026-08-20, v2)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Rebuilt against frame-by-frame study of Dan's PokerBros reference capture
 * ("spin it intro.MOV", 17.7s). Their sequence, beat by beat:
 *
 *   1. The TABLE STAYS VISIBLE. No full-screen takeover: the felt dims and a
 *      spotlight beam falls from the top of the screen onto the table.
 *   2. A big gold COUNTDOWN (3·2·1) pops centre-felt.
 *   3. A gold-rimmed DISC sits on the felt — a pie of coloured segments with
 *      the format wordmark in the hub. It does NOT rotate: the segments
 *      LIGHT UP one at a time, a chase that runs fast and decelerates, each
 *      lit segment fading behind the runner.
 *   4. The chase settles on the winner. That segment stays lit and flashes;
 *      every other segment desaturates to grey.
 *   5. The disc fades away, the table brightens, and the masthead now carries
 *      the prize pool.
 *
 * The chase reads better than a rotating wheel at table scale — nothing
 * spins under a pointer, so there is no moment where the eye loses the
 * geometry — and the decelerating runner gives the same genuine near-miss:
 * it walks THROUGH the big tiers on its way to the result.
 *
 * ─── Honesty (unchanged from v1) ────────────────────────────────────────────
 * The result is decided by the SERVER (reserve-gated draw at game start) and
 * handed to this component as a fact. No Math.random touches the outcome —
 * the chase is told where to stop and works backwards to get there. Locked
 * tiers (Reserve Pool cannot fund them) render dark with their unlock note;
 * the engine excluded them from the draw, so the chase can pass over them
 * but never end on one.
 *
 * All three seats watch the same chase land on the same segment at the same
 * moment, because the multiplier is a server fact delivered to every client.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { soundService } from '../../services/SoundService';
import { getAnimationSpeed, prefersReducedMotion } from '../../utils/animationSpeed';
import { fireVibration } from '../../utils/vibrationGate';
import { reportError } from '../../utils/errorReporter';
import {
  SPIN_TIERS,
  spinTier,
  spinCelebration,
  SPIN_REVEAL,
  spinRevealTotalMs,
  spinPostRevealMs,
  spinRevealToDealMs,
} from '../../config/spinSpec';
import './SpinWheel.css';

export interface SpinTier {
  multiplier: number;
  /** Relative weight. Only used for ordering context, never to pick a winner. */
  weight?: number;
}

export interface SpinWheelData {
  /** The SERVER's result. This component never decides it. */
  multiplier: number;
  /** One buy-in, so the disc can show real money rather than a bare multiple. */
  buyIn: number;
  /** Tier ladder for this Spin type, biggest last. */
  tiers: SpinTier[];
  /**
   * THE SHARED CLOCK (Dan 2026-08-21). The wall-clock instant the ENGINE
   * named for this reveal, broadcast to every seat.
   *
   * Without it each client began its own wheel whenever it finished loading,
   * so three players watched three different wheels at three different
   * moments. Animating against the engine's instant puts them in step, and
   * a client that connects mid-sequence joins PARTWAY THROUGH rather than
   * replaying the countdown after everyone else has seen the result.
   *
   * Omitted (older rows, tests) = start from the top, the previous behaviour.
   */
  revealAtMs?: number;
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   *  THE SERVER'S HOLD, AS AN ABSOLUTE INSTANT (2026-08-27)
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * Wall-clock ms at which the engine will allow the first CARD to be dealt.
   * The engine already computes it — `TournamentManagerBase`:
   *
   *     const holdUntil = revealAt + spinRevealToDealMs();
   *     engine.holdDealingUntil(holdUntil);
   *
   * and puts it on the `spin_reveal` packet as `hold_until` (`replay_until`
   * carries the same value on older broadcasts). It is the ONE fact that makes
   * the reveal shared: the moment the table stops waiting, whoever is watching
   * and whatever their settings say.
   *
   * WHY THIS EXISTS. Every phase below used to be multiplied by
   * `getAnimationSpeed()` — a per-client preference clamped to 0.25..3.0 and
   * read from a CSS variable — against a hold that is fixed. At speed 3 the
   * sequence ran 44,400 ms against a 16,600 ms hold, so cards were dealt about
   * twenty-eight seconds before the wheel landed: the player watched a wheel
   * decide what they were playing for while already playing for it. Three
   * players with three different speed settings watched three different
   * animations, which is exactly the fault the shared clock was introduced to
   * end.
   *
   * A player's speed preference is a preference about ANIMATION, not a licence
   * to reschedule a table-wide moment. So it is clamped against this: the
   * sequence may finish early, it may never finish late.
   *
   * Omitted (older rows, the DB fallback path, tests) = the spec default,
   * `revealAtMs + spinRevealTotalMs()`, which is derived from the same file the
   * engine derives its hold from.
   */
  revealDeadlineMs?: number;
  currency?: string;
  /** Names of the three players, shown while the chase decides. */
  playerNames?: string[];
  /**
   * Multipliers the Reserve Pool cannot currently fund. Shown on the disc as
   * LOCKED rather than hidden: a visible 100x you cannot win yet is
   * anticipation and is honest about the ceiling. The engine excludes these
   * from the draw entirely, so a locked tier can never be the result.
   */
  lockedMultipliers?: number[];
  /**
   * The same information with the reason and the unlock threshold attached,
   * exactly as `fn_spin_draw_multiplier` recorded it for THIS draw. Preferred
   * over `lockedMultipliers` when present.
   */
  lockedTiers?: SpinLockedTier[];
}

export interface SpinLockedTier {
  multiplier: number;
  reason?: string;
  /** Reserve balance at which this tier becomes drawable. */
  unlocksAt?: number;
}

export interface SpinWheelProps {
  data: SpinWheelData | null;
  onDone: () => void;
  playSounds?: boolean;
  /**
   * ═══════════════════════════════════════════════════════════════════════
   *  A WHEEL BELONGS TO ITS OWN TABLE (2026-09-01)
   * ═══════════════════════════════════════════════════════════════════════
   *
   * `.sw` is `position: fixed; inset: 0`, so in tile view a Spin firing on
   * one table painted over ALL FOUR and swallowed their input for the whole
   * hold. You could be timed out on a table you could not see, behind a wheel
   * you were not watching.
   *
   * The answer is not to suppress the wheel on an inactive tile - CLAUDE.md
   * 10.6 says an animation plays every time it is owed, for its full
   * duration, and it is owed on ITS table. The answer is that it stops
   * escaping that table. `scoped` swaps fixed for absolute, and
   * `.multi-table-grid__stage` is already `position: relative; overflow:
   * hidden`, so the wheel is clipped to the tile it belongs to.
   */
  scoped?: boolean;
  /**
   * Whether this wheel may take pointer input. False on a tile the player is
   * not looking at, so the click that SELECTS that tile reaches the cell
   * underneath instead of being eaten by the overlay. The player moves their
   * own view - the same principle as CLAUDE.md 10.6's no-auto-switch rule.
   */
  captureInput?: boolean;
}

type Phase = 'idle' | 'countdown' | 'chase' | 'result';

/**
 * The ladder shown on the disc, derived from the canonical spec so the disc
 * can never advertise a tier the engine cannot draw (or omit one it can).
 */
export const DEFAULT_SPIN_TIERS: SpinTier[] = SPIN_TIERS.map((t) => ({
  multiplier: t.multiplier,
  weight: t.freq,
}));

// ── Timing ──────────────────────────────────────────────────────────────────
//
// EVERY number here is DERIVED from SPIN_REVEAL, which is also what the engine
// builds its deal hold from. They used to be independent literals, and they had
// already drifted apart in two places:
//
//   RESULT_MS was 4200 against a spec RESULT_HOLD_MS of 2200, so for two full
//   seconds the engine believed the reveal was over and could deal the first
//   hand on top of the card telling the player what they were playing for.
//
//   3 countdown steps of 750ms is 2250ms against a spec COUNTDOWN_MS of 3000,
//   so the wheel started three quarters of a second before the engine thought.
//
// Neither was visible in a test because nothing compared the two sources. Now
// there is only one source, so the drift cannot recur.
const COUNTDOWN_FROM = 3;
/** One second per light: red, yellow, green. A NASCAR tree is evenly spaced. */
const COUNTDOWN_STEP_MS = SPIN_REVEAL.COUNTDOWN_MS / COUNTDOWN_FROM;
const CHASE_MS = SPIN_REVEAL.SPIN_MS;
/**
 * Chase loops before the runner starts caring where it lands. Dan 2026-08-21
 * wanted the selector "A LITTLE FASTER AND LAST A LITTLE LONGER" — which is
 * only possible together by adding laps. Five laps in 6000ms is ~7.7 steps a
 * second, against three laps in 4200ms at 5.5.
 */
const CHASE_LOOPS = 5;
/** The winner's outline flashes alone, THEN the prize is read. */
const RESULT_MS = SPIN_REVEAL.WINNER_FLASH_MS + SPIN_REVEAL.RESULT_HOLD_MS;

/**
 * Order the tiers around the disc so small and large ALTERNATE.
 *
 * Laid out in ladder order, every big multiplier sits next to another big one
 * and a 2x result never passes near anything exciting. Interleaving from both
 * ends of the ladder means the chase runner genuinely walks through a big
 * tier on its way to most small ones — a real near-miss, not a staged one.
 */
export function buildWheelOrder(tiers: SpinTier[]): SpinTier[] {
  const asc = [...tiers].sort((a, b) => a.multiplier - b.multiplier);
  const out: SpinTier[] = [];
  let lo = 0;
  let hi = asc.length - 1;
  while (lo <= hi) {
    out.push(asc[lo]);
    if (lo !== hi) out.push(asc[hi]);
    lo += 1;
    hi -= 1;
  }
  return out;
}

/**
 * Read `tournaments.spin_locked_tiers` into the shape this component wants.
 *
 * The column is jsonb and PostgREST may hand it back as a parsed array or a
 * string, and it is NULL on every Spin created before the column existed.
 * Anything unrecognisable yields an empty list: a disc that fails to dim a
 * segment is a small loss, and a disc that throws while a player is watching
 * their prize be decided is a large one.
 */
export function parseLockedTiers(raw: unknown): SpinLockedTier[] {
  let value = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(value)) return [];
  const out: SpinLockedTier[] = [];
  for (const entry of value) {
    const multiplier = Number((entry as any)?.multiplier);
    if (!Number.isFinite(multiplier)) continue;
    const unlocksAt = Number((entry as any)?.unlocksAt);
    out.push({
      multiplier,
      reason: (entry as any)?.reason ? String((entry as any).reason) : undefined,
      unlocksAt: Number.isFinite(unlocksAt) && unlocksAt > 0 ? unlocksAt : undefined,
    });
  }
  return out;
}

/**
 * SVG geometry for the disc.
 *
 * The disc was DOM divs with rotated ::before triangles until 2026-08-21.
 * Dan's verdict on that version was "FLAT AND BORING, WITH NO DEPTH OR 3D LOOK
 * AND FEEL", and the technique was the reason: a CSS triangle cannot carry a
 * radial gradient, so every wedge was one flat colour and no amount of shadow
 * on top rescued it. Real paths take real fills.
 */
export const SW_VIEWBOX = 240;
const SW_CX = 120;
const SW_CY = 120;
const SW_R = 116;

/**
 * One wedge, centred on 12 o'clock. Segment i spans from (i - 0.5) to
 * (i + 0.5) segment-widths, so the LABEL sits on the segment's centreline
 * rather than its edge — off-by-half here is the difference between a number
 * in its slice and a number straddling two.
 */
export function wedgePath(index: number, segmentCount: number, radius: number = SW_R): string {
  const seg = 360 / Math.max(1, segmentCount);
  const a0 = ((index * seg - 90 - seg / 2) * Math.PI) / 180;
  const a1 = (((index + 1) * seg - 90 - seg / 2) * Math.PI) / 180;
  const x0 = SW_CX + radius * Math.cos(a0);
  const y0 = SW_CY + radius * Math.sin(a0);
  const x1 = SW_CX + radius * Math.cos(a1);
  const y1 = SW_CY + radius * Math.sin(a1);
  const sweep = seg > 180 ? 1 : 0;
  return `M${SW_CX} ${SW_CY} L${x0} ${y0} A${radius} ${radius} 0 ${sweep} 1 ${x1} ${y1} Z`;
}

/** Where a segment's label and its rim peg sit. */
export function segmentPoint(
  index: number,
  segmentCount: number,
  radius: number
): { x: number; y: number } {
  const seg = 360 / Math.max(1, segmentCount);
  const a = ((index * seg - 90) * Math.PI) / 180;
  return { x: SW_CX + radius * Math.cos(a), y: SW_CY + radius * Math.sin(a) };
}

/** Tier styling band. Bigger prizes read hotter. */
export function tierClass(multiplier: number): string {
  if (multiplier >= 100) return 'sw--mega';
  if (multiplier >= 25) return 'sw--big';
  if (multiplier >= 5) return 'sw--mid';
  return 'sw--base';
}

/**
 * Chase schedule: when (ms from chase start) each step fires. Ease-out — the
 * runner sprints its early laps and crawls the final segments, so the last
 * few are readable one at a time exactly like the reference. The LAST step is
 * the target segment by construction.
 */
export function chaseSchedule(
  segmentCount: number,
  targetIndex: number,
  totalMs: number
): number[] {
  const n = Math.max(1, segmentCount);
  const steps = CHASE_LOOPS * n + ((targetIndex % n) + 1);
  const times: number[] = [];
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    // Convex curve: step TIMES cluster early and spread late, so the gaps
    // between steps strictly grow — the runner sprints its opening laps and
    // crawls the final segments one readable beat at a time. Eased slightly
    // (2.6 -> 2.35) when the chase went to five laps, so the extra distance
    // reads as speed rather than as a longer crawl at the end.
    times.push(Math.round(totalMs * Math.pow(t, 2.35)));
  }
  return times;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE CHASE CATCHES UP TOO (2026-08-31 audit)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Every other beat in this component is scheduled through `at()`, so a client
 * that loads slowly or refreshes mid-spin joins the shared moment already in
 * progress rather than replaying it. The chase's own light steps were the one
 * exception: they were scheduled at their RAW offsets, always from step one,
 * always over the full `chaseMs`.
 *
 * So a client that joined two seconds into the chase got the result card at
 * the right instant — `at()` handled that — while the runner was still walking
 * from the beginning, and its remaining `setLitIndex` calls then overwrote the
 * winner highlight for the rest of the chase. The light lands on the winner,
 * walks off it, and keeps going. On a table where three seats are supposed to
 * be watching the same disc, the one player who reloaded sees it stop
 * somewhere else.
 *
 * The ticking had the same shape: `playSpinTicking` was handed the full
 * schedule, so the pegs kept striking past the announcement.
 *
 * This drops the steps already behind us, reports the last of them so the disc
 * can be lit where the runner actually IS, and rebases the rest.
 */
export function chaseCatchUp(
  schedule: number[],
  elapsedIntoChaseMs: number
): { litNow: number; remaining: Array<{ stepIdx: number; at: number }> } {
  const behind = Number.isFinite(elapsedIntoChaseMs) ? Math.max(0, elapsedIntoChaseMs) : 0;
  const remaining: Array<{ stepIdx: number; at: number }> = [];
  let litNow = -1;
  schedule.forEach((offset, stepIdx) => {
    const at = offset - behind;
    if (at > 0) remaining.push({ stepIdx, at });
    else litNow = stepIdx;
  });
  return { litNow, remaining };
}

export default function SpinWheel({
  data,
  onDone,
  playSounds = true,
  scoped = false,
  captureInput = true,
}: SpinWheelProps) {
  const lockedDetail = useMemo(() => {
    const map = new Map<number, SpinLockedTier>();
    for (const m of data?.lockedMultipliers ?? []) map.set(m, { multiplier: m });
    for (const t of data?.lockedTiers ?? []) {
      if (Number.isFinite(t?.multiplier)) map.set(t.multiplier, t);
    }
    return map;
  }, [data?.lockedMultipliers, data?.lockedTiers]);

  const locked = useMemo(() => new Set(lockedDetail.keys()), [lockedDetail]);

  /**
   * The cheapest unlock we can honestly advertise: the smallest threshold
   * among the locked tiers that told us one. "100x unlocks at 1,500" is
   * anticipation; a bare dimmed segment is just an absence.
   */
  const nextUnlock = useMemo(() => {
    const withThreshold = [...lockedDetail.values()].filter(
      (t) => Number.isFinite(t.unlocksAt) && (t.unlocksAt as number) > 0
    );
    if (withThreshold.length === 0) return null;
    return withThreshold.sort((a, b) => (a.unlocksAt as number) - (b.unlocksAt as number))[0];
  }, [lockedDetail]);

  const [phase, setPhase] = useState<Phase>('idle');
  const [count, setCount] = useState(COUNTDOWN_FROM);
  /**
   * How many lamps on the starting tree are lit (0-3). Dan 2026-08-21 wanted
   * the count to "FEEL LIKE A NASCAR COUNT DOWN", and a drag tree fills
   * DOWNWARD one lamp at a time rather than replacing a number — the numeral
   * is the readout, the tree is the clock.
   */
  const [treeLit, setTreeLit] = useState(0);
  /** Index of the currently lit segment; -1 = nothing lit yet. */
  const [litIndex, setLitIndex] = useState(-1);
  const [displayPrize, setDisplayPrize] = useState(0);
  /**
   * Seconds until the engine actually deals, shown once the wheel's own
   * sequence has finished and the felt would otherwise sit empty. See the
   * NO DEAD FELT block below.
   */
  const [dealInSec, setDealInSec] = useState<number | null>(null);
  const dealTickerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const rafRef = useRef<number | null>(null);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  const order = useMemo(() => buildWheelOrder(data?.tiers ?? DEFAULT_SPIN_TIERS), [data?.tiers]);
  // segmentAngle is gone: wedge geometry is computed in SVG user units now.

  /** Where the winning segment sits — where the chase must stop. */
  const targetIndex = useMemo(() => {
    if (!data) return 0;
    const i = order.findIndex((t) => t.multiplier === data.multiplier);
    // An unknown multiplier must never crash the table — land on the nearest.
    if (i >= 0) return i;
    let best = 0;
    let bestDiff = Infinity;
    order.forEach((t, idx) => {
      const d = Math.abs(t.multiplier - data.multiplier);
      if (d < bestDiff) {
        bestDiff = d;
        best = idx;
      }
    });
    return best;
  }, [data, order]);

  // Whole chips (Dan 2026-08-20) - the Spin prize is buy-in x multiplier and
  // the buy-in is whole, so the prize is shown whole too.
  const prize = data ? Math.round(data.buyIn * data.multiplier) : 0;

  useEffect(() => {
    timersRef.current.forEach(clearTimeout);
    timersRef.current = [];
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }

    if (!data) {
      setPhase('idle');
      setLitIndex(-1);
      setCount(COUNTDOWN_FROM);
      setTreeLit(0);
      setDisplayPrize(0);
      return;
    }

    const reduced = prefersReducedMotion();
    const timers: ReturnType<typeof setTimeout>[] = [];

    /**
     * ───────────────────────────────────────────────────────────────────────
     *  SPEED IS CLAMPED TO THE SERVER'S HOLD (2026-08-27)
     * ───────────────────────────────────────────────────────────────────────
     *
     * `getAnimationSpeed()` is a DURATION MULTIPLIER between 0.25 and 3.0, and
     * every phase below was multiplied by it against a hold the engine keeps
     * fixed. At 3.0 the sequence ran 44,400 ms against 16,600 ms of hold, so
     * the first cards landed roughly 28 seconds before the wheel did.
     *
     * `revealDeadlineMs` is when the engine will deal (its own `holdUntil`).
     * The wheel itself must land before the post-reveal beats that precede the
     * deal — chip drop, then button draw — so the budget for THIS sequence is
     * the hold minus `spinPostRevealMs()`.
     *
     * The cap is one-sided on purpose. Faster than the budget is allowed: that
     * player's wheel lands early and the felt simply waits with everyone else,
     * which is a preference honoured without moving a shared moment. Slower is
     * not allowed at all, because slower means being dealt into a hand while
     * the wheel is still asking the question.
     */
    const revealAt = Number(data.revealAtMs);
    const sharedClock = Number.isFinite(revealAt);
    const speed = (() => {
      /* No shared clock at all (a legacy row, a unit test): there is no moment
         to be in step with, so the player's own preference is all there is. */
      if (!sharedClock) return getAnimationSpeed();
      const deadline = Number(data.revealDeadlineMs);
      /* The engine's hold covers the wheel AND the two beats after it — chip
         drop, then button draw. Only the first part belongs to this component. */
      const budgetMs = Number.isFinite(deadline)
        ? Math.max(0, deadline - revealAt - spinPostRevealMs())
        : spinRevealTotalMs();
      const factor = budgetMs > 0 ? budgetMs / spinRevealTotalMs() : 1;
      /* Never stretch past the designed pace even when the server holds longer:
         an over-long hold is dead air the engine owns, not slow motion.
         ─────────────────────────────────────────────────────────────────────
         AND HONOUR THE PLAYER'S PREFERENCE (2026-09-01). `getAnimationSpeed()`
         was consulted only on the no-shared-clock branch above, which never
         happens in production - so the Animation Speed setting did nothing to
         the wheel, while this component's own comment promised the opposite.
         It joins the same one-sided clamp: a player may run the sequence
         FASTER than the budget (their wheel lands early and the felt waits with
         everyone else, and since 'no dead felt' the result card holds until the
         engine deals), never slower, because slower means being dealt into a
         hand while the wheel is still asking the question. */
      return Math.min(factor, getAnimationSpeed(), 1);
    })();

    /**
     * How far into the shared sequence this client already is. A player whose
     * client was slow to load, or who refreshed mid-spin, picks the wheel up
     * where everyone else is rather than starting it again.
     */
    const elapsed = data.revealAtMs ? Math.max(0, Date.now() - data.revealAtMs) : 0;
    /** Dan: "ONE SECOND LATER, A 3...2...1... COUNT DOWN CLOCK MUST BEGIN". */
    const leadInMs = (reduced ? 0 : SPIN_REVEAL.LEAD_IN_MS) * speed;
    /** Schedule against the shared clock: anything already past fires now. */
    const at = (offsetMs: number) => Math.max(0, offsetMs - elapsed);

    /**
     * ═══════════════════════════════════════════════════════════════════════
     *  A LATE ARRIVAL SEES THE RESULT, NOT A FLICKER (2026-09-01)
     * ═══════════════════════════════════════════════════════════════════════
     *
     * Every phase is scheduled through `at()`, which is
     * `max(0, offset - elapsed)`. A client that mounts after the whole
     * sequence has elapsed therefore resolves EVERY phase to zero: countdown,
     * chase, result and exit all fire in the same tick. The player got a
     * four-frame flash - and `onDone` stamps `markSpinRevealPlayed`, so that
     * tab never showed the draw again. The defining moment of the format,
     * spent on a flicker and then suppressed.
     *
     * If the sequence is already past its chase, there is nothing left to
     * animate and the honest thing to show is the answer. Mount into
     * `result`, hold it for the remaining time (and, since "no dead felt", at
     * least until the engine deals), and let the exit happen normally.
     */
    const sequenceElapsedPastChase =
      sharedClock &&
      elapsed >= SPIN_REVEAL.LEAD_IN_MS + SPIN_REVEAL.COUNTDOWN_MS + SPIN_REVEAL.SPIN_MS;

    setPhase(sequenceElapsedPastChase ? 'result' : 'countdown');
    setCount(COUNTDOWN_FROM);
    setTreeLit(0);
    setLitIndex(-1);
    setDisplayPrize(0);

    if (playSounds) {
      try {
        /* ── SILENCE IS A DEFECT, AND IT MUST LEAVE A TRACE (round 17) ─────
           Dan, 2026-08-30: "ANIMATION STARTED WHEN BOUGHT IN, BUT WITH NO
           SOUND EFFECTS." Every gate in SoundService was read line by line
           that day and each was individually correct, which left nothing to
           blame and a silent wheel — the worst kind of bug report to answer.
           So the wheel now ASKS why it would be inaudible, at the instant it
           tries, and reports it once. The next time this happens it is a
           searchable event with a reason on it instead of a guess. */
        const reason = soundService.inaudibleReason();
        if (reason) {
          reportError(
            new Error(`spin reveal had no audio: ${reason}`),
            'SpinWheel.reveal_inaudible',
            { reason, multiplier: data.multiplier }
          );
        }
        soundService.playSpinStart();
      } catch {
        /* audio is best-effort */
      }
    }

    // ── 1. Countdown: 3 · 2 · 1 ─────────────────────────────────────────────
    const countdownMs = (reduced ? 200 : COUNTDOWN_FROM * COUNTDOWN_STEP_MS) * speed;
    if (!reduced) {
      // One lamp per step: red, yellow, green. Step 0 lights on Dan's
      // one-second beat and keeps the numeral already on screen; steps 1 and 2
      // advance it. The beep is fired here rather than from a render effect so
      // it cannot double up when React re-renders for another reason.
      for (let k = 0; k < COUNTDOWN_FROM; k++) {
        timers.push(
          setTimeout(
            () => {
              setTreeLit(k + 1);
              if (k > 0) setCount(COUNTDOWN_FROM - k);
              if (playSounds) {
                try {
                  soundService.playSpinCountdownLight(k);
                } catch {
                  /* audio is best-effort */
                }
              }
            },
            at(leadInMs + k * COUNTDOWN_STEP_MS * speed)
          )
        );
      }
    } else {
      setTreeLit(COUNTDOWN_FROM);
    }

    // ── 2. The chase ────────────────────────────────────────────────────────
    const chaseMs = (reduced ? 400 : CHASE_MS) * speed;
    timers.push(
      setTimeout(
        () => {
          setPhase('chase');
          /* How far into the CHASE this client already is. `at()` above put us
             at the right phase; this puts the runner at the right segment. */
          const intoChase = Math.max(0, elapsed - (leadInMs + countdownMs));
          const schedule = reduced ? [] : chaseSchedule(order.length, targetIndex, chaseMs);
          const { litNow, remaining } = chaseCatchUp(schedule, intoChase);
          if (playSounds) {
            try {
              // Dan: "CLICKING SOUNDS AS IT PASSES." Handing the sound the
              // light's OWN schedule is what makes that literally true — one
              // peg strike per segment crossed, on the same millisecond,
              // because it is the same array. Passing only a duration left the
              // two to drift apart on any easing change. It is the CAUGHT-UP
              // schedule for the same reason the light is: pegs for segments
              // already crossed would strike after the result was announced.
              soundService.playSpinTicking(
                Math.max(0, chaseMs - intoChase),
                remaining.map((r) => r.at)
              );
            } catch {
              /* best effort */
            }
          }
          if (reduced) {
            setLitIndex(targetIndex);
          } else {
            /* Light where the runner actually is before scheduling the rest,
               so a caught-up client never shows an empty disc. */
            if (litNow >= 0) setLitIndex(litNow % order.length);
            for (const step of remaining) {
              timers.push(setTimeout(() => setLitIndex(step.stepIdx % order.length), step.at));
            }
          }
        },
        at(leadInMs + countdownMs)
      )
    );

    // ── 3. Result ───────────────────────────────────────────────────────────
    timers.push(
      setTimeout(
        () => {
          setPhase('result');
          setLitIndex(targetIndex);
          if (playSounds) {
            try {
              soundService.playSpinMultiplierResult(data.multiplier);
            } catch {
              /* best effort */
            }
          }
          fireVibration(data.multiplier >= 25 ? [50, 30, 80] : [25, 20, 40]);

          // Count the PRIZE up, not the multiplier. "You are playing for $30"
          // is the fact that matters; the multiple is how it was arrived at.
          if (reduced) {
            setDisplayPrize(prize);
          } else {
            const started = performance.now();
            const durationMs = 900 * speed;
            const step = (now: number) => {
              const t = Math.min(1, (now - started) / durationMs);
              const eased = 1 - Math.pow(1 - t, 3);
              setDisplayPrize(Math.round(prize * eased * 100) / 100);
              if (t < 1) {
                rafRef.current = requestAnimationFrame(step);
              } else {
                rafRef.current = null;
                setDisplayPrize(prize);
              }
            };
            rafRef.current = requestAnimationFrame(step);
          }
        },
        at(leadInMs + countdownMs + chaseMs)
      )
    );

    /**
     * ═══════════════════════════════════════════════════════════════════════
     *  NO DEAD FELT (Dan, 2026-09-01, binding)
     * ═══════════════════════════════════════════════════════════════════════
     *
     * Dan, verbatim: "THERE SHOULD NEVER BE THIS 14 SECONDS OR 10 SECONDS OF
     * DEAD ANYTHING ANYWHERE."
     *
     * What he is describing was measured. Under reduced motion this sequence
     * collapses to about 2.4 seconds (lead-in 0, countdown 200ms, chase 400ms,
     * result 1800ms) while the engine holds the deal for spinRevealToDealMs()
     * regardless. The wheel therefore unmounted and handed back an EMPTY table
     * with zero-chip seats and nothing on screen explaining the wait, for about
     * fourteen seconds. The same gap opens, smaller, for a fast animation-speed
     * setting, and it opens fully for a client that joins late.
     *
     * So the felt is not handed back until the engine is ready to use it, and
     * the result card stays up with a live "Dealing In N" while it waits.
     * Speeding the ANIMATION up is a preference and is still honoured; being
     * shown nothing is not a preference, it is an empty screen.
     *
     * Nothing is slowed down: the exit is the LATER of this component's own
     * sequence and the moment the engine deals, so a wheel already running to
     * full length is untouched.
     *
     * CLAUDE.md 10.6 - reduced motion collapses MOTION, never MEANING. The
     * countdown carries duration, so it is marked data-motion="keep".
     */
    const ownEndMs = leadInMs + countdownMs + chaseMs + (reduced ? 1800 : RESULT_MS) * speed;
    /* When the engine will deal. Derived from the shared clock and the spec
       rather than from `revealDeadlineMs`, which the fallback path does not
       set - so this holds even for a client the socket never reached. */
    const sequenceStartMs = sharedClock ? revealAt : Date.now() - elapsed;
    const dealAtMs = sharedClock ? revealAt + spinRevealToDealMs() : sequenceStartMs + ownEndMs;

    /* One ticker for the whole wait. It shows nothing until this component's
       own sequence is done, then counts the remaining seconds down. */
    const dealTicker = setInterval(() => {
      const remainingMs = dealAtMs - Date.now();
      const ownDone = Date.now() - sequenceStartMs >= ownEndMs;
      setDealInSec(ownDone && remainingMs > 0 ? Math.ceil(remainingMs / 1000) : null);
    }, 250);

    timers.push(
      setTimeout(
        () => {
          clearInterval(dealTicker);
          dealTickerRef.current = null;
          setDealInSec(null);
          setPhase('idle');
          onDoneRef.current();
        },
        Math.max(at(ownEndMs), dealAtMs - Date.now())
      )
    );
    dealTickerRef.current = dealTicker;

    timersRef.current = timers;
    return () => {
      timersRef.current.forEach(clearTimeout);
      timersRef.current = [];
      /* An interval is not a timeout: clearTimeout does not reliably stop one
         outside a browser, so it gets its own handle and its own clear. */
      if (dealTickerRef.current !== null) {
        clearInterval(dealTickerRef.current);
        dealTickerRef.current = null;
      }
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [data, playSounds, targetIndex, order.length, prize]);

  if (!data || phase === 'idle') return null;

  const currency = data.currency ?? '';
  const won = order[targetIndex];
  /* How loudly this draw celebrates - see spinCelebration. One source for the
     banner, the burst size and the audio level, so the wheel and the sound
     can never disagree about how rare this moment was. */
  const celebration = spinCelebration(data.multiplier);

  /**
   * ═══════════════════════════════════════════════════════════════════════
   *  WHAT A PLAYER WHO CANNOT SEE THE DISC IS TOLD (2026-08-31 audit)
   * ═══════════════════════════════════════════════════════════════════════
   *
   * This component is `role="dialog" aria-modal="true"`, so a screen reader
   * announces "Spin Multiplier Draw, dialog" and then — because every moving
   * part below is correctly `aria-hidden` decoration — says NOTHING for the
   * 16.6 seconds the engine holds the deal. The multiplier, the prize pool
   * and who actually cashes were all visual-only. The player was then dealt
   * into a tournament without ever being told what they were playing for.
   *
   * `aria-modal` makes it worse rather than better: it tells assistive tech
   * to ignore everything outside this dialog, so the silence is total.
   *
   * CLAUDE.md 10.6 says a reduced-motion player loses the MOTION and keeps
   * the MEANING. This is the same law on a different channel, and the wheel
   * was failing it completely. `BBJHitNotification` is the house precedent —
   * `role="status"`, `aria-live="polite"`, one sentence — and the platform
   * was announcing a Bad Beat Jackpot to a blind player while staying silent
   * about the moment the Spin format exists for.
   *
   * Two announcements, not a running commentary: one when the draw begins so
   * the dialog is not silent, and one carrying the result. `aria-live` is
   * polite so it never interrupts, and the region is rendered from the first
   * frame — a live region inserted at the same time as its text is missed by
   * several screen readers.
   */
  const announcement = (() => {
    /* `idle` never reaches here — the component returns null above — so the
       only two states are "the draw is running" and "here is the result". */
    if (phase !== 'result') return 'Drawing Your Multiplier.';
    const splits = (spinTier(data.multiplier)?.payouts ?? [1])
      .map((pct, i) => {
        const place = ['First', 'Second', 'Third'][i] ?? `Place ${i + 1}`;
        return `${place} ${currency}${(Math.round(prize * pct * 100) / 100).toLocaleString()}`;
      })
      .join(', ');
    return `${data.multiplier} Times. Prize Pool ${currency}${prize.toLocaleString()}. Paying ${splits}.`;
  })();

  return (
    <div
      className={`sw sw--${phase} ${tierClass(data.multiplier)}${scoped ? ' sw--scoped' : ''}${
        captureInput ? '' : ' sw--passthrough'
      }`}
      /**
       * ═══════════════════════════════════════════════════════════════════
       *  NOT A DIALOG (2026-09-01)
       * ═══════════════════════════════════════════════════════════════════
       *
       * This carried `role="dialog" aria-modal="true"` and had no focusable
       * control, no focus move and no way to dismiss it. `aria-modal` tells
       * assistive tech to ignore EVERYTHING outside the element, so a screen
       * reader announced "Spin Multiplier Draw, dialog" and then hid the rest
       * of the table for the whole hold - in exchange for an overlay the
       * player cannot interact with at all.
       *
       * A focus trap would be the fix if there were anything to focus. There
       * is not: the wheel is a decoration that resolves itself. So it stops
       * claiming to be a dialog, and the meaning is carried by the live region
       * below, which was added on 2026-08-31 and already says the multiplier,
       * the prize pool and who cashes.
       */
      aria-label="Spin Multiplier Draw"
    >
      {/* Rendered from the first frame and never removed: a live region that
          appears at the same moment as its text is missed by several screen
          readers. See "WHAT A PLAYER WHO CANNOT SEE THE DISC IS TOLD". */}
      <div className="sr-only" role="status" aria-live="polite">
        {announcement}
      </div>

      {/* The table stays visible: a vignette dims it and a spotlight beam
          falls from the top of the screen, exactly like the reference. */}
      <div className="sw__dim" />
      <div className="sw__beam" aria-hidden="true" />

      <div className="sw__stage">
        {phase === 'countdown' && (
          <>
            {/* The tree sits ABOVE the numeral, not behind it. Dan 2026-08-21:
                "MOVE THE RED LIGHT, UP HIGHER SO ITS NOT BEING OVERLAPPED BY
                THE NUMBERS COUNTING DOWN." */}
            <div className="sw__tree" aria-hidden="true">
              {[0, 1, 2].map((k) => (
                <i
                  key={k}
                  className={`sw__lamp sw__lamp--${k}${treeLit > k ? ' sw__lamp--on' : ''}`}
                />
              ))}
            </div>
            <div className={`sw__count sw__count--${count}`} key={count} aria-hidden="true">
              {count}
            </div>
          </>
        )}

        {(phase === 'chase' || phase === 'result') && (
          <div className="sw__disc-wrap">
            <div className={`sw__disc${phase === 'result' ? ' sw__disc--settled' : ''}`}>
              {/* Dark carbon, one flat colour. Dan 2026-08-21: "REMOVE THE
                  GRADIENT ON THE OUTSIDE OF THE WHEEL... KEEP IT A SOLID
                  COLOR", then "CHANGE THE OUTSIDE OF THE WHEEL TO DARK CARBON
                  FIBER COLOR." The eight-stop conic gold it replaced was the
                  busiest thing on screen and fought the segments for
                  attention. */}
              <div className="sw__rim" aria-hidden="true" />

              <svg
                className="sw__svg"
                viewBox={`0 0 ${SW_VIEWBOX} ${SW_VIEWBOX}`}
                aria-hidden="true"
              >
                <defs>
                  {/* Two blur radii on purpose. The travelling chase light is
                      allowed to bloom; the winner's outline is NOT, because a
                      wide blur bleeds onto its neighbours and Dan's note was
                      exact: "DON'T HIGHLIGHT THE ENTIRE WHEEL. JUST THE
                      WINNING MULTIPLIER." */}
                  <filter id="swGlowWide" x="-70%" y="-70%" width="240%" height="240%">
                    <feGaussianBlur stdDeviation="7" result="b" />
                    <feMerge>
                      <feMergeNode in="b" />
                      <feMergeNode in="SourceGraphic" />
                    </feMerge>
                  </filter>
                  <filter id="swGlowTight" x="-70%" y="-70%" width="240%" height="240%">
                    <feGaussianBlur stdDeviation="3.5" result="b" />
                    <feMerge>
                      <feMergeNode in="b" />
                      <feMergeNode in="SourceGraphic" />
                    </feMerge>
                  </filter>
                </defs>

                {order.map((tier, i) => {
                  const isLit = i === litIndex;
                  // The segment the runner JUST left keeps a fading ember, so
                  // the chase reads as motion rather than a blinking light.
                  const wasLit =
                    phase === 'chase' &&
                    litIndex >= 0 &&
                    i === (litIndex - 1 + order.length) % order.length;
                  const isWinner = phase === 'result' && i === targetIndex;
                  const label = segmentPoint(i, order.length, 78);
                  const unlocksAt = lockedDetail.get(tier.multiplier)?.unlocksAt;
                  return (
                    <g
                      key={`${tier.multiplier}-${i}`}
                      className={[
                        'sw__seg',
                        `sw__seg--c${i % 9}`,
                        isLit ? 'sw__seg--lit' : '',
                        wasLit ? 'sw__seg--trail' : '',
                        isWinner ? 'sw__seg--winner' : '',
                        locked.has(tier.multiplier) ? 'sw__seg--locked' : '',
                      ]
                        .filter(Boolean)
                        .join(' ')}
                    >
                      <path className="sw__seg-face" d={wedgePath(i, order.length)} />
                      <text className="sw__seg-label" x={label.x} y={label.y + 7}>
                        {tier.multiplier}
                      </text>
                      {unlocksAt ? (
                        <title>
                          {`${tier.multiplier}x Unlocks At A ${currency}${Number(
                            unlocksAt
                          ).toLocaleString(undefined, { maximumFractionDigits: 0 })} Reserve`}
                        </title>
                      ) : null}
                    </g>
                  );
                })}

                {/* Gold pegs on the rim: the things the flapper is striking.
                    Without something visible to hit, the clicking has no
                    source and reads as a sound effect laid over a picture. */}
                {order.map((_, i) => {
                  const seg = 360 / order.length;
                  const a = (((i + 0.5) * seg - 90 - seg / 2) * Math.PI) / 180;
                  return (
                    <circle
                      key={`peg-${i}`}
                      className="sw__peg"
                      cx={SW_CX + (SW_R - 4) * Math.cos(a)}
                      cy={SW_CY + (SW_R - 4) * Math.sin(a)}
                      r={3.2}
                    />
                  );
                })}

                {/* The winner's outline: a wide gold halo under a hot white
                    core, tracing the WHOLE wedge. Dan: "THE OUTLINE OF THE
                    WINNING CARD NEEDS TO BE HIGHLIGHTED WITH NEON AND
                    FLASHING, NOT JUST THE TOP" — an arc along the rim alone
                    was the version that earned that note. Two stacked strokes
                    is what makes a stroke read as neon rather than as a
                    border. */}
                {phase === 'result' && (
                  <>
                    <path
                      className="sw__edge sw__edge--halo"
                      d={wedgePath(targetIndex, order.length, SW_R - 4)}
                      filter="url(#swGlowTight)"
                    />
                    <path
                      className="sw__edge sw__edge--core"
                      d={wedgePath(targetIndex, order.length, SW_R - 4)}
                    />
                  </>
                )}
              </svg>

              <div className="sw__gloss" aria-hidden="true" />
              <div className="sw__hub">
                {phase === 'result' ? (
                  <span className="sw__hub-mult">{won?.multiplier ?? data.multiplier}×</span>
                ) : (
                  <span className="sw__hub-brand">SPIN-IT</span>
                )}
              </div>
            </div>
          </div>
        )}

        {/* ── Below the disc ── */}
        {phase === 'chase' && (
          <div className="sw__status">
            <span className="sw__status-sub">
              {currency}
              {Math.round(data.buyIn).toLocaleString('en-US')} Buy-In
            </span>
            {nextUnlock && (
              <span className="sw__status-locked">
                {nextUnlock.multiplier}× Unlocks When The Club Reserve Reaches {currency}
                {(nextUnlock.unlocksAt as number).toLocaleString(undefined, {
                  maximumFractionDigits: 0,
                })}
              </span>
            )}
          </div>
        )}

        {phase === 'result' && (
          <div className="sw__result">
            <div className="sw__prize">
              {currency}
              {displayPrize.toLocaleString(undefined, {
                minimumFractionDigits: prize % 1 === 0 ? 0 : 2,
                maximumFractionDigits: 2,
              })}
            </div>
            <div className="sw__prize-label">PRIZE POOL</div>

            {/* Who actually cashes. At 2x-5x only the winner does, and saying
                so up front is kinder than letting second place find out at the
                end of a three-minute tournament. */}
            <div className="sw__splits">
              {(spinTier(data.multiplier)?.payouts ?? [1]).map((pct, i) => (
                <span key={i} className="sw__split">
                  <span className="sw__split-place">
                    {['1st', '2nd', '3rd'][i] ?? `${i + 1}th`}
                  </span>
                  <span className="sw__split-amt">
                    {currency}
                    {(Math.round(prize * pct * 100) / 100).toLocaleString()}
                  </span>
                </span>
              ))}
            </div>
            {/* ROUND 15: the banner text and the burst below both come from
                spinCelebration, the one place that decides how loudly a draw
                celebrates - so 25x, 50x and 100x stop sharing one treatment
                and a 10x stops getting none. */}
            {celebration.label && (
              <div className={`sw__hype sw__hype--${celebration.band}`}>{celebration.label}</div>
            )}

            {/* NO DEAD FELT: the wheel never hands back an empty table. While
                the engine finishes its hold the player is told what is
                happening rather than shown nothing. */}
            {dealInSec !== null && (
              <div className="sw__dealing" data-motion="keep" aria-hidden="true">
                Dealing In {dealInSec}
              </div>
            )}
          </div>
        )}
      </div>

      {phase === 'result' && celebration.confettiPieces > 0 && (
        <div className={`sw__confetti sw__confetti--${celebration.band}`} aria-hidden="true">
          {/* ═══════════════════════════════════════════════════════════════
              THE CELEBRATION HAS TO FIT ON THE SCREEN (2026-09-01)

              `left: calc((var(--sw-c) * 4.16%) + 2%)` is 100/24: a spread
              tuned by hand for 24 pieces. The tiers emit 16 / 32 / 48 / 72, so
              every piece from index 24 up landed past 101.8% and was clipped -
              a 50x and a 100x rendered IDENTICALLY to a 25x, which is the one
              moment the format exists for. The delay had the same shape:
              `index * 55ms` puts piece 71 at 3.905s against a 4.8s hold and a
              1.8s fall, so the last pieces fell after the wheel had gone.

              The count is now a variable, so the spread and the delay are
              derived from how many pieces there actually are.
              ═══════════════════════════════════════════════════════════════ */}
          {Array.from({ length: celebration.confettiPieces }, (_, i) => (
            <span
              key={i}
              className="sw__conf"
              style={{
                ['--sw-c' as string]: i,
                ['--sw-c-total' as string]: celebration.confettiPieces,
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}
