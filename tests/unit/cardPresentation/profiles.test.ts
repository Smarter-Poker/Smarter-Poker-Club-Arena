/**
 * RIVER SQUEEZE 2026-09-04 — profiles, the resolver, and the ONE bridge to
 * the stylesheet. These pins are what let the numbers live in exactly one
 * place: if a profile and the CSS defaults or keyframe split ever disagree,
 * this file goes red before a player sees a torn flip.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  CARD_PRESENTATION_PROFILES,
  SQUEEZE_KEYFRAME_SPLIT,
  flipMs,
} from '../../../src/presentation/cardPresentation/profiles';
import {
  resolveCardAnimationProfile,
  detectPlatform,
  MOBILE_MAX_WIDTH_PX,
  TABLET_MAX_WIDTH_PX,
} from '../../../src/presentation/cardPresentation/resolveProfile';
import { HAND_COMPLETION } from '../../../src/config/handCompletionSpec';
import type { CardAnimationProfile } from '../../../src/presentation/cardPresentation/types';

const ROOT = path.resolve(__dirname, '../../..');
// ROUND 2 2026-09-05: the squeeze moved out of the board's stylesheet into
// the presentation layer, so the replay can squeeze without loading the felt.
const css = fs.readFileSync(
  path.join(ROOT, 'src/presentation/cardPresentation/cardSqueeze.css'),
  'utf8'
);
const P = CARD_PRESENTATION_PROFILES;
const all = Object.values(P) as CardAnimationProfile[];

describe('profile table', () => {
  it('every profile is frozen and its total is the sum of its five beats', () => {
    for (const p of all) {
      expect(Object.isFrozen(p)).toBe(true);
      expect(p.durationMs).toBe(p.prepareMs + p.holdMs + p.squeezeMs + p.revealMs + p.settleMs);
    }
    expect(Object.isFrozen(P)).toBe(true);
  });

  it('the spectator profile is cash-shaped but separately identified', () => {
    const { id: _s, mode: _sm, ...spectator } = P.spectatorDesktop;
    const { id: _c, mode: _cm, ...cash } = P.cashDesktop;
    expect(spectator).toEqual(cash);
    expect(P.spectatorDesktop.id).not.toBe(P.cashDesktop.id);
    expect(P.spectatorDesktop.mode).toBe('spectator');
  });

  it('matches the spec starting values (spec 8, 118)', () => {
    expect(P.cashDesktop.durationMs).toBe(560);
    expect(P.tournamentDesktop.durationMs).toBe(640);
    expect(P.lightningDesktop.durationMs).toBe(420);
    expect(P.mobile.durationMs).toBe(360);
    expect(P.reduced).toMatchObject({ prepareMs: 0, squeezeMs: 80, revealMs: 40, settleMs: 0 });
    expect(P.background.durationMs).toBeGreaterThanOrEqual(250);
    expect(P.background.durationMs).toBeLessThanOrEqual(350);
    expect(P.off.durationMs).toBe(0);
  });

  it('the all-in profile is sized from the server reveal gate, not hand-tuned', () => {
    expect(P.allIn.durationMs).toBe(HAND_COMPLETION.ALL_IN_STREET_REVEAL_MS);
    expect(P.allIn.holdMs).toBeGreaterThan(P.allIn.squeezeMs);
  });

  it('the overshoot stays subtle (spec 20) and the reduced/background ones have none', () => {
    for (const p of all) {
      expect(p.overshoot).toBeGreaterThanOrEqual(1);
      expect(p.overshoot).toBeLessThanOrEqual(1.04);
    }
    expect(P.reduced.overshoot).toBe(1);
    expect(P.background.overshoot).toBe(1);
    expect(P.reduced.threeD).toBe(false);
    expect(P.reduced.lightSweepEnabled).toBe(false);
  });

  it('the second board never lags enough to change perception (spec 33)', () => {
    for (const p of all) expect(p.staggerMs).toBeLessThanOrEqual(80);
    expect(P.lightningDesktop.staggerMs).toBe(35);
    expect(P.cashDesktop.staggerMs).toBe(60);
  });
});

describe('the one bridge to the stylesheet', () => {
  it(':root defaults are the desktop-cash profile', () => {
    const root = css.slice(css.indexOf(':root {'), css.indexOf('}', css.indexOf(':root {')));
    expect(root).toContain(`--rs-prepare: ${P.cashDesktop.prepareMs / 1000}s;`);
    expect(root).toContain(`--rs-hold: ${P.cashDesktop.holdMs}s;`);
    expect(root).toContain(`--rs-flip: ${flipMs(P.cashDesktop) / 1000}s;`);
    expect(root).toContain(`--rs-overshoot: ${P.cashDesktop.overshoot};`);
  });

  it('every three-beat flip fits the fixed keyframe split within tolerance', () => {
    // The CSS keyframe percentages are fixed; a profile whose beats are far
    // off that split would show the face early or late.
    for (const p of all) {
      const total = flipMs(p);
      // The reduced profile never reaches the keyframe: the global
      // reduced-motion rule collapses it to 1ms and the resting state is
      // face up. Its beats only size the JS window.
      if (total === 0 || !p.threeD) continue;
      const squeezeEnd = p.squeezeMs / total;
      const revealEnd = (p.squeezeMs + p.revealMs) / total;
      expect(Math.abs(squeezeEnd - SQUEEZE_KEYFRAME_SPLIT.SQUEEZE_END)).toBeLessThan(0.08);
      expect(Math.abs(revealEnd - SQUEEZE_KEYFRAME_SPLIT.REVEAL_END)).toBeLessThan(0.1);
    }
  });

  it('the keyframe carries exactly that split', () => {
    const kf = css.slice(css.indexOf('@keyframes ccCardSqueeze'));
    const body = kf.slice(0, kf.indexOf('\n}\n') + 3);
    expect(body).toContain(`${SQUEEZE_KEYFRAME_SPLIT.SQUEEZE_END * 100}% {`);
    expect(body).toContain(`${SQUEEZE_KEYFRAME_SPLIT.REVEAL_END * 100}% {`);
    expect(body).toContain(`${SQUEEZE_KEYFRAME_SPLIT.OVERSHOOT_PEAK * 100}% {`);
    expect(body).toMatch(/37\.5% \{\s*transform: rotateY\(90deg\)/);
    expect(body).toMatch(/75% \{\s*transform: rotateY\(180deg\) scale\(1\)/);
    expect(body).toContain('scale(var(--rs-overshoot, 1.03))');
    // scaleY is never touched (spec 108, 109): only rotateY and uniform scale
    expect(body).not.toMatch(/scaleY|scaleX/);
  });
});

describe('resolver priority (spec 46)', () => {
  const base = {
    mode: 'cash' as const,
    platform: 'desktop' as const,
    focus: 'focused' as const,
    reducedMotion: false,
    allIn: false,
  };
  it('reduced motion beats everything', () => {
    expect(resolveCardAnimationProfile({ ...base, reducedMotion: true, allIn: true })).toBe(
      P.reduced
    );
  });
  it('a hidden table is instant', () => {
    expect(resolveCardAnimationProfile({ ...base, focus: 'hidden', allIn: true })).toBe(P.off);
  });
  it('an all-in runout holds, on every platform and mode', () => {
    expect(resolveCardAnimationProfile({ ...base, allIn: true })).toBe(P.allIn);
    expect(resolveCardAnimationProfile({ ...base, allIn: true, platform: 'mobile' })).toBe(P.allIn);
    expect(resolveCardAnimationProfile({ ...base, allIn: true, mode: 'tournament' })).toBe(P.allIn);
  });
  it('a visible background table is compact', () => {
    expect(resolveCardAnimationProfile({ ...base, focus: 'visible', mode: 'tournament' })).toBe(
      P.background
    );
  });
  it('a phone is fast whatever the mode', () => {
    expect(resolveCardAnimationProfile({ ...base, platform: 'mobile', mode: 'tournament' })).toBe(
      P.mobile
    );
  });
  it('then the game mode picks', () => {
    expect(resolveCardAnimationProfile(base)).toBe(P.cashDesktop);
    expect(resolveCardAnimationProfile({ ...base, mode: 'tournament' })).toBe(P.tournamentDesktop);
    expect(resolveCardAnimationProfile({ ...base, mode: 'lightning' })).toBe(P.lightningDesktop);
    expect(resolveCardAnimationProfile({ ...base, mode: 'replay' })).toBe(P.replayDesktop);
    // PHASE 2 2026-09-05: a spectator has their own profile now - same shape
    // as cash, its own id, so watched hands and played hands stay separable
    // in the telemetry (spec 36, 94, 118).
    expect(resolveCardAnimationProfile({ ...base, mode: 'spectator' })).toBe(P.spectatorDesktop);
    expect(resolveCardAnimationProfile({ ...base, platform: 'tablet' })).toBe(P.cashDesktop);
  });
  it('never returns OFF for a table a player can see - there is no off toggle (10.6)', () => {
    const inputs = [
      base,
      { ...base, focus: 'visible' as const },
      { ...base, platform: 'mobile' as const },
    ];
    for (const i of inputs) expect(resolveCardAnimationProfile(i).intensity).not.toBe('off');
  });
});

describe('detectPlatform', () => {
  it('uses the board stylesheet breakpoint', () => {
    expect(detectPlatform(375)).toBe('mobile');
    expect(detectPlatform(MOBILE_MAX_WIDTH_PX)).toBe('mobile');
    expect(detectPlatform(MOBILE_MAX_WIDTH_PX + 1)).toBe('tablet');
    expect(detectPlatform(TABLET_MAX_WIDTH_PX)).toBe('tablet');
    expect(detectPlatform(1440)).toBe('desktop');
    expect(detectPlatform(NaN)).toBe('desktop');
  });
});
