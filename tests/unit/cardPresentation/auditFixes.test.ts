/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  AUDIT FIXES 2026-09-05 — the defects an adversarial read found in shipped
 *  code, each pinned by a test that fails against the version that shipped.
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { CardPresentationEngine } from '../../../src/presentation/cardPresentation/CardPresentationEngine';
import { noopFrameSampler } from '../../../src/presentation/cardPresentation/frameSampler';
import {
  CARD_PRESENTATION_PROFILES,
  FLOP_FAN,
  FLOP_FAN_TOTAL_MS,
  MOUNT_WINDOW_MARGIN_MS,
} from '../../../src/presentation/cardPresentation/profiles';
import type {
  CardPresentationTelemetry,
  CommunityCardDealPresentation,
  ResolveProfileInput,
} from '../../../src/presentation/cardPresentation/types';

const ROOT = path.resolve(__dirname, '../../..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const input = (over: Partial<ResolveProfileInput> = {}): ResolveProfileInput => ({
  mode: 'cash',
  platform: 'desktop',
  focus: 'focused',
  reducedMotion: false,
  allIn: false,
  ...over,
});
const ev = (over: Partial<CommunityCardDealPresentation> = {}): CommunityCardDealPresentation => ({
  tableId: 't',
  handId: 1,
  boardIndex: 0,
  street: 'river',
  slotIndex: 4,
  sequence: 5,
  ...over,
});

function build(events: CardPresentationTelemetry[], now = () => 0) {
  return new CardPresentationEngine({
    telemetry: (t) => events.push(t),
    now,
    speed: () => 1,
    frameSampler: noopFrameSampler,
    frameSampleRate: 0,
    maxProcessed: 8,
  });
}

describe('the FLOP reports the animation that actually runs (was: half of it)', () => {
  it('FLOP_FAN is the stylesheet, read back out of it', () => {
    const css = read('src/components/table/CommunityCards.css');
    // land
    expect(css).toContain(
      `ccFlopLand calc(${FLOP_FAN.LAND_MS / 1000}s * var(--animation-speed, 1))`
    );
    // fan open, and its per-card delay
    expect(css).toContain(
      `ccFlopFanOpen calc(${FLOP_FAN.OPEN_MS / 1000}s * var(--animation-speed, 1))`
    );
    expect(css).toContain(
      `calc((${FLOP_FAN.OPEN_DELAY_MS / 1000}s + var(--card-index, 0) * ${FLOP_FAN.OPEN_STAGGER_MS / 1000}s) * var(--animation-speed, 1))`
    );
    // the deal stagger the component writes inline
    expect(read('src/components/table/CommunityCards.tsx')).toContain('FLOP_FAN.DEAL_STAGGER_MS');
    // card index 2 finishes here
    expect(FLOP_FAN_TOTAL_MS).toBe(1220);
  });

  it('a flop is reported as 1220ms, not as the squeeze profile it never runs', () => {
    const events: CardPresentationTelemetry[] = [];
    let now = 0;
    const engine = build(events, () => now);
    vi.useFakeTimers();
    const r = engine.presentCard(ev({ street: 'flop', slotIndex: 2, sequence: 3 }), input());
    expect(r.durationMs).toBe(FLOP_FAN_TOTAL_MS + MOUNT_WINDOW_MARGIN_MS);
    expect(events[0].durationExpected).toBe(FLOP_FAN_TOTAL_MS);
    expect(events[0].durationExpected).not.toBe(CARD_PRESENTATION_PROFILES.cashDesktop.durationMs);
    // and the engine's own timer waits for the fan, not for the squeeze
    now += CARD_PRESENTATION_PROFILES.cashDesktop.durationMs + MOUNT_WINDOW_MARGIN_MS;
    vi.advanceTimersByTime(
      CARD_PRESENTATION_PROFILES.cashDesktop.durationMs + MOUNT_WINDOW_MARGIN_MS
    );
    expect(engine.isActive(r.key), 'the flop is still fanning at 660ms').toBe(true);
    now += FLOP_FAN_TOTAL_MS;
    vi.advanceTimersByTime(FLOP_FAN_TOTAL_MS);
    expect(engine.isActive(r.key)).toBe(false);
    engine.dispose();
    vi.useRealTimers();
  });

  it('a turn or river still reports its own profile', () => {
    const events: CardPresentationTelemetry[] = [];
    const engine = build(events);
    engine.presentCard(ev(), input());
    expect(events[0].durationExpected).toBe(CARD_PRESENTATION_PROFILES.cashDesktop.durationMs);
    engine.dispose();
  });
});

describe('started and completed describe the SAME presentation', () => {
  it('a tournament all-in is a tournament at both ends (was: cash at the end)', () => {
    const events: CardPresentationTelemetry[] = [];
    let now = 0;
    const engine = build(events, () => now);
    vi.useFakeTimers();
    const r = engine.presentCard(ev(), input({ mode: 'tournament', allIn: true }));
    expect(r.profile).toBe(CARD_PRESENTATION_PROFILES.allIn);
    expect(CARD_PRESENTATION_PROFILES.allIn.mode, 'the profile constant says cash').toBe('cash');
    now += r.durationMs;
    vi.advanceTimersByTime(r.durationMs);
    const started = events.find((e) => e.event === 'animation_started')!;
    const done = events.find((e) => e.event === 'animation_completed')!;
    expect(started.mode).toBe('tournament');
    expect(done.mode).toBe('tournament');
    engine.dispose();
    vi.useRealTimers();
  });

  it('a phone on a background table is a phone at both ends (was: desktop at the end)', () => {
    const events: CardPresentationTelemetry[] = [];
    const engine = build(events);
    const r = engine.presentCard(ev(), input({ platform: 'mobile', focus: 'visible' }));
    expect(r.profile).toBe(CARD_PRESENTATION_PROFILES.background);
    engine.cancel(r.key, 'test');
    const started = events.find((e) => e.event === 'animation_started')!;
    const cancelled = events.find((e) => e.event === 'animation_cancelled')!;
    expect(started.platform).toBe('mobile');
    expect(cancelled.platform).toBe('mobile');
    engine.dispose();
  });

  it('a tablet is reported as a tablet, though no profile is one', () => {
    const events: CardPresentationTelemetry[] = [];
    const engine = build(events);
    const r = engine.presentCard(ev(), input({ platform: 'tablet' }));
    expect(r.profile.platform, 'every profile is desktop or mobile').not.toBe('tablet');
    engine.cancel(r.key, 'test');
    expect(events.every((e) => e.platform === 'tablet')).toBe(true);
    engine.dispose();
  });
});

describe('the maps that actually grow are bounded (was: only `processed` was)', () => {
  it('a surface per hand - what the replay does - cannot grow without limit', () => {
    const events: CardPresentationTelemetry[] = [];
    const engine = build(events); // maxProcessed 8
    for (let i = 0; i < 200; i++) {
      engine.presentCard(ev({ tableId: `replay:${i}`, handId: i }), input());
    }
    expect(engine.trackedTableCount).toBeLessThanOrEqual(engine.maxProcessedKeys);
    expect(engine.laneProgressSize).toBeLessThanOrEqual(engine.maxProcessedKeys);
    expect(engine.processedSize).toBeLessThanOrEqual(engine.maxProcessedKeys);
    engine.dispose();
  });

  it('dispose clears every one of them, including the lane progression', () => {
    const engine = build([]);
    engine.presentCard(ev(), input());
    engine.dispose();
    expect(engine.laneProgressSize).toBe(0);
    expect(engine.trackedTableCount).toBe(0);
    expect(engine.processedSize).toBe(0);
    expect(engine.laneCount).toBe(0);
  });

  it('re-presenting a live table refreshes its place in the queue, never duplicates it', () => {
    const engine = build([]);
    engine.presentCard(ev({ handId: 1 }), input());
    engine.presentCard(ev({ handId: 2, street: 'turn', slotIndex: 3, sequence: 4 }), input());
    expect(engine.trackedTableCount).toBe(1);
    engine.dispose();
  });
});

describe('the replay window follows the player animation-speed setting', () => {
  it('the hook scales by getAnimationSpeed, like the felt does', () => {
    const hook = read('src/presentation/cardPresentation/useCardSqueeze.tsx');
    expect(hook).toContain('getAnimationSpeed()');
    expect(hook).toMatch(/Math\.round\(result\.durationMs \* getAnimationSpeed\(\)\)/);
    // and it hears about a cancel, instead of only its own timer
    expect(hook).toContain('cardPresentationEngine.subscribe(');
    expect(hook).toContain("phase !== 'cancelled'");
  });
});

describe('the replay card carries a box of its own', () => {
  it('the wrapper is sized to the card renderer it wraps, not left to collapse', () => {
    const css = read('src/components/replay/HandReplay.css');
    const cardImage = read('src/components/table/CardImage.css');
    const rule = css.slice(
      css.indexOf('.hr-felt__card {'),
      css.indexOf('}', css.indexOf('.hr-felt__card {'))
    );
    expect(rule).toContain('width: var(--hr-card-w)');
    expect(rule).toContain('height: var(--hr-card-h)');
    expect(rule).toContain('flex: none');
    // pinned to the `sm` size class the replay board renders, so they cannot drift
    const sm = cardImage.slice(
      cardImage.indexOf('.card-image--sm {'),
      cardImage.indexOf('}', cardImage.indexOf('.card-image--sm {'))
    );
    const w = /width:\s*(\d+)px/.exec(sm)![1];
    const h = /height:\s*(\d+)px/.exec(sm)![1];
    expect(rule).toContain(`--hr-card-w: ${w}px`);
    expect(rule).toContain(`--hr-card-h: ${h}px`);
  });
});

describe('no dead branch left in the phase machine', () => {
  it('phaseAt has one settle branch, not two identical ones', () => {
    const src = read('src/presentation/cardPresentation/CardPresentationEngine.ts');
    const fn = src.slice(src.indexOf('phaseAt('), src.indexOf('activeViews('));
    expect((fn.match(/return 'settle';/g) || []).length).toBe(1);
  });
});
