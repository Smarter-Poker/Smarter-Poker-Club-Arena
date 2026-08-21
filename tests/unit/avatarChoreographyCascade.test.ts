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

  it('keeps every gesture keyframe defined exactly once', () => {
    // @keyframes is a global namespace across all loaded stylesheets. This repo
    // has already been bitten: `winnerAvatarGlow` existed in two files with
    // different bodies, so whichever loaded last won for both.
    for (const name of ['spAvatarBreathe', 'spAvatarAlert', 'spAvatarPush', 'spAvatarFold']) {
      const count = CSS.split(`@keyframes ${name}`).length - 1;
      expect(count, `${name} should be defined exactly once`).toBe(1);
    }
  });
});
