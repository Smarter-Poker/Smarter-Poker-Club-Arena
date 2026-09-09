/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  TICKER THEME - the colour rules the rail is painted with
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * WHY THIS FILE EXISTS (audit 2026-09-05)
 *
 * The flag - the "STARTING SOON" chip at the left edge - was painted with an
 * inline `color: managedTicker.accentColor` over a stylesheet background that
 * was ALSO built from that same cyan. The default club accent is `#00d4ff` and
 * the flag's gradient runs `#00d4ff -> #0aa6cc`, so the loudest word on the bar
 * was rendered cyan on cyan at a contrast ratio of about 1.06:1. The management
 * service validates 4.5:1 for the MESSAGE and never looked at the flag, so
 * nothing caught it.
 *
 * The accent is a BACKGROUND colour. That is what "accent" means on a broadcast
 * rail: the chip is filled with it and the text on the chip is whatever reads
 * against that fill. So the ink is derived, never authored.
 *
 * A USEFUL PROPERTY, PROVEN IN tests/unit/tickerTheme.test.ts
 *
 * For ANY six-digit hex, the better of near-black and near-white always clears
 * 4.5:1. The worst case is a background at relative luminance 0.179, where both
 * candidates land on 4.58:1 - above the AA threshold. So `readableInk` cannot
 * return an illegible pairing for any colour a club is able to save, which is a
 * stronger guarantee than a validator that can be bypassed by a direct RPC
 * call. The test sweeps the cube and asserts it rather than trusting the maths
 * written here.
 *
 * Pure on purpose - no React, no DOM, no Supabase. Same shape as
 * overlayAnnouncements and topChrome: values in, values out, asserted directly.
 */

import { contrastRatio, isHexColor } from '../../utils/colorContrast';

/**
 * What a message is ABOUT, which is what decides its colour.
 *
 * Dan's ticker carries eight sources and they are not equally loud. A player
 * should be able to tell which kind of thing is on the bar without reading it:
 *
 *   time     cyan     something is closing - a start, a registration window
 *   money    gold     there is value on the table - an overlay, a guarantee
 *   info     silver   something happened or opened - results, a new table
 *   service  amber    the house is talking - maintenance, a club notice
 *
 * Gold rather than green for money: green reads as "success / confirmed"
 * everywhere else in this app (ClubAnnouncementBanner uses it for exactly
 * that), and an overlay is neither. It is treasure. That reasoning was already
 * written in TournamentStartingTicker.css, where the overlay flag was then
 * painted silver anyway. This is the file that settles it.
 */
export type TickerTone = 'time' | 'money' | 'info' | 'service';

export const TONE_ACCENT: Record<TickerTone, string> = {
  time: '#00d4ff',
  money: '#f0b429',
  info: '#c3cad2',
  service: '#ff9d3d',
};

/**
 * Near-black and near-white, tinted toward the rail so neither reads as flat.
 *
 * PREFERRED, not guaranteed. See `readableInk`: the tint costs contrast at the
 * ends of the range, and legibility outranks the tint.
 */
export const INK_DARK = '#04121f';
export const INK_LIGHT = '#f5fbff';

/** Pure ends, used only when the tinted pair cannot clear AA. */
export const INK_ABSOLUTE_DARK = '#000000';
export const INK_ABSOLUTE_LIGHT = '#ffffff';

/** WCAG AA for normal-size text, which the flag is: 700 weight but ~10px. */
export const AA_CONTRAST = 4.5;

export const DEFAULT_RAIL_BACKGROUND = '#0b1a33';
export const DEFAULT_ACCENT = '#00d4ff';

function byte(hex: string, index: number): number {
  return Number.parseInt(hex.slice(1 + index * 2, 3 + index * 2), 16);
}

function toHex(r: number, g: number, b: number): string {
  const part = (v: number) =>
    Math.max(0, Math.min(255, Math.round(v)))
      .toString(16)
      .padStart(2, '0');
  return `#${part(r)}${part(g)}${part(b)}`;
}

/** A hex we are willing to paint with, or the fallback. Never throws. */
export function safeHex(value: unknown, fallback: string): string {
  return isHexColor(value) ? String(value).toLowerCase() : fallback;
}

/**
 * Move a colour toward white (positive) or black (negative), 0..1.
 *
 * Done here rather than with CSS `color-mix()` so the exact stops are testable
 * and so a browser without `color-mix` support still gets the gradient rather
 * than a silently flat bar - which is the failure this whole pass exists to
 * remove.
 */
export function shade(hex: string, amount: number): string {
  const base = safeHex(hex, DEFAULT_RAIL_BACKGROUND);
  const t = Math.max(-1, Math.min(1, Number(amount) || 0));
  const target = t >= 0 ? 255 : 0;
  const mix = Math.abs(t);
  const r = byte(base, 0) + (target - byte(base, 0)) * mix;
  const g = byte(base, 1) + (target - byte(base, 1)) * mix;
  const b = byte(base, 2) + (target - byte(base, 2)) * mix;
  return toHex(r, g, b);
}

/**
 * The text colour for a chip filled with `background`.
 *
 * TWO PASSES, AND THE SECOND ONE IS THE GUARANTEE.
 *
 * The tinted inks read better on a rail - a pure black chip label next to a
 * navy strip looks like a hole - but the tint costs contrast at both ends, and
 * the sweep in tests/unit/tickerTheme.test.ts found the price: a mid-blue like
 * `#2d78d2` tops out at 4.26:1 against the tinted pair. That is below AA, which
 * is the exact failure this whole file exists to make impossible, so the tint
 * is a preference and gives way.
 *
 * Falling back to pure black and pure white restores the hard floor. For any
 * six-digit hex the better of those two is at least 4.58:1, at the crossover
 * luminance of 0.179. The test asserts the floor rather than trusting this
 * paragraph.
 */
export function readableInk(background: string): string {
  const fill = safeHex(background, DEFAULT_ACCENT);
  const tinted =
    contrastRatio(INK_DARK, fill) >= contrastRatio(INK_LIGHT, fill) ? INK_DARK : INK_LIGHT;
  if (contrastRatio(tinted, fill) >= AA_CONTRAST) return tinted;
  return contrastRatio(INK_ABSOLUTE_DARK, fill) >= contrastRatio(INK_ABSOLUTE_LIGHT, fill)
    ? INK_ABSOLUTE_DARK
    : INK_ABSOLUTE_LIGHT;
}

/** The flag chip: the accent, lit at the top and seated at the bottom. */
export function flagBackground(accent: string): string {
  const base = safeHex(accent, DEFAULT_ACCENT);
  return `linear-gradient(180deg, ${shade(base, 0.12)} 0%, ${shade(base, -0.16)} 100%)`;
}

/**
 * The rail itself: a horizontal gradient with a lifted centre, over a 1px inner
 * top highlight.
 *
 * The stylesheet has declared a three-stop gradient since 2026-08-20 and it has
 * never rendered once: the render sets `background` inline from the managed
 * colour, and an inline single value beats a stylesheet gradient every time. So
 * the gradient is BUILT FROM the managed colour here and handed back as one
 * inline value, which keeps operator branding and restores the depth.
 */
export function railBackground(base: string): string {
  const ground = safeHex(base, DEFAULT_RAIL_BACKGROUND);
  const centre = shade(ground, 0.14);
  return [
    'linear-gradient(180deg, rgba(255, 255, 255, 0.055) 0%, rgba(255, 255, 255, 0) 42%)',
    `linear-gradient(90deg, ${ground} 0%, ${centre} 50%, ${ground} 100%)`,
  ].join(', ');
}

/** The glow under the rail, in the club's accent. Replaces a hard 1px line. */
export function railGlow(accent: string): string {
  const base = safeHex(accent, DEFAULT_ACCENT);
  return `0 10px 22px -14px ${withAlpha(base, 0.55)}`;
}

/** `#rrggbb` at an alpha, as `rgba()`. */
export function withAlpha(hex: string, alpha: number): string {
  const base = safeHex(hex, DEFAULT_ACCENT);
  const a = Math.max(0, Math.min(1, Number(alpha) || 0));
  return `rgba(${byte(base, 0)}, ${byte(base, 1)}, ${byte(base, 2)}, ${a})`;
}
