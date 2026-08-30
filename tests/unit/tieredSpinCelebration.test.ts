/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A 100x MUST NOT CELEBRATE LIKE A 2x (2026-08-29, round 15)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Before this, the rarest event in the product had no moment of its own:
 *
 *   - the confetti burst was a FLAT 24 pieces for 25x, 50x and 100x alike;
 *   - the banner read the same "JACKPOT SPIN" for 25x and 50x;
 *   - the sound differed only in VOLUME - the same chord, turned up;
 *   - and a 10x (1 in 100) got no celebration at all.
 *
 * `spinCelebration` is now the single place that decides intensity, and both
 * the wheel and SoundService derive from it, so they cannot drift - the same
 * discipline spinOddsTable established.
 *
 * ANIMATION LAW (CLAUDE.md 10.6): this may only ADD. The pins below prove
 * every band that celebrated before still celebrates at least as much, that
 * no band is gated off, and that reduced motion collapses motion without
 * collapsing meaning.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spinCelebration, SPIN_TIERS } from '../../src/config/spinSpec';

const root = join(__dirname, '..', '..');
const WHEEL = readFileSync(join(root, 'src', 'components', 'tournament', 'SpinWheel.tsx'), 'utf8');
const CSS = readFileSync(join(root, 'src', 'components', 'tournament', 'SpinWheel.css'), 'utf8');
const SOUND = readFileSync(join(root, 'src', 'services', 'SoundService.ts'), 'utf8');

describe('intensity rises strictly with rarity', () => {
  it('gives each headline tier its own band and its own words', () => {
    expect(spinCelebration(100).band).toBe('mega');
    expect(spinCelebration(100).label).toBe('MEGA JACKPOT');
    expect(spinCelebration(50).label).toBe('SUPER JACKPOT');
    expect(spinCelebration(25).label).toBe('JACKPOT SPIN');
    // 50x and 25x no longer share one banner.
    expect(spinCelebration(50).label).not.toBe(spinCelebration(25).label);
  });

  it('confetti and sound both increase monotonically up the ladder', () => {
    const ladder = [2, 3, 4, 5, 10, 25, 50, 100];
    for (let i = 1; i < ladder.length; i++) {
      const lo = spinCelebration(ladder[i - 1]);
      const hi = spinCelebration(ladder[i]);
      expect(hi.confettiPieces).toBeGreaterThanOrEqual(lo.confettiPieces);
      expect(hi.soundLevel).toBeGreaterThanOrEqual(lo.soundLevel);
    }
    // and the extremes are genuinely different, not merely non-decreasing.
    expect(spinCelebration(100).confettiPieces).toBeGreaterThan(spinCelebration(25).confettiPieces);
  });

  it('covers every real tier on the ladder without throwing', () => {
    for (const t of SPIN_TIERS) {
      const c = spinCelebration(t.multiplier);
      expect(c.confettiPieces).toBeGreaterThanOrEqual(0);
      expect(c.soundLevel).toBeGreaterThan(0);
    }
  });
});

describe('the Animation Law is respected - additive only', () => {
  it('every tier that celebrated before still celebrates', () => {
    // 25x and up had confetti before this change; they must not lose it.
    for (const m of [25, 50, 100]) {
      expect(spinCelebration(m).confettiPieces).toBeGreaterThanOrEqual(24);
    }
  });

  it('a 10x, which previously got nothing, now gets a burst', () => {
    expect(spinCelebration(10).confettiPieces).toBeGreaterThan(0);
    expect(spinCelebration(10).label).toBe('BIG SPIN');
  });

  it('no cue is ever silenced - every band has a non-zero sound level', () => {
    for (const m of [2, 3, 4, 5, 10, 25, 50, 100]) {
      expect(spinCelebration(m).soundLevel).toBeGreaterThan(0);
    }
  });

  it('reduced motion collapses motion but keeps the banner readable', () => {
    expect(CSS).toContain('prefers-reduced-motion');
    const idx = CSS.indexOf('prefers-reduced-motion');
    const block = CSS.slice(idx);
    expect(block).toContain('.sw__hype--mega');
    expect(block).toContain('animation: none');
    // The banner element itself is never display:none'd under reduced motion.
    expect(block).not.toMatch(/\.sw__hype[^{]*\{[^}]*display:\s*none/);
  });

  it('confetti duration honours the player Animation Speed variable', () => {
    expect(CSS).toContain('var(--animation-speed, 1)');
  });
});

describe('the wheel and the sound derive from ONE source', () => {
  it('the wheel takes its banner and burst from spinCelebration', () => {
    expect(WHEEL).toContain('spinCelebration(data.multiplier)');
    expect(WHEEL).toContain('celebration.confettiPieces');
    expect(WHEEL).toContain('celebration.label');
    // the old flat burst is gone
    expect(WHEEL).not.toContain('{ length: 24 }');
  });

  it('SoundService takes its level from the same function, not a local ladder', () => {
    expect(SOUND).toContain('spinCelebration(multiplier).soundLevel');
    expect(SOUND).not.toMatch(/multiplier >= 100 \? 1 : multiplier >= 25/);
  });
});
