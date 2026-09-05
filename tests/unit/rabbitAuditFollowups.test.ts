/**
 * THE 2026-09-05 ADVERSARIAL AUDIT, PINNED
 *
 * Four defects the audit of the merged Rabbit Hunt / mobile work turned up.
 * Each test is written so it FAILS on the pre-fix code, because a regression
 * pin that passes either way is decoration.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { CardPresentationEngine } from '../../src/presentation/cardPresentation/CardPresentationEngine';
import { CARD_PRESENTATION_PROFILES } from '../../src/presentation/cardPresentation/profiles';
import { HAND_COMPLETION } from '../../src/config/handCompletionSpec';
import { DEFAULT_USER_TABLE_SETTINGS } from '../../src/hooks/useUserTableSettings';
import type {
  CommunityCardDealPresentation,
  ResolveProfileInput,
} from '../../src/presentation/cardPresentation/types';

const read = (p: string) => readFileSync(resolve(__dirname, '../../', p), 'utf8');

describe('a setting that does not cross devices is not saved (Dan 2026-08-28)', () => {
  it('EVERY user table setting is on the relay allowlist, not just the ones someone remembered', () => {
    // PostgresSyncHooks forwards only the columns named in its array, so a new
    // column arrives nowhere and cross-device silently does not work. Adding
    // the one missing key would fix today and leave the trap armed for the
    // next agent, so this asserts the WHOLE set instead.
    const SYNC = read('src/services/PostgresSyncHooks.ts');
    const allowlist = SYNC.slice(
      SYNC.indexOf('USER_TABLE_SETTING_COLUMNS'),
      SYNC.indexOf('];', SYNC.indexOf('USER_TABLE_SETTING_COLUMNS'))
    );
    for (const key of Object.keys(DEFAULT_USER_TABLE_SETTINGS)) {
      expect(allowlist, `${key} is saved but never relayed to another device`).toContain(
        `'${key}'`
      );
    }
  });
});

describe('a server-paced reveal never runs slower than the stopwatch', () => {
  let now = 0;
  const river: CommunityCardDealPresentation = {
    tableId: 't1',
    handId: 7,
    boardIndex: 0,
    street: 'river',
    slotIndex: 4,
    sequence: 5,
  };
  const allInInput: ResolveProfileInput = {
    mode: 'cash',
    platform: 'desktop',
    focus: 'focused',
    reducedMotion: false,
    allIn: true,
  };

  beforeEach(() => {
    vi.useFakeTimers();
    now = 1000;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const engineAt = (speed: number) =>
    new CardPresentationEngine({ telemetry: () => {}, now: () => now, speed: () => speed });

  it('the all-in card is face up before the equity gate opens, even on Slow', () => {
    // Dan 2026-08-28: "EQUITY CHANGES ONLY AFTER THE FLOP IS DISPLAYED, (NOT
    // BEFORE OR DURING)". The engine opens that gate a fixed
    // ALL_IN_STREET_REVEAL_MS after sending the street and cannot know this
    // client's animation speed, so the turn must be OVER by then at any speed.
    //
    // Asked of the engine's own phase clock rather than of durationMs, which
    // carries a deliberate 100ms mount margin on top of the animation: the
    // markup outliving the turn by a frame is fine, the TURN outliving the
    // gate is the spoiler.
    for (const speed of [0.5, 1, 1.5, 3]) {
      const e = engineAt(speed);
      const started = now;
      const r = e.presentCard(river, allInInput);
      expect(r.status).toBe('started');
      now = started + HAND_COMPLETION.ALL_IN_STREET_REVEAL_MS;
      expect(
        e.phaseAt(r.key),
        `at animation speed ${speed} the card must be face up when equity moves`
      ).toMatch(/^(settle|complete)$/);
      e.dispose();
    }
  });

  it('marks the all-in profile, and ONLY the all-in profile, as server paced', () => {
    const paced = Object.entries(CARD_PRESENTATION_PROFILES)
      .filter(([, p]) => p.serverPaced)
      .map(([k]) => k);
    expect(paced).toEqual(['allIn']);
  });

  it('clamps the PIXELS too, not just the JS window', () => {
    // One clamp on each side, or neither is a clamp: the CSS multiplies the
    // same --animation-speed, so an unclamped stylesheet would still be
    // turning the card after the engine had unmounted it.
    const SRC = read('src/presentation/cardPresentation/SqueezeCard.tsx');
    expect(SRC).toMatch(
      /serverPaced\s*\?\s*\{\s*'--animation-speed':\s*'min\(1, var\(--animation-speed, 1\)\)'/
    );
  });
});

describe('reduced motion collapses the motion, not the duration (10.6)', () => {
  it('the squeeze host is exempt from the global 1ms crusher', () => {
    // src/styles/reducedMotion.css sets animation-duration:1ms !important on
    // everything that is not [data-motion='keep'] or inside one, at a higher
    // specificity than the stylesheet's own rule. Without the attribute the
    // cross-fade finished instantly while the ENGINE held the markup mounted
    // for the reduced profile's full window.
    const SRC = read('src/presentation/cardPresentation/SqueezeCard.tsx');
    expect(SRC).toMatch(/'data-motion':\s*'keep'/);
    const GLOBAL = read('src/styles/reducedMotion.css');
    expect(GLOBAL, 'the exemption this relies on').toContain("[data-motion='keep']");
  });
});
