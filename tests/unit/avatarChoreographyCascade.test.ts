import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sliceCssRule } from '../helpers/sourceWindow';

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

const GESTURES = ['push', 'check', 'fold', 'celebrate', 'lose', 'alert'] as const;

/** Animations that run forever, so reduced motion MUST switch each one off. */
const INFINITE = ['.seat__avatar-wrap,', '.seat__avatar-wrap--tense,'] as const;

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
    for (const sel of INFINITE) {
      expect(
        rm.includes(sel),
        `reduced motion must disable ${sel} — it runs forever, so unlike a ` +
          `sub-second gesture it is one a motion-sensitive player cannot wait out`
      ).toBe(true);
    }
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
    // Same transform var as .seat__avatar-img, so the two cannot drift apart.
    //
    // This asserted `var(--sp-bust-scale` until 2026-08-23, and it was a fair
    // assertion while the scale was one number. Then a PER-CHARACTER gain was
    // added to the img alone and the mask kept scaling by the global — the band
    // stopped hugging the silhouette for any corrected character, and this test
    // passed throughout, because the img and the mask did both still mention
    // --sp-bust-scale. Naming a shared INPUT does not prove a shared RESULT.
    //
    // --sp-bust-effective-scale IS the composed result (global scale times the
    // clamped per-character gain), so requiring it is the assertion the
    // original was reaching for.
    expect(holo.includes('var(--sp-bust-effective-scale')).toBe(true);
  });

  it('draws every part of a bust from the ONE composed scale', () => {
    // The regression above was possible because four rules each wrote their own
    // scale() by hand: the img, its hover, the rig canvas and the holo mask.
    // Add a term to one and the other three silently disagree.
    //
    // So this is the rule with teeth: inside a bust transform the bare global
    // --sp-bust-scale is BANNED. Compose it once into --sp-bust-effective-scale
    // (declared on .seat__avatar--bust in SeatSlot.css) and read that. Any
    // future term added to the composition then reaches all four for free,
    // which is the only version of "cannot drift" that survives being edited.
    // Comments stripped first: this file documents the geometry contract in
    // prose, and a worked example of a transform inside a /* */ block is not a
    // declaration. Scanning raw text flagged the documentation as a violation.
    const declarations = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
    const bustTransforms = declarations
      .split('\n')
      .filter((l) => l.includes('transform:') && l.includes('--sp-bust-scale'));
    expect(
      bustTransforms,
      'these transforms read the raw --sp-bust-scale and so will miss any ' +
        'per-character correction; use var(--sp-bust-effective-scale) instead'
    ).toEqual([]);
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

  it('declares the rigged stop AFTER every gesture rule', () => {
    // Mirror image of the idle-before-gestures rule. `.seat__avatar-wrap--rigged`
    // is a single class, identical specificity to the five gesture classes, so
    // it only wins by being declared LAST. Move it above them and a rigged
    // avatar silently double-animates: its own Rive Push plus the wrap's lean.
    const lines = CSS.split('\n');
    const rigged = lines.findIndex((l) => l.trim() === '.seat__avatar-wrap--rigged {');
    expect(rigged, 'no --rigged stop rule').toBeGreaterThan(-1);
    for (const g of GESTURES) {
      const gestureRule = lineOf((l) => l.trim() === `.seat__avatar-wrap--${g} {`);
      expect(
        rigged,
        `--rigged must come after .seat__avatar-wrap--${g}, or the gesture wins ` +
          `and a rigged avatar animates twice`
      ).toBeGreaterThan(gestureRule);
    }
    // It must also switch off the INFINITE idle, which is not a gesture class
    // and so is not covered by SeatSlot declining to apply gesture classes.
    expect(sliceCssRule(CSS, '.seat__avatar-wrap--rigged {')).toContain('animation: none');
  });

  it('gives the rig canvas the same geometry as the bust it replaces', () => {
    // Without this the canvas keeps only its inline attributes — an 84px SQUARE,
    // unscaled — while the bust beside it renders ~90x122 after object-fit
    // contain against a 125x170 artboard and then scale(1.45). The rig would
    // look shrunken and would not sit on the name box.
    expect(CSS).toContain('.seat__avatar-rive');
    const rive = CSS.slice(CSS.indexOf('.seat__avatar--bust .seat__avatar-rive'));
    // Read the actual rule BLOCK rather than a fixed slice of characters. The
    // assertion used to be `rive.slice(0, 320)`, which is a guess at how long
    // the rule is: adding the comment that explains which scale variable to use
    // pushed the declaration past the window and failed a rule that was
    // correct. A test should fail when the CSS is wrong, not when it is
    // documented.
    const riveBlock = rive.slice(0, rive.indexOf('}') + 1);
    expect(
      riveBlock,
      'the rig canvas must reuse --sp-bust-effective-scale so it cannot drift from the img'
    ).toContain('var(--sp-bust-effective-scale');
    expect(riveBlock).toContain('transform-origin');
  });

  it('sheds ONLY the infinite animations under the motion budget', () => {
    // The point of the lite mode is that it cuts decoration, not information.
    // A one-shot gesture is under a second and fires on a real event — a fold
    // you cannot see is a worse outcome than a dropped frame — so gestures must
    // survive. If a future edit adds them here, the table stops communicating
    // on exactly the devices that most need it to.
    const lite = CSS.split('\n')
      .map((l, i) => [l, i] as const)
      .filter(([l]) => l.includes("[data-sp-motion='lite']"));
    expect(lite.length, 'no motion-budget rules found').toBeGreaterThan(0);

    const litSelectors = lite.map(([l]) => l);
    for (const g of GESTURES) {
      expect(
        litSelectors.some((l) => l.includes(`--${g}`) && !l.includes('--tense')),
        `lite mode must NOT disable the one-shot "${g}" gesture — it carries meaning`
      ).toBe(false);
    }
    // ...and it must actually cover all three infinite ones.
    const joined = litSelectors.join('\n');
    expect(joined, 'breathing not shed').toContain('.seat__avatar-wrap,');
    expect(joined, 'tense tremor not shed').toContain('--tense');
    expect(joined, 'holo sweep not shed').toContain('--holo');
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
