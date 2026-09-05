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
  FLIP_CEILING_MS,
  MOBILE_FLIP_MS,
  SQUEEZE_KEYFRAME_SPLIT,
  flipMs,
} from '../../../src/presentation/cardPresentation/profiles';
import {
  resolveCardAnimationProfile,
  detectPlatform,
  MOBILE_MAX_WIDTH_PX,
  TABLET_MAX_WIDTH_PX,
} from '../../../src/presentation/cardPresentation/resolveProfile';
import { ALL_IN_SQUEEZE_CEILING_MS, HAND_COMPLETION } from '../../../src/config/handCompletionSpec';
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

  it('every flip is at or under the published 400ms ceiling', () => {
    // "Transitions that exceed 400ms may feel too slow" - Material Design.
    // The spec's own suggested defaults put cash at a 480ms flip, tournament
    // at 540 and replay at 640; all three were over it, and the spec itself
    // said those numbers were "initial defaults only ... tune after testing".
    for (const p of all) {
      expect(flipMs(p), `${p.id} flip`).toBeLessThanOrEqual(FLIP_CEILING_MS);
    }
  });

  it('MOBILE IS THE LONGER ONE, which is the opposite of the intuition', () => {
    // Material: mobile transitions typically 300ms; "Desktop animations
    // should be faster and simpler than their mobile counterparts ... 150ms
    // to 200ms". The first version of this table had mobile at 320ms and
    // desktop at 480ms - backwards.
    expect(flipMs(P.mobile)).toBe(MOBILE_FLIP_MS);
    expect(flipMs(P.mobile)).toBeGreaterThan(flipMs(P.cashDesktop));
  });

  it('durations come off the Material 3 ladder, not out of the air', () => {
    const LADDER = [0, 50, 100, 150, 200, 250, 300, 350, 400];
    for (const p of all) {
      expect(LADDER, `${p.id} flip ${flipMs(p)}`).toContain(flipMs(p));
    }
    expect(flipMs(P.cashDesktop)).toBe(250);
    expect(flipMs(P.tournamentDesktop)).toBe(300);
    expect(flipMs(P.lightningDesktop)).toBe(200);
    expect(flipMs(P.replayDesktop)).toBe(400);
    expect(flipMs(P.background)).toBe(150);
    expect(flipMs(P.reduced)).toBe(150);
    expect(P.off.durationMs).toBe(0);
  });

  it('the all-in profile is sized from the server run-out pacing, not hand-tuned', () => {
    // VIP ALL-IN SQUEEZE 2026-09-05: the hold is the player's ceiling, derived
    // from the reveal gate plus the shorter server pause after it, less the
    // snap. It used to equal ALL_IN_STREET_REVEAL_MS; see handCompletionSpec.
    expect(P.allIn.durationMs).toBe(ALL_IN_SQUEEZE_CEILING_MS);
    expect(P.allIn.durationMs).toBeGreaterThan(HAND_COMPLETION.ALL_IN_STREET_REVEAL_MS);
    expect(P.allIn.holdMs).toBeGreaterThan(P.allIn.squeezeMs);
    expect(P.allIn.interactive).toBe(true);
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
  it('a hidden table is instant, and that outranks even reduced motion', () => {
    // AUDIT FIX 2026-09-05: `off` used to lose to `reduced`, which still
    // schedules a 120ms presentation with markup to mount and tear down for a
    // table nobody can see. Both put the correct card on the board; this is
    // the cheaper way to say it.
    expect(resolveCardAnimationProfile({ ...base, focus: 'hidden', allIn: true })).toBe(P.off);
    expect(resolveCardAnimationProfile({ ...base, focus: 'hidden', reducedMotion: true })).toBe(
      P.off
    );
  });
  it('reduced motion beats everything a player can actually see', () => {
    expect(resolveCardAnimationProfile({ ...base, reducedMotion: true, allIn: true })).toBe(
      P.reduced
    );
    expect(resolveCardAnimationProfile({ ...base, reducedMotion: true, focus: 'visible' })).toBe(
      P.reduced
    );
  });
  it('an all-in runout holds for the viewer who may squeeze, on every platform and mode', () => {
    // VIP ALL-IN SQUEEZE 2026-09-05: `allIn` AND `squeeze`. See
    // tests/unit/vipAllInSqueeze.test.ts for the other half of the matrix.
    const sq = { ...base, allIn: true, squeeze: true };
    expect(resolveCardAnimationProfile(sq)).toBe(P.allIn);
    expect(resolveCardAnimationProfile({ ...sq, platform: 'mobile' })).toBe(P.allIn);
    expect(resolveCardAnimationProfile({ ...sq, mode: 'tournament' })).toBe(P.allIn);
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
