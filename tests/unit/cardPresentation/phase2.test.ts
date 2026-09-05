/**
 * PHASE 2 2026-09-05 — the interrupts and guards the spec names and nothing
 * implemented: an out-of-order street, a geometry change, a backgrounded tab,
 * asset preloading, and the spectator's own profile.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { CardPresentationEngine } from '../../../src/presentation/cardPresentation/CardPresentationEngine';
import { noopFrameSampler } from '../../../src/presentation/cardPresentation/frameSampler';
import {
  installEnvironmentInterrupts,
  RESIZE_SETTLE_MS,
} from '../../../src/presentation/cardPresentation/environmentInterrupts';
import {
  preloadImage,
  resetPreloadCache,
  preloadCount,
} from '../../../src/presentation/cardPresentation/preload';
import type {
  CardPresentationTelemetry,
  CommunityCardDealPresentation,
  ResolveProfileInput,
} from '../../../src/presentation/cardPresentation/types';

const ROOT = path.resolve(__dirname, '../../..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const focused: ResolveProfileInput = {
  mode: 'cash',
  platform: 'desktop',
  focus: 'focused',
  reducedMotion: false,
  allIn: false,
};
const card = (
  over: Partial<CommunityCardDealPresentation> = {}
): CommunityCardDealPresentation => ({
  tableId: 't',
  handId: 10,
  boardIndex: 0,
  street: 'river',
  slotIndex: 4,
  sequence: 5,
  ...over,
});

describe('a street the board has already passed never animates (spec 16, 84, 103)', () => {
  let engine: CardPresentationEngine;
  let events: CardPresentationTelemetry[];
  beforeEach(() => {
    vi.useFakeTimers();
    events = [];
    engine = new CardPresentationEngine({
      telemetry: (t) => events.push(t),
      now: () => 0,
      speed: () => 1,
      frameSampler: noopFrameSampler,
      frameSampleRate: 0,
    });
  });
  afterEach(() => {
    engine.dispose();
    vi.useRealTimers();
  });

  it('a turn arriving AFTER the river of the same hand is refused', () => {
    expect(engine.presentCard(card(), focused).status).toBe('started');
    const late = engine.presentCard(card({ street: 'turn', slotIndex: 3, sequence: 4 }), focused);
    expect(late.status).toBe('stale');
    expect(events.at(-1)).toMatchObject({ event: 'animation_skipped', reason: 'out-of-order' });
  });

  it('the guard is per BOARD - board 2 is not held back by board 1', () => {
    engine.presentCard(card({ boardIndex: 0 }), focused);
    // board 2 is still on its turn; a different lane entirely
    expect(
      engine.presentCard(
        card({ boardIndex: 1, street: 'turn', slotIndex: 3, sequence: 4 }),
        focused
      ).status
    ).toBe('started');
  });

  it('a NEW hand starts its own progression, so a flop is not "out of order"', () => {
    engine.presentCard(card({ handId: 10 }), focused);
    expect(
      engine.presentCard(card({ handId: 11, street: 'turn', slotIndex: 3, sequence: 4 }), focused)
        .status
    ).toBe('started');
  });

  it('forgetting the table clears its progression too', () => {
    engine.presentCard(card(), focused);
    engine.forgetTable('t');
    expect(
      engine.presentCard(card({ street: 'turn', slotIndex: 3, sequence: 4 }), focused).status
    ).toBe('started');
  });
});

describe('environment interrupts (spec 39, 40, 66, 76, 77)', () => {
  function harness() {
    const listeners = new Map<string, () => void>();
    const cancelled: string[] = [];
    const target = {
      addEventListener: (t: string, f: EventListener) => listeners.set(t, f as () => void),
      removeEventListener: (t: string) => listeners.delete(t),
    } as unknown as Window;
    const docState = { hidden: false };
    const doc = {
      addEventListener: (t: string, f: EventListener) => listeners.set(t, f as () => void),
      removeEventListener: (t: string) => listeners.delete(t),
      get hidden() {
        return docState.hidden;
      },
    } as unknown as Document;
    const engine = { cancelAll: (r: string) => cancelled.push(r) };
    return { listeners, cancelled, target, doc, docState, engine };
  }

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('listens for resize, orientation and visibility, and removes them all', () => {
    const h = harness();
    const off = installEnvironmentInterrupts(h.engine, { target: h.target, doc: h.doc });
    expect([...h.listeners.keys()].sort()).toEqual([
      'orientationchange',
      'resize',
      'visibilitychange',
    ]);
    off();
    expect(h.listeners.size).toBe(0);
  });

  it('a resize cancels immediately AND again once the drag settles', () => {
    const h = harness();
    installEnvironmentInterrupts(h.engine, { target: h.target, doc: h.doc });
    h.listeners.get('resize')!();
    expect(h.cancelled).toEqual(['geometry-changed']);
    // a drag fires dozens; the settle is debounced to one
    h.listeners.get('resize')!();
    h.listeners.get('resize')!();
    vi.advanceTimersByTime(RESIZE_SETTLE_MS + 5);
    expect(h.cancelled).toEqual([
      'geometry-changed',
      'geometry-changed',
      'geometry-changed',
      'geometry-settled',
    ]);
  });

  it('an orientation change is a geometry change', () => {
    const h = harness();
    installEnvironmentInterrupts(h.engine, { target: h.target, doc: h.doc });
    h.listeners.get('orientationchange')!();
    expect(h.cancelled[0]).toBe('geometry-changed');
  });

  it('backgrounding cancels; coming BACK does not (the hand has moved on)', () => {
    const h = harness();
    installEnvironmentInterrupts(h.engine, { target: h.target, doc: h.doc });
    h.docState.hidden = true;
    h.listeners.get('visibilitychange')!();
    expect(h.cancelled).toEqual(['backgrounded']);
    h.docState.hidden = false;
    h.listeners.get('visibilitychange')!();
    expect(h.cancelled).toEqual(['backgrounded']);
  });

  it('uninstalling stops a pending settle from firing later', () => {
    const h = harness();
    const off = installEnvironmentInterrupts(h.engine, { target: h.target, doc: h.doc });
    h.listeners.get('resize')!();
    off();
    vi.advanceTimersByTime(RESIZE_SETTLE_MS * 4);
    expect(h.cancelled).toEqual(['geometry-changed']);
  });

  it('cancelAll really does clear every surface', () => {
    const engine = new CardPresentationEngine({
      now: () => 0,
      speed: () => 1,
      frameSampler: noopFrameSampler,
      frameSampleRate: 0,
    });
    engine.presentCard(card({ tableId: 'a' }), focused);
    engine.presentCard(card({ tableId: 'b' }), focused);
    engine.presentCard(card({ tableId: 'b', boardIndex: 1 }), focused);
    expect(engine.activeCount).toBe(3);
    engine.cancelAll('geometry-changed');
    expect(engine.activeCount).toBe(0);
    expect(engine.laneCount).toBe(0);
    engine.dispose();
  });

  it('is installed once beside the singleton, not per board', () => {
    const singleton = read('src/presentation/cardPresentation/engineSingleton.ts');
    expect(singleton).toContain('installEnvironmentInterrupts(cardPresentationEngine)');
    expect(read('src/components/table/CommunityCards.tsx')).not.toContain(
      'installEnvironmentInterrupts'
    );
  });
});

describe('asset preloading (spec 41, 42)', () => {
  beforeEach(() => resetPreloadCache());

  it('asks for a url once, however many hands use it', () => {
    const made: string[] = [];
    class FakeImage {
      decoding = '';
      set src(v: string) {
        made.push(v);
      }
      decode() {
        return Promise.resolve();
      }
    }
    vi.stubGlobal('Image', FakeImage);
    for (let i = 0; i < 50; i++) preloadImage('/cards/2color/spades_ace.webp');
    expect(made).toEqual(['/cards/2color/spades_ace.webp']);
    expect(preloadCount()).toBe(1);
    vi.unstubAllGlobals();
  });

  it('ignores an empty url and survives a decode that rejects', async () => {
    const made: string[] = [];
    class FakeImage {
      decoding = '';
      set src(v: string) {
        made.push(v);
      }
      decode() {
        return Promise.reject(new Error('404'));
      }
    }
    vi.stubGlobal('Image', FakeImage);
    preloadImage(null);
    preloadImage(undefined);
    preloadImage('');
    expect(made).toEqual([]);
    expect(() => preloadImage('/cards/2color/hearts_two.webp')).not.toThrow();
    await Promise.resolve();
    vi.unstubAllGlobals();
  });

  it('the board decodes every newly dealt face, and the back, when a reveal starts', () => {
    const tsx = read('src/components/table/CommunityCards.tsx');
    // every card the street just added - three of them on a flop
    expect(tsx).toContain('preloadImage(getCardImagePath(cards[i], deckStyle))');
    expect(tsx).toContain('for (let i = prevCount; i < visibleCount; i++)');
    expect(tsx).toContain('preloadImage(cardBackImageUrl(cardBack))');
    // fire and forget - nothing awaits it
    expect(tsx).not.toMatch(/await\s+preloadImage/);
  });
});

describe('the spectator profile is wired from the felt (spec 36, 94, 115)', () => {
  const tablePage = read('src/pages/TablePage.tsx');

  it('an unseated viewer resolves the spectator profile', () => {
    expect(tablePage).toContain("'spectator';");
    expect(tablePage).toContain('const boardPresentationMode: CardPresentationMode =');
    expect(tablePage).toContain('tableState.heroSeat > 0');
  });

  it('every board on the felt uses the one derived mode', () => {
    const uses = tablePage.match(/gameMode=\{boardPresentationMode\}/g) || [];
    expect(uses.length).toBe(4);
    expect(tablePage).not.toContain("gameMode={tableState.isTournament ? 'tournament' : 'cash'}");
  });

  it('the presentation layer learns a MODE NAME and nothing else (spec 28, 115)', () => {
    const dir = path.join(ROOT, 'src/presentation/cardPresentation');
    for (const f of fs.readdirSync(dir)) {
      if (!/\.tsx?$/.test(f)) continue;
      const src = read(path.join('src/presentation/cardPresentation', f));
      expect(src, f).not.toMatch(/payout|blindLevel|blind_level|wallet|chipBalance|rake/i);
    }
  });
});

describe('the flop runs through the engine too (spec 58)', () => {
  const tsx = read('src/components/table/CommunityCards.tsx');

  it('every street is presented, not only the ones that squeeze', () => {
    // The `if (squeezes)` gate around presentCard is gone: the flop asks the
    // engine as well, and only the ANSWER differs by street.
    expect(tsx).toContain("const squeezes = street === 'river' || street === 'turn';");
    expect(tsx).not.toMatch(/const squeezes =[\s\S]{0,80}\n\s*if \(squeezes\) \{\n\s*const slot/);
    expect(tsx).toContain('cardPresentationEngine.presentCard(');
  });

  it('a refused FLOP renders all three cards statically, not just one', () => {
    // newIndices.delete(slot) would leave two of the three still animating.
    expect(tsx).toContain('newIndices.clear();');
  });

  it('but the flop keeps its own fan markup and its own three snaps', () => {
    // it never mounts the squeeze card...
    expect(tsx).toContain('isFlopDeal ? (');
    expect(tsx).toContain('community-cards__card--flop-deal');
    // ...and its sound stays on the street, because the fan opens at 0.52s,
    // 0.66s and 0.80s - a single reveal beat does not describe that shape.
    expect(tsx).toMatch(/stage === 'flop'[\s\S]{0,400}playCommunityCard\(\)/);
    expect(tsx).toContain("stage === 'turn' || stage === 'river'");
  });
});
