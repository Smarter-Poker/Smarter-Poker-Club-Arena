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
import { MOUNT_WINDOW_MARGIN_MS } from './profiles';
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
      durationExpected: profile.durationMs,
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
    this.latestHand.set(event.tableId, event.handId);
    this.remember(key);

    if (profile.intensity === 'off' || profile.durationMs <= 0) {
      this.telemetry({ ...base, event: 'animation_skipped', reason: profile.id });
      return { status: 'instant', key, profile, durationMs: 0 };
    }

    // One presentation per lane: a newer card on the same board pre-empts an
    // older one still mid-flight, and that one renders its final state.
    const lane = laneKey(event);
    const previous = this.lanes.get(lane);
    if (previous && previous !== key) this.cancel(previous, 'superseded');

    const s = this.speed();
    const startedAt = this.now();
    const prepare = profile.prepareMs * s;
    const hold = prepare + profile.holdMs * s;
    const squeeze = hold + profile.squeezeMs * s;
    const reveal = squeeze + profile.revealMs * s;
    const settle = reveal + profile.settleMs * s;
    const entry: ActivePresentation = {
      key,
      event,
      profile,
      startedAt,
      ends: { prepare, hold, squeeze, reveal, settle },
      timer: null,
      revealTimer: null,
      stopSampling: null,
    };
    entry.timer = setTimeout(
      () => this.complete(key),
      Math.ceil(settle + MOUNT_WINDOW_MARGIN_MS * s)
    );
    // The face appears at the edge-on instant, which is the END of the
    // squeeze beat. Listeners (the board's sound cue) hang off this.
    entry.revealTimer = setTimeout(() => {
      const live = this.active.get(key);
      if (!live) return;
      live.revealTimer = null;
      this.notify(key, 'reveal', this.now() - live.startedAt);
    }, Math.ceil(squeeze));
    if (this.random() < this.frameSampleRate) {
      entry.stopSampling = this.frameSampler(settle, (sample) =>
        this.reportFrameSample(key, sample)
      );
    }
    this.active.set(key, entry);
    this.lanes.set(lane, key);
    this.telemetry({ ...base, event: 'animation_started' });
    this.notify(key, 'prepare', 0);

    return {
      status: 'started',
      key,
      profile,
      durationMs: profile.durationMs + MOUNT_WINDOW_MARGIN_MS,
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
      platform: entry.profile.platform,
      mode: entry.profile.mode,
      durationExpected: entry.profile.durationMs,
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
      platform: entry.profile.platform,
      mode: entry.profile.mode,
      durationExpected: entry.profile.durationMs,
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
    if (t < e.settle) return 'settle';
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
  }

  /** Cancel everything and drop every listener (spec 99, 100). */
  dispose(): void {
    for (const entry of Array.from(this.active.values())) this.cancel(entry.key, 'disposed');
    this.listeners.clear();
    this.lanes.clear();
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

  private remember(key: string): void {
    this.processed.set(key, true);
    while (this.processed.size > this.maxProcessed) {
      const oldest = this.processed.keys().next().value;
      if (oldest === undefined) break;
      this.processed.delete(oldest);
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
      platform: entry.profile.platform,
      mode: entry.profile.mode,
      durationExpected: entry.profile.durationMs,
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
