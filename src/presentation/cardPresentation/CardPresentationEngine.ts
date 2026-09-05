/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CARD PRESENTATION ENGINE — identity, idempotency, timing, cleanup
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * RIVER SQUEEZE 2026-09-04. The engine owns everything about a community-card
 * presentation EXCEPT the pixels: which presentations exist, that each plays
 * at most once, which one is current on a lane, how long the board must keep
 * the animation markup mounted, and what telemetry says about it. The pixels
 * are compositor-side CSS keyframes on the existing two-surface flip markup in
 * CommunityCards; the engine never touches the DOM.
 *
 * THE INVARIANT (spec 4): if every timer here is cancelled, fires late, or is
 * never scheduled, the board is still correct - CommunityCards renders the
 * authoritative face and the flip's resting transform is face up. The engine
 * only decides for how long the TEMPORARY flip markup stays mounted.
 *
 * What it must never do (spec 3, 61): read or write poker state, gate an
 * action timer, delay a hand, or be waited on by anything the server drives.
 * It has no reference to a table store and takes no callbacks that could
 * mutate one.
 *
 *   IDLE -> PREPARE -> HOLD -> SQUEEZE -> REVEAL -> SETTLE -> COMPLETE
 *   any  -> CANCELLED                                  (spec 13, 66)
 *
 * Phases are derived from a monotonic clock (spec 104), not stepped by five
 * timers per card: one timer per presentation marks completion; anyone who
 * wants the current phase (the dev overlay) asks `phaseAt()`.
 */

import { buildAnimationKey, isOlderHand, laneKey } from './animationKey';
import {
  DEGRADED_FPS_THRESHOLD,
  rafFrameSampler,
  type FrameSample,
  type FrameSamplerStart,
} from './frameSampler';
import { FLOP_FAN_TOTAL_MS, MOUNT_WINDOW_MARGIN_MS } from './profiles';
import { resolveCardAnimationProfile } from './resolveProfile';
import type {
  CardAnimationProfile,
  CardPresentationPhase,
  CommunityCardDealPresentation,
  PhaseListener,
  PresentResult,
  ResolveProfileInput,
  TelemetrySink,
} from './types';

export interface CardPresentationEngineOptions {
  telemetry?: TelemetrySink;
  /** Monotonic ms. Defaults to performance.now(). */
  now?: () => number;
  /** The --animation-speed multiplier at presentation time. Defaults to 1. */
  speed?: () => number;
  /**
   * Frame-rate sampling (spec 63, 64). Defaults to the rAF sampler; tests
   * pass a no-op. Sampled at `frameSampleRate` because a rAF loop on every
   * river would be the jank it is measuring.
   */
  frameSampler?: FrameSamplerStart;
  /** 0..1, how often a presentation is frame-sampled. Default 0.05. */
  frameSampleRate?: number;
  /** Injectable randomness so the sampling decision is testable. */
  random?: () => number;
  /** How many keys the duplicate registry remembers. */
  maxProcessed?: number;
}

interface ActivePresentation {
  readonly key: string;
  readonly event: CommunityCardDealPresentation;
  readonly profile: CardAnimationProfile;
  /**
   * AUDIT FIX 2026-09-05: the mode and platform THIS PRESENTATION resolved
   * from, kept beside the profile it resolved to. `animation_started` used
   * the caller's input and `animation_completed` used the profile constant,
   * and those are different for most real sessions - a tournament all-in
   * started as `tournament` and completed as `cash` (allIn.mode is 'cash'),
   * a phone completed as `desktop`, and a tablet completed as desktop always
   * because no profile carries `platform: 'tablet'`. Joining the two events
   * on those dimensions gave incoherent totals.
   */
  readonly mode: CardAnimationProfile['mode'];
  readonly platform: CardAnimationProfile['platform'];
  /** What the animation on screen actually takes, which is not always the profile. */
  readonly expectedMs: number;
  readonly startedAt: number;
  /** Speed-scaled phase end offsets, ms from startedAt. */
  readonly ends: { prepare: number; hold: number; squeeze: number; reveal: number; settle: number };
  timer: ReturnType<typeof setTimeout> | null;
  /**
   * ROUND 2 2026-09-05: fires at the EDGE-ON instant, where the two
   * backface-hidden surfaces swap and the face first appears. That is the
   * beat the card lands on in the reference recording, and it is what the
   * board plays its snap on - not the street transition, which on an all-in
   * runout is a full second earlier (the card is still face down then).
   */
  revealTimer: ReturnType<typeof setTimeout> | null;
  /** Cancel for the frame sampler, when this presentation was sampled. */
  stopSampling: (() => void) | null;
}

export interface ActivePresentationView {
  readonly key: string;
  readonly boardIndex: number;
  readonly street: CommunityCardDealPresentation['street'];
  readonly profile: CardAnimationProfile;
  readonly phase: CardPresentationPhase;
  readonly elapsedMs: number;
  readonly expectedMs: number;
}

const DEFAULT_MAX_PROCESSED = 256;

function monotonicNow(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

export class CardPresentationEngine {
  private readonly telemetry: TelemetrySink;
  private readonly now: () => number;
  private readonly speed: () => number;
  private readonly maxProcessed: number;
  private readonly frameSampler: FrameSamplerStart;
  private readonly frameSampleRate: number;
  private readonly random: () => number;

  /** Insertion-ordered so the oldest key is evicted first (spec 15). */
  private readonly processed = new Map<string, true>();
  private readonly active = new Map<string, ActivePresentation>();
  /** lane -> active key; a lane plays one presentation at a time (spec 102). */
  private readonly lanes = new Map<string, string>();
  /** table -> newest hand seen; an older hand's card is stale (spec 16, 31). */
  private readonly latestHand = new Map<string, string | number>();
  /**
   * lane -> the furthest street presented on it, for THIS hand (spec 16, 84,
   * 103). Hand-level staleness alone cannot catch a late turn arriving after
   * the river: same hand, same board, and the registry only knows the turn was
   * not presented BEFORE - not that the board has since moved past it. A
   * reconnect replays exactly that shape, and animating it would turn a card
   * over that is already face up.
   */
  private readonly laneProgress = new Map<string, { handId: string | number; sequence: number }>();
  private readonly listeners = new Set<PhaseListener>();

  constructor(opts: CardPresentationEngineOptions = {}) {
    this.telemetry = opts.telemetry ?? (() => {});
    this.now = opts.now ?? monotonicNow;
    this.speed = opts.speed ?? (() => 1);
    this.maxProcessed = opts.maxProcessed ?? DEFAULT_MAX_PROCESSED;
    this.frameSampler = opts.frameSampler ?? rafFrameSampler;
    this.frameSampleRate = opts.frameSampleRate ?? 0.05;
    this.random = opts.random ?? Math.random;
  }

  /**
   * Present a dealt community card. Returns what the board should do:
   *   started    mount the animation markup for `durationMs` (base ms; scale
   *              by the animation speed exactly as the CSS does)
   *   instant    render the final card now (hidden table)
   *   duplicate  already presented - change nothing
   *   stale      an older hand than the table has moved on to - change nothing
   */
  presentCard(event: CommunityCardDealPresentation, input: ResolveProfileInput): PresentResult {
    const key = buildAnimationKey(event);
    const profile = resolveCardAnimationProfile(input);
    const base = {
      key,
      street: event.street,
      boardIndex: event.boardIndex,
      profile: profile.id,
      platform: input.platform,
      mode: input.mode,
      durationExpected: event.street === 'flop' ? FLOP_FAN_TOTAL_MS : profile.durationMs,
    } as const;

    if (this.processed.has(key)) {
      this.telemetry({ ...base, event: 'animation_duplicate_ignored' });
      return { status: 'duplicate', key, profile, durationMs: 0 };
    }

    const latest = this.latestHand.get(event.tableId);
    if (latest !== undefined && isOlderHand(event.handId, latest)) {
      this.remember(key);
      this.telemetry({ ...base, event: 'animation_skipped', reason: 'stale-hand' });
      return { status: 'stale', key, profile, durationMs: 0 };
    }
    const lane = laneKey(event);
    const progress = this.laneProgress.get(lane);
    if (progress && progress.handId === event.handId && event.sequence < progress.sequence) {
      this.remember(key);
      this.telemetry({ ...base, event: 'animation_skipped', reason: 'out-of-order' });
      return { status: 'stale', key, profile, durationMs: 0 };
    }
    /* AUDIT FIX 2026-09-05: BOUND THESE TWO.
       `processed` was capped from the start; these were not, and they are the
       ones that actually grow. `useCardSqueeze` gives every replayed hand its
       OWN surface id, so a player who opens five hundred hands in the hand
       history leaves five hundred `latestHand` entries and as many
       `laneProgress` entries in a process-global singleton, for the life of
       the tab. Evicting oldest-first is safe: the worst case for a table that
       falls off the end is that one card animates which would have been
       suppressed, and the board is correct either way. */
    this.rememberIn(this.latestHand, event.tableId, event.handId);
    this.rememberIn(this.laneProgress, lane, {
      handId: event.handId,
      sequence: event.sequence,
    });
    this.remember(key);

    if (profile.intensity === 'off' || profile.durationMs <= 0) {
      this.telemetry({ ...base, event: 'animation_skipped', reason: profile.id });
      return { status: 'instant', key, profile, durationMs: 0 };
    }

    // One presentation per lane: a newer card on the same board pre-empts an
    // older one still mid-flight, and that one renders its final state.
    const previous = this.lanes.get(lane);
    if (previous && previous !== key) this.cancel(previous, 'superseded');

    // A server-paced reveal may run FASTER than spec but never slower: the
    // engine's equity gate is a fixed wall-clock hold that does not know this
    // client's speed. See serverPaced in types.ts.
    const s = profile.serverPaced ? Math.min(1, this.speed()) : this.speed();
    const startedAt = this.now();
    // The flop runs its own fan, not the squeeze; the profile does not
    // describe it (see FLOP_FAN_TOTAL_MS).
    const expectedMs = event.street === 'flop' ? FLOP_FAN_TOTAL_MS : profile.durationMs;
    const prepare = profile.prepareMs * s;
    const hold = prepare + profile.holdMs * s;
    const squeeze = hold + profile.squeezeMs * s;
    const reveal = squeeze + profile.revealMs * s;
    const settle = reveal + profile.settleMs * s;
    const entry: ActivePresentation = {
      key,
      event,
      profile,
      mode: input.mode,
      platform: input.platform,
      expectedMs,
      startedAt,
      ends: { prepare, hold, squeeze, reveal, settle },
      timer: null,
      revealTimer: null,
      stopSampling: null,
    };
    entry.timer = setTimeout(
      () => this.complete(key),
      Math.ceil(Math.max(settle, expectedMs * s) + MOUNT_WINDOW_MARGIN_MS * s)
    );
    // The face appears at the edge-on instant, which is the END of the
    // squeeze beat. Listeners (the board's sound cue) hang off this.
    entry.revealTimer = setTimeout(() => {
      const live = this.active.get(key);
      if (!live) return;
      live.revealTimer = null;
      this.notify(key, 'reveal', this.now() - live.startedAt);
    }, Math.ceil(squeeze));
    /* AUDIT FIX 2026-09-05: REGISTER FIRST. A sampler that completes
       synchronously - any injected one, and a plausible future rAF shim -
       landed in reportFrameSample before the entry existed and was silently
       discarded. The rAF sampler happens never to do it, which is exactly the
       kind of accident that holds until it does not. */
    this.active.set(key, entry);
    this.lanes.set(lane, key);
    if (this.random() < this.frameSampleRate) {
      entry.stopSampling = this.frameSampler(settle, (sample) =>
        this.reportFrameSample(key, sample)
      );
    }
    this.telemetry({ ...base, event: 'animation_started' });
    this.notify(key, 'prepare', 0);

    return {
      status: 'started',
      key,
      profile,
      durationMs: expectedMs + MOUNT_WINDOW_MARGIN_MS,
    };
  }

  /** The presentation ran its course; the persistent card is now the board. */
  complete(key: string): void {
    const entry = this.active.get(key);
    if (!entry) return;
    this.release(entry);
    const elapsed = this.now() - entry.startedAt;
    this.telemetry({
      event: 'animation_completed',
      key,
      street: entry.event.street,
      boardIndex: entry.event.boardIndex,
      profile: entry.profile.id,
      platform: entry.platform,
      mode: entry.mode,
      durationExpected: entry.expectedMs,
      durationActual: Math.round(elapsed),
    });
    this.notify(key, 'complete', elapsed);
  }

  /** Interrupt (spec 66): the board renders its authoritative final state. */
  cancel(key: string, reason: string): void {
    const entry = this.active.get(key);
    if (!entry) return;
    this.release(entry);
    const elapsed = this.now() - entry.startedAt;
    this.telemetry({
      event: 'animation_cancelled',
      key,
      street: entry.event.street,
      boardIndex: entry.event.boardIndex,
      profile: entry.profile.id,
      platform: entry.platform,
      mode: entry.mode,
      durationExpected: entry.expectedMs,
      durationActual: Math.round(elapsed),
      reason,
    });
    this.notify(key, 'cancelled', elapsed);
  }

  skip(key: string): void {
    this.cancel(key, 'skipped');
  }

  /** Cancel everything in flight on a table (unmount, hidden, reconnect). */
  cancelTable(tableId: string, reason: string): void {
    for (const entry of Array.from(this.active.values())) {
      if (entry.event.tableId === tableId) this.cancel(entry.key, reason);
    }
  }

  /**
   * Cancel every presentation on every surface (spec 39, 40, 66, 76, 77).
   *
   * The environment interrupts use this: a window resize, an orientation
   * change or the tab being backgrounded all invalidate the geometry a flip
   * is running against, and correctness beats visual continuation - every
   * card renders its authoritative final state instead of finishing a turn
   * against a board that has moved underneath it.
   */
  cancelAll(reason: string): void {
    for (const entry of Array.from(this.active.values())) this.cancel(entry.key, reason);
  }

  isActive(key: string): boolean {
    return this.active.has(key);
  }

  /** Phase by the monotonic clock (spec 13) - no per-phase timers. */
  phaseAt(key: string, at: number = this.now()): CardPresentationPhase {
    const entry = this.active.get(key);
    if (!entry) return this.processed.has(key) ? 'complete' : 'idle';
    const t = at - entry.startedAt;
    const e = entry.ends;
    if (t < e.prepare) return 'prepare';
    if (t < e.hold) return 'hold';
    if (t < e.squeeze) return 'squeeze';
    if (t < e.reveal) return 'reveal';
    return 'settle';
  }

  /** Read-only view for the dev overlay (spec 111). */
  activeViews(at: number = this.now()): ActivePresentationView[] {
    return Array.from(this.active.values()).map((entry) => ({
      key: entry.key,
      boardIndex: entry.event.boardIndex,
      street: entry.event.street,
      profile: entry.profile,
      phase: this.phaseAt(entry.key, at),
      elapsedMs: Math.round(at - entry.startedAt),
      expectedMs: Math.round(entry.ends.settle),
    }));
  }

  subscribe(listener: PhaseListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Forget a table entirely - a new session at the same table starts clean. */
  forgetTable(tableId: string): void {
    this.cancelTable(tableId, 'forgotten');
    this.latestHand.delete(tableId);
    const prefix = `table:${tableId}/`;
    for (const key of Array.from(this.processed.keys())) {
      if (key.startsWith(prefix)) this.processed.delete(key);
    }
    for (const lane of Array.from(this.laneProgress.keys())) {
      if (lane.startsWith(prefix)) this.laneProgress.delete(lane);
    }
  }

  /** Cancel everything and drop every listener (spec 99, 100). */
  dispose(): void {
    for (const entry of Array.from(this.active.values())) this.cancel(entry.key, 'disposed');
    this.listeners.clear();
    this.lanes.clear();
    this.laneProgress.clear();
    this.processed.clear();
    this.latestHand.clear();
  }

  /** Test/diagnostic: how many presentations are mid-flight. */
  get activeCount(): number {
    return this.active.size;
  }

  /* ROUND 2 2026-09-05: the counters the soak test measures. A leak here is
     invisible for an hour - the animation still plays and the tab just gets
     heavier - so every internal collection is countable from outside and
     tests/unit/cardPresentation/soak.test.ts drives a thousand hands through
     them. They are reads; nothing about the engine's behaviour depends on
     them existing. */

  /** Lanes currently held (one per table-and-board with work in flight). */
  get laneCount(): number {
    return this.lanes.size;
  }

  /** Keys in the bounded duplicate registry. */
  get processedSize(): number {
    return this.processed.size;
  }

  /** The registry's ceiling, so a test can assert the bound rather than a literal. */
  get maxProcessedKeys(): number {
    return this.maxProcessed;
  }

  /** Tables whose newest hand is remembered for stale rejection. */
  get trackedTableCount(): number {
    return this.latestHand.size;
  }

  /** Live phase listeners. */
  get listenerCount(): number {
    return this.listeners.size;
  }

  /**
   * Lanes whose street progression is remembered. AUDIT FIX 2026-09-05: this
   * had no counter, which is exactly why the soak could not see that the map
   * had no bound - every other collection was measured and this one was not.
   */
  get laneProgressSize(): number {
    return this.laneProgress.size;
  }

  private remember(key: string): void {
    this.rememberIn(this.processed, key, true);
  }

  /** Insertion-ordered set-with-a-ceiling; the oldest key falls off the end. */
  private rememberIn<K, V>(map: Map<K, V>, key: K, value: V): void {
    map.delete(key);
    map.set(key, value);
    while (map.size > this.maxProcessed) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
  }

  /**
   * A sampled presentation that painted below the threshold is reported once,
   * with the measured rate. It is never acted on here: degrading an animation
   * because a previous one stuttered is how a product ends up permanently
   * animation-free on a device that had one bad second (CLAUDE.md 10.6).
   */
  private reportFrameSample(key: string, sample: FrameSample): void {
    const entry = this.active.get(key);
    if (!entry) return;
    entry.stopSampling = null;
    if (sample.fps >= DEGRADED_FPS_THRESHOLD || sample.frames === 0) return;
    this.telemetry({
      event: 'animation_performance_degraded',
      key,
      street: entry.event.street,
      boardIndex: entry.event.boardIndex,
      profile: entry.profile.id,
      platform: entry.platform,
      mode: entry.mode,
      durationExpected: entry.expectedMs,
      durationActual: Math.round(sample.elapsedMs),
      reason: `fps=${sample.fps.toFixed(1)} frames=${sample.frames} dropped=${sample.droppedFrames}`,
    });
  }

  private release(entry: ActivePresentation): void {
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = null;
    if (entry.revealTimer) clearTimeout(entry.revealTimer);
    entry.revealTimer = null;
    if (entry.stopSampling) entry.stopSampling();
    entry.stopSampling = null;
    this.active.delete(entry.key);
    const lane = laneKey(entry.event);
    if (this.lanes.get(lane) === entry.key) this.lanes.delete(lane);
  }

  private notify(key: string, phase: CardPresentationPhase, elapsedMs: number): void {
    for (const l of Array.from(this.listeners)) {
      try {
        l({ key, phase, elapsedMs });
      } catch {
        /* a listener's failure is not the board's problem */
      }
    }
  }
}
