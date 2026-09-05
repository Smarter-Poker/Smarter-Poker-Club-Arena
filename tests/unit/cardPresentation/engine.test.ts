/**
 * RIVER SQUEEZE 2026-09-04 — the CardPresentationEngine, unit-tested with a
 * controlled clock (spec 105): keys, duplicate suppression, stale hands, lane
 * pre-emption, cancellation, phases and cleanup. No DOM, no React.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CardPresentationEngine } from '../../../src/presentation/cardPresentation/CardPresentationEngine';
import {
  buildAnimationKey,
  laneKey,
  isOlderHand,
} from '../../../src/presentation/cardPresentation/animationKey';
import {
  CARD_PRESENTATION_PROFILES,
  MOUNT_WINDOW_MARGIN_MS,
} from '../../../src/presentation/cardPresentation/profiles';
import { noopFrameSampler } from '../../../src/presentation/cardPresentation/frameSampler';
import type {
  CardPresentationTelemetry,
  CommunityCardDealPresentation,
  ResolveProfileInput,
} from '../../../src/presentation/cardPresentation/types';

const river = (
  over: Partial<CommunityCardDealPresentation> = {}
): CommunityCardDealPresentation => ({
  tableId: 't1',
  handId: 100,
  boardIndex: 0,
  street: 'river',
  slotIndex: 4,
  sequence: 5,
  ...over,
});

const focused: ResolveProfileInput = {
  mode: 'cash',
  platform: 'desktop',
  focus: 'focused',
  reducedMotion: false,
  allIn: false,
};

describe('animation key', () => {
  it('names table, hand, board, street and slot', () => {
    expect(buildAnimationKey(river())).toBe('table:t1/hand:100/board:0/street:river/slot:4');
  });
  it('differs across hand, board and street', () => {
    const base = buildAnimationKey(river());
    expect(buildAnimationKey(river({ handId: 101 }))).not.toBe(base);
    expect(buildAnimationKey(river({ boardIndex: 1 }))).not.toBe(base);
    expect(buildAnimationKey(river({ street: 'turn', slotIndex: 3 }))).not.toBe(base);
  });
  it('lanes are per table per board', () => {
    expect(laneKey(river())).toBe('table:t1/board:0');
    expect(laneKey(river({ boardIndex: 2 }))).toBe('table:t1/board:2');
  });
  it('compares numeric hands, never guesses about strings', () => {
    expect(isOlderHand(99, 100)).toBe(true);
    expect(isOlderHand('99', 100)).toBe(true);
    expect(isOlderHand(100, 100)).toBe(false);
    expect(isOlderHand('abc', 'abd')).toBe(false);
  });
});

describe('CardPresentationEngine', () => {
  let now = 0;
  let events: CardPresentationTelemetry[];
  let engine: CardPresentationEngine;

  beforeEach(() => {
    vi.useFakeTimers();
    now = 1000;
    events = [];
    engine = new CardPresentationEngine({
      telemetry: (t) => events.push(t),
      now: () => now,
      speed: () => 1,
      maxProcessed: 4,
    });
  });
  afterEach(() => {
    engine.dispose();
    vi.useRealTimers();
  });

  it('starts a river with the resolved profile and a mount window past the CSS total', () => {
    const r = engine.presentCard(river(), focused);
    expect(r.status).toBe('started');
    expect(r.profile).toBe(CARD_PRESENTATION_PROFILES.cashDesktop);
    expect(r.durationMs).toBe(
      CARD_PRESENTATION_PROFILES.cashDesktop.durationMs + MOUNT_WINDOW_MARGIN_MS
    );
    expect(engine.isActive(r.key)).toBe(true);
    expect(events.map((e) => e.event)).toEqual(['animation_started']);
  });

  it('a duplicate event never animates twice (spec 15)', () => {
    const first = engine.presentCard(river(), focused);
    const second = engine.presentCard(river(), focused);
    expect(second.status).toBe('duplicate');
    expect(second.key).toBe(first.key);
    expect(engine.activeCount).toBe(1);
    expect(events.at(-1)?.event).toBe('animation_duplicate_ignored');
  });

  it('a river from an older hand is stale once a newer hand was seen (spec 16, 31)', () => {
    engine.presentCard(river({ handId: 101 }), focused);
    const late = engine.presentCard(river({ handId: 100 }), focused);
    expect(late.status).toBe('stale');
    expect(events.at(-1)).toMatchObject({ event: 'animation_skipped', reason: 'stale-hand' });
    // and it is remembered, so it cannot sneak in later either
    expect(engine.presentCard(river({ handId: 100 }), focused).status).toBe('duplicate');
  });

  it('a hidden table renders instantly - nothing is scheduled', () => {
    const r = engine.presentCard(river(), { ...focused, focus: 'hidden' });
    expect(r.status).toBe('instant');
    expect(r.durationMs).toBe(0);
    expect(engine.activeCount).toBe(0);
    expect(events.at(-1)).toMatchObject({ event: 'animation_skipped', reason: 'off' });
  });

  it('a newer card on the same lane pre-empts the older one (spec 102)', () => {
    const turn = engine.presentCard(river({ street: 'turn', slotIndex: 3, sequence: 4 }), {
      ...focused,
      allIn: true,
    });
    const riv = engine.presentCard(river(), { ...focused, allIn: true });
    expect(engine.isActive(turn.key)).toBe(false);
    expect(engine.isActive(riv.key)).toBe(true);
    expect(events.find((e) => e.event === 'animation_cancelled')).toMatchObject({
      key: turn.key,
      reason: 'superseded',
    });
  });

  it('two boards of one hand are independent lanes (spec 32)', () => {
    const a = engine.presentCard(river({ boardIndex: 0 }), focused);
    const b = engine.presentCard(river({ boardIndex: 1 }), focused);
    expect(engine.isActive(a.key)).toBe(true);
    expect(engine.isActive(b.key)).toBe(true);
  });

  it('completes on its own clock and reports the actual duration', () => {
    const r = engine.presentCard(river(), focused);
    const total = CARD_PRESENTATION_PROFILES.cashDesktop.durationMs + MOUNT_WINDOW_MARGIN_MS;
    now += total;
    vi.advanceTimersByTime(total);
    expect(engine.isActive(r.key)).toBe(false);
    expect(events.at(-1)).toMatchObject({
      event: 'animation_completed',
      durationExpected: CARD_PRESENTATION_PROFILES.cashDesktop.durationMs,
      durationActual: total,
    });
  });

  it('scales its own timer by the animation speed, like the CSS does', () => {
    const slow = new CardPresentationEngine({ now: () => now, speed: () => 2 });
    const r = slow.presentCard(river(), focused);
    const base = CARD_PRESENTATION_PROFILES.cashDesktop.durationMs + MOUNT_WINDOW_MARGIN_MS;
    vi.advanceTimersByTime(base);
    expect(slow.isActive(r.key)).toBe(true);
    vi.advanceTimersByTime(base);
    expect(slow.isActive(r.key)).toBe(false);
    slow.dispose();
  });

  it('phases follow the monotonic clock, not five timers (spec 13, 104)', () => {
    const p = CARD_PRESENTATION_PROFILES.allIn;
    const r = engine.presentCard(river(), { ...focused, allIn: true });
    expect(engine.phaseAt(r.key, now)).toBe('prepare');
    expect(engine.phaseAt(r.key, now + p.prepareMs)).toBe('hold');
    expect(engine.phaseAt(r.key, now + p.prepareMs + p.holdMs)).toBe('squeeze');
    expect(engine.phaseAt(r.key, now + p.prepareMs + p.holdMs + p.squeezeMs)).toBe('reveal');
    expect(engine.phaseAt(r.key, now + p.prepareMs + p.holdMs + p.squeezeMs + p.revealMs)).toBe(
      'settle'
    );
    expect(engine.phaseAt('never', now)).toBe('idle');
  });

  it('cancel clears the timer, the lane, and reports why (spec 66, 99)', () => {
    const r = engine.presentCard(river(), focused);
    engine.cancel(r.key, 'new-hand');
    expect(engine.isActive(r.key)).toBe(false);
    expect(engine.activeCount).toBe(0);
    expect(events.at(-1)).toMatchObject({ event: 'animation_cancelled', reason: 'new-hand' });
    vi.advanceTimersByTime(10_000);
    expect(events.filter((e) => e.event === 'animation_completed')).toHaveLength(0);
    // still a duplicate afterwards: a cancelled river does not replay
    expect(engine.presentCard(river(), focused).status).toBe('duplicate');
  });

  it('cancelTable interrupts every board of that table and nothing else', () => {
    engine.presentCard(river({ boardIndex: 0 }), focused);
    engine.presentCard(river({ boardIndex: 1 }), focused);
    const other = engine.presentCard(river({ tableId: 't2' }), focused);
    engine.cancelTable('t1', 'reconnect');
    expect(engine.activeCount).toBe(1);
    expect(engine.isActive(other.key)).toBe(true);
  });

  it('notifies listeners and survives a listener that throws', () => {
    const seen: string[] = [];
    engine.subscribe(() => {
      throw new Error('boom');
    });
    const off = engine.subscribe((c) => seen.push(c.phase));
    const r = engine.presentCard(river(), focused);
    engine.cancel(r.key, 'x');
    expect(seen).toEqual(['prepare', 'cancelled']);
    off();
    engine.presentCard(river({ handId: 200 }), focused);
    expect(seen).toEqual(['prepare', 'cancelled']);
  });

  it('the duplicate registry is bounded (spec 15, 99)', () => {
    for (let h = 1; h <= 6; h++) engine.presentCard(river({ handId: h }), focused);
    // maxProcessed 4: hand 1 was evicted, but it is STALE now, so still no replay
    expect(engine.presentCard(river({ handId: 1 }), focused).status).toBe('stale');
  });

  it('forgetTable lets the same table start clean in a new session', () => {
    engine.presentCard(river(), focused);
    engine.forgetTable('t1');
    expect(engine.activeCount).toBe(0);
    expect(engine.presentCard(river(), focused).status).toBe('started');
  });

  it('dispose cancels everything and drops every listener (spec 100)', () => {
    const l = vi.fn();
    engine.subscribe(l);
    engine.presentCard(river(), focused);
    engine.dispose();
    expect(engine.activeCount).toBe(0);
    l.mockClear();
    engine.presentCard(river({ handId: 300 }), focused);
    expect(l).not.toHaveBeenCalled();
  });
});

describe('the reveal beat and the frame sampler (ROUND 2)', () => {
  let now = 0;
  let events: CardPresentationTelemetry[];

  const build = (over: Record<string, unknown> = {}) =>
    new CardPresentationEngine({
      telemetry: (t) => events.push(t),
      now: () => now,
      speed: () => 1,
      frameSampler: noopFrameSampler,
      frameSampleRate: 0,
      ...over,
    });

  beforeEach(() => {
    vi.useFakeTimers();
    now = 0;
    events = [];
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('notifies `reveal` at the edge-on instant, not at the street', () => {
    const engine = build();
    const seen: Array<{ phase: string; at: number }> = [];
    engine.subscribe((c) => seen.push({ phase: c.phase, at: now }));
    const p = CARD_PRESENTATION_PROFILES.allIn;
    const r = engine.presentCard(river(), { ...focused, allIn: true });
    expect(seen.map((s) => s.phase)).toEqual(['prepare']);

    // Still face down through prepare + hold: no reveal yet.
    now += p.prepareMs + p.holdMs;
    vi.advanceTimersByTime(p.prepareMs + p.holdMs);
    expect(seen.some((s) => s.phase === 'reveal')).toBe(false);

    // The surfaces swap at the END of the squeeze beat.
    now += p.squeezeMs;
    vi.advanceTimersByTime(p.squeezeMs);
    const reveal = seen.find((s) => s.phase === 'reveal');
    expect(reveal, 'the face appears and says so').toBeTruthy();
    expect(reveal!.at).toBe(p.prepareMs + p.holdMs + p.squeezeMs);
    expect(engine.isActive(r.key)).toBe(true);
    engine.dispose();
  });

  it('a cancelled presentation never fires its reveal beat', () => {
    const engine = build();
    const seen: string[] = [];
    engine.subscribe((c) => seen.push(c.phase));
    const r = engine.presentCard(river(), focused);
    engine.cancel(r.key, 'new-hand');
    vi.advanceTimersByTime(10_000);
    expect(seen).toEqual(['prepare', 'cancelled']);
    engine.dispose();
  });

  it('samples frames only as often as it is told to', () => {
    const starts: number[] = [];
    const sampler = (durationMs: number) => {
      starts.push(durationMs);
      return () => {};
    };
    const never = build({ frameSampler: sampler, frameSampleRate: 0, random: () => 0.5 });
    never.presentCard(river(), focused);
    expect(starts).toHaveLength(0);
    never.dispose();

    starts.length = 0;
    const always = build({ frameSampler: sampler, frameSampleRate: 1, random: () => 0 });
    always.presentCard(river({ handId: 999 }), focused);
    expect(starts).toHaveLength(1);
    // it samples the whole visible presentation, not just the flip
    expect(starts[0]).toBe(CARD_PRESENTATION_PROFILES.cashDesktop.durationMs);
    always.dispose();
  });

  it('reports a stuttering flip once, with the measured rate', () => {
    let report:
      | ((s: { frames: number; fps: number; elapsedMs: number; droppedFrames: number }) => void)
      | null = null;
    const engine = build({
      frameSampler: (_d: number, done: (s: never) => void) => {
        report = done as never;
        return () => {};
      },
      frameSampleRate: 1,
      random: () => 0,
    });
    engine.presentCard(river(), focused);
    report!({ frames: 12, fps: 21.4, elapsedMs: 560, droppedFrames: 22 });
    const degraded = events.find((e) => e.event === 'animation_performance_degraded');
    expect(degraded).toBeTruthy();
    expect(degraded!.reason).toContain('fps=21.4');
    expect(degraded!.durationActual).toBe(560);
    engine.dispose();
  });

  it('a flip that held its frame rate reports nothing', () => {
    let report: ((s: never) => void) | null = null;
    const engine = build({
      frameSampler: (_d: number, done: (s: never) => void) => {
        report = done;
        return () => {};
      },
      frameSampleRate: 1,
      random: () => 0,
    });
    engine.presentCard(river(), focused);
    report!({ frames: 34, fps: 60.7, elapsedMs: 560, droppedFrames: 0 } as never);
    expect(events.some((e) => e.event === 'animation_performance_degraded')).toBe(false);
    engine.dispose();
  });

  it('cancelling stops the sampler too (spec 99)', () => {
    let stopped = false;
    const engine = build({
      frameSampler: () => () => {
        stopped = true;
      },
      frameSampleRate: 1,
      random: () => 0,
    });
    const r = engine.presentCard(river(), focused);
    engine.cancel(r.key, 'hidden');
    expect(stopped).toBe(true);
    engine.dispose();
  });
});
