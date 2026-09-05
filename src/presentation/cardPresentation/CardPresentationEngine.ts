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
    };
    entry.timer = setTimeout(
      () => this.complete(key),
      Math.ceil(settle + MOUNT_WINDOW_MARGIN_MS * s)
    );
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

  private remember(key: string): void {
    this.processed.set(key, true);
    while (this.processed.size > this.maxProcessed) {
      const oldest = this.processed.keys().next().value;
      if (oldest === undefined) break;
      this.processed.delete(oldest);
    }
  }

  private release(entry: ActivePresentation): void {
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = null;
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
