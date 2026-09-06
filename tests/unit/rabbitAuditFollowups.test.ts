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
import { ALL_IN_SQUEEZE_CEILING_MS } from '../../src/config/handCompletionSpec';
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
    squeeze: true,
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

  it('the all-in card is face up before the next street can land, even on Slow', () => {
    // Dan 2026-08-28: "EQUITY CHANGES ONLY AFTER THE FLOP IS DISPLAYED, (NOT
    // BEFORE OR DURING)". The engine paces the run-out on a fixed wall clock
    // and cannot know this client's animation speed.
    //
    // VIP ALL-IN SQUEEZE 2026-09-05: the stopwatch this profile answers to
    // moved. The card is now the PLAYER'S to open and may legitimately still
    // be face down when the equity gate opens (the page holds the displayed
    // equity for that viewer - tests/unit/vipAllInSqueeze.test.ts). What must
    // still be true at every speed is that the snap is OVER by the ceiling,
    // which is sized so the next street or the pot never lands on a card
    // still turning.
    //
    // Asked of the engine's own phase clock rather than of durationMs, which
    // carries a deliberate 100ms mount margin on top of the animation.
    for (const speed of [0.5, 1, 1.5, 3]) {
      const e = engineAt(speed);
      const started = now;
      const r = e.presentCard(river, allInInput);
      expect(r.status).toBe('started');
      now = started + ALL_IN_SQUEEZE_CEILING_MS;
      expect(
        e.phaseAt(r.key),
        `at animation speed ${speed} the card must be face up by the ceiling`
      ).toMatch(/^(settle|complete)$/);
      e.dispose();
    }
  });

  it('marks the all-in profiles, and ONLY those, as server paced', () => {
    /* 2026-09-05: `allInReduced` joined it - the same beats and the same
       server-paced ceiling for a viewer with Reduce Motion on, who used to be
       handed `reduced` (no hold at all) and therefore had nothing to squeeze.
       Both are paced by the engine; nothing else is. */
    const paced = Object.entries(CARD_PRESENTATION_PROFILES)
      .filter(([, p]) => p.serverPaced)
      .map(([k]) => k);
    expect(paced).toEqual(['allIn', 'allInReduced']);
  });

  it('clamps the PIXELS too, not just the JS window', () => {
    // One clamp on each side, or neither is a clamp: the CSS multiplies the
    // same --animation-speed, so an unclamped stylesheet would still be
    // turning the card after the engine had unmounted it.
    const SRC = read('src/presentation/cardPresentation/SqueezeCard.tsx');
    /* IT WRITES --rs-speed, NOT --animation-speed (fixed 2026-09-05). The old
       form redefined --animation-speed in terms of ITSELF, which is a
       self-reference and therefore invalid at computed-value time: measured
       in Chromium the property computed to the empty string on the host and
       every descendant, so every duration fell back to speed 1 and this clamp
       never ran at all. A separate property reads the player's speed without
       being it, so there is no cycle. */
    expect(SRC).toMatch(
      /serverPaced\s*\?\s*\{\s*'--rs-speed':\s*'min\(1, var\(--animation-speed, 1\)\)'/
    );
    expect(SRC, 'never self-referential again').not.toContain(
      "'--animation-speed': 'min(1, var(--animation-speed, 1))'"
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
