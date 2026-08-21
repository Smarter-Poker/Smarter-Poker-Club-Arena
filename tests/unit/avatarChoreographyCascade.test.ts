import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Guards the CASCADE of avatarChoreography.css, not its content.
 *
 * Every rule in that file is a single class on `.seat__avatar-wrap`, so the
 * cascade is decided by specificity and source order rather than by anything
 * visible in a diff. Two mistakes are easy to make there, both silent, and
 * both were made while writing the file:
 *
 *   1. Putting the infinite idle rule AFTER the one-shot gesture rules. Equal
 *      specificity means last-wins, so the idle animation would replace every
 *      gesture and nothing would ever push, fold or celebrate.
 *
 *   2. Writing the "hold still" rules as `.seat--folded .seat__avatar-wrap`
 *      without excluding the gesture. That is two classes against the gesture's
 *      one, and specificity beats source order, so `animation: none` wins and
 *      the fold gesture never plays — the character teleports into the slump.
 *      SeatSlot pushes `seat--folded` on the same render that applies the fold
 *      gesture class, so the two genuinely do co-occur.
 *
 * Neither shows up in a typecheck, a build, or a screenshot of a static table.
 * They only appear as "the avatars stopped moving", which is exactly the kind
 * of regression that gets noticed weeks later.
 */

const CSS = readFileSync(
  resolve(__dirname, '../../src/components/table/avatarChoreography.css'),
  'utf8'
);

const GESTURES = ['push', 'check', 'fold', 'celebrate', 'alert'] as const;

/** Line index of the first line matching a predicate, or -1. */
function lineOf(pred: (l: string) => boolean): number {
  return CSS.split('\n').findIndex(pred);
}

describe('avatarChoreography.css cascade', () => {
  it('declares the idle breathing rule BEFORE every gesture rule', () => {
    // The base rule is the bare `.seat__avatar-wrap {` block that names the
    // breathing keyframe. Find it by the keyframe, not by the selector, since
    // the selector also appears as a token-only block earlier in the file.
    const lines = CSS.split('\n');
    const breatheDecl = lines.findIndex(
      (l) => l.includes('spAvatarBreathe') && l.includes('animation')
    );
    expect(breatheDecl, 'base breathing rule not found').toBeGreaterThan(-1);

    for (const g of GESTURES) {
      const gestureRule = lineOf((l) => l.trim() === `.seat__avatar-wrap--${g} {`);
      expect(gestureRule, `gesture rule for "${g}" not found`).toBeGreaterThan(-1);
      expect(
        breatheDecl,
        `idle breathing must be declared before .seat__avatar-wrap--${g}, or it ` +
          `wins the cascade (equal specificity, last-wins) and the gesture never plays`
      ).toBeLessThan(gestureRule);
    }
  });

  it('never lets a state rule out-rank the fold gesture', () => {
    // Any rule that turns animation off for a seat STATE must exclude the fold
    // gesture, because state selectors carry higher specificity than it does.
    const offenders = CSS.split('\n')
      .filter((l) => /^\s*\.seat--[a-z_]+\s+\.seat__avatar-wrap/.test(l))
      .filter((l) => !l.includes(':not(.seat__avatar-wrap--fold)'))
      // The persistent folded POSTURE rule sets transform, not animation — it is
      // meant to out-rank, and it is what the gesture settles onto.
      .filter((l) => !l.includes('.seat--folded .seat__avatar-wrap {'));

    expect(
      offenders,
      'these state rules would beat the fold gesture on specificity; add ' +
        ':not(.seat__avatar-wrap--fold)'
    ).toEqual([]);
  });

  it('turns the infinite idle animation off under reduced motion', () => {
    const rm = CSS.slice(CSS.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(rm, 'no reduced-motion block').not.toEqual('');
    // The bare wrap selector is what disables the INFINITE one. A gesture lasts
    // half a second; breathing runs forever, so it is the animation a
    // motion-sensitive player actually cannot escape.
    expect(
      rm.includes('.seat__avatar-wrap,'),
      'reduced motion must disable the base .seat__avatar-wrap breathing, not ' +
        'only the gesture classes'
    ).toBe(true);
  });

  it('keeps the holo band able to actually move', () => {
    // THE BUG THIS EXISTS FOR: `background-position` percentages resolve as
    // (container - image) * percentage. At `background-size: 100% 100%` that
    // factor is ZERO, so the band cannot move however the keyframe is written
    // and the whole effect renders as nothing. It was written that way first
    // and only caught by screenshotting it in chromium — the CSS reads
    // perfectly, the animation is "running", and the output is blank.
    const holo = CSS.slice(CSS.indexOf('.seat__avatar--holo::after'));
    const size = holo.match(/background-size:\s*([^;]+);/)?.[1]?.trim();
    expect(size, 'holo overlay has no background-size').toBeTruthy();
    expect(
      size,
      'background-size must be SHORTER than the box or background-position ' +
        'percentages have zero range and the band never moves'
    ).not.toBe('100% 100%');
  });

  it('masks the holo band to the character, not to a rectangle', () => {
    const holo = CSS.slice(CSS.indexOf('.seat__avatar--holo::after'));
    // Without the mask the band is a rectangle that overshoots the character
    // and lies across the felt — the "ring behind the player" complaint in a
    // different costume, and a violation of the standing no-glow rule.
    expect(holo.includes('mask-image: var(--sp-avatar-src)')).toBe(true);
    // Mask geometry must mirror the img's object-fit/object-position, or the
    // band drifts off the artwork at any scale other than the default.
    expect(holo.includes('mask-size: contain')).toBe(true);
    expect(holo.includes('mask-position: 50% 100%')).toBe(true);
    // Same transform vars as .seat__avatar-img, so the two cannot drift apart
    // when --sp-bust-scale changes (the top rail already sets it to 1.15).
    expect(holo.includes('var(--sp-bust-scale')).toBe(true);
  });

  it('gives the holo sweep its own phase, not the breathing one', () => {
    // Reusing --sp-breath-delay looked fine and measured wrong: those delays
    // span only 1.1s-3.9s, a good spread across a ~4s breath and a poor one
    // across a 7s sweep. Every VIP would flash inside one narrow window and go
    // dark together — the synchronised-machinery look the phase exists to stop.
    const holo = CSS.slice(CSS.indexOf('.seat__avatar--holo::after'));
    const delay = holo.match(/animation-delay:\s*var\((--[a-z-]+)/)?.[1];
    expect(delay, 'holo has no animation-delay').toBeTruthy();
    expect(
      delay,
      'the holo must use --sp-holo-delay; --sp-breath-delay is scaled to the ' +
        'breathing period and clusters every VIP into one window on a 7s cycle'
    ).toBe('--sp-holo-delay');
  });

  it('stops the holo sweep under reduced motion', () => {
    const rm = CSS.slice(CSS.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(
      rm.includes('.seat__avatar--holo::after'),
      'the holo sweep is infinite, so reduced motion must switch it off too'
    ).toBe(true);
  });

  it('keeps every gesture keyframe defined exactly once', () => {
    // @keyframes is a global namespace across all loaded stylesheets. This repo
    // has already been bitten: `winnerAvatarGlow` existed in two files with
    // different bodies, so whichever loaded last won for both.
    for (const name of [
      'spAvatarBreathe',
      'spAvatarAlert',
      'spAvatarPush',
      'spAvatarFold',
      'spAvatarHolo',
    ]) {
      const count = CSS.split(`@keyframes ${name}`).length - 1;
      expect(count, `${name} should be defined exactly once`).toBe(1);
    }
  });
});
