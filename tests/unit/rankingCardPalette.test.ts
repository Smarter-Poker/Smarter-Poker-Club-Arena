/**
 * THE RANKING CARD USES THE HOUSE PALETTE. NO BROWNS, NO YELLOWS.
 *
 * Dan, 2026-08-23: "CHANGE THIS CARD TO SMARTER.POKER COLOR SCHEMA'S NO BROWNS
 * OR YELLOWS."
 *
 * The card had a gold close button, a gold "Reward" label, a gold brand accent,
 * an amber secondary button and a gold/bronze medal-and-band ramp - a brown
 * #7a3a1f band being the thing he actually photographed, under a 4th place.
 *
 * A palette is exactly the kind of rule that decays: the next person adding a
 * "winner" flourish reaches for gold because gold means winning, and nothing
 * stops them. This parses the stylesheet and fails if a warm hex comes back.
 *
 * Hue is the honest test, not a blocklist of specific values - #b8860b and
 * #f0a800 are different strings and the same mistake.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const CSS = readFileSync(
  resolve(process.cwd(), 'src/components/tournament/TournamentRankingCard.css'),
  'utf8'
);

/** Strip comments: they discuss the old colours on purpose. */
const CODE = CSS.replace(/\/\*[\s\S]*?\*\//g, '');

function hexToHsl(hex: string): { h: number; s: number; l: number } {
  let v = hex.slice(1);
  if (v.length === 3)
    v = v
      .split('')
      .map((c) => c + c)
      .join('');
  const r = parseInt(v.slice(0, 2), 16) / 255;
  const g = parseInt(v.slice(2, 4), 16) / 255;
  const b = parseInt(v.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b),
    min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === r) h = 60 * (((g - b) / d) % 6);
  else if (max === g) h = 60 * ((b - r) / d + 2);
  else h = 60 * ((r - g) / d + 4);
  if (h < 0) h += 360;
  return { h, s, l };
}

const hexes = Array.from(CODE.matchAll(/#[0-9a-fA-F]{3,8}\b/g)).map((m) => m[0]);

describe('TournamentRankingCard palette', () => {
  it('actually contains colours to check', () => {
    expect(hexes.length).toBeGreaterThan(10);
  });

  it('has no warm hues — no gold, amber, brown or bronze', () => {
    /* Warm = hue 20-70 (orange through yellow) with enough saturation to read
       as a colour rather than a near-grey. Browns are the same hue band at low
       lightness, so one rule catches both. */
    const warm = hexes.filter((hex) => {
      if (hex.length !== 4 && hex.length !== 7) return false;
      const { h, s } = hexToHsl(hex);
      return h >= 20 && h <= 70 && s > 0.25;
    });
    expect(warm, `warm colours found: ${warm.join(', ')}`).toEqual([]);
  });

  it('keeps the house blue and cyan', () => {
    const lower = CODE.toLowerCase();
    expect(lower).toContain('#1877f2');
    expect(lower).toContain('#00d4ff');
  });

  it('gives an out-of-the-money place a blue band, not a brown one', () => {
    // The exact thing in the screenshot: 4th place, brown bar.
    expect(CODE).not.toMatch(/--trc2-band,\s*#7a3a1f/);
    expect(CODE).toMatch(/--trc2-band,\s*#233355/);
  });

  it('still distinguishes the podium steps from each other', () => {
    /* Removing gold must not flatten 1st/2nd/3rd into one colour - the card's
       whole job is to say WHICH place this was. */
    const bands = ['gold', 'silver', 'bronze'].map((tier) => {
      const m = new RegExp(
        `\\.trc2__placeband\\.trc2__medal--${tier}\\s*\\{[^}]*--trc2-band:\\s*(#[0-9a-fA-F]{6})`
      ).exec(CODE);
      return m?.[1];
    });
    expect(bands.every(Boolean)).toBe(true);
    expect(new Set(bands).size).toBe(3);
  });
});
