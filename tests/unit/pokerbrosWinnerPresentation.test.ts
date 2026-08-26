/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  POKERBROS WINNER PRESENTATION — the 2026-08-26 frame-by-frame parity pass
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan supplied a screen recording of the reference client's showdown (26 Aug,
 * PLO5 "Flush" hand) and asked for a 1:1 clone. A frame-by-frame pass of that
 * recording pinned four facts this file guards:
 *
 *  1. DIMMING EXISTS. The moment the winning five are named, every card
 *     OUTSIDE them — board cards, a losing shown hand, and the winner's own
 *     unused hole cards — drops to roughly half brightness. Winning cards
 *     keep full brightness. This was the missing half of the highlight:
 *     lighting the winners without dimming the rest reads as "nothing
 *     happened" on a bright board.
 *
 *  2. THE HIGHLIGHT IS STEADY. The reference never pulses, lifts, bobs or
 *     scales a winning card. The old infinite ccHighlightPulse /
 *     winnerCardPulse / ccGlowPulse loops and CardImage's translateY lift
 *     are exactly the kind of motion the reference does not have.
 *
 *  3. THE STATE IS A CUT, NOT A FADE. Border, halo, dim and banner all land
 *     within one video frame (~33ms). Transitions here are capped at 150ms —
 *     anything slower is visibly not the reference.
 *
 *  4. THE BANNER SITS BELOW THE BOARD: a translucent dark band with a hot
 *     orange flare streak and a gold hand name, superseding the older
 *     above-the-board blue-glow label.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
const read = (p: string) => readFileSync(resolve(__dirname, '../../', p), 'utf8');

const BOARD = strip(read('src/components/table/CommunityCards.tsx'));
const BOARD_CSS = read('src/components/table/CommunityCards.css');
const SEAT = strip(read('src/components/table/SeatSlot.tsx'));
const SEAT_CSS = read('src/components/table/SeatSlot.css');
const CARD_CSS = read('src/components/table/CardImage.css');
const TABLE_PAGE = strip(read('src/pages/TablePage.tsx'));

describe('cards outside the winning five DIM (board)', () => {
  it('the board derives a dim state from the highlight set', () => {
    expect(BOARD).toMatch(/isDimmed:\s*highlightedIndices\.length\s*>\s*0/);
    expect(BOARD).toMatch(/!highlightedIndices\.includes\(i\)/);
  });

  it('the dim class is applied to the card, and the CSS halves brightness', () => {
    expect(BOARD).toMatch(/community-cards__card--dimmed/);
    const at = BOARD_CSS.indexOf('.community-cards__card--dimmed');
    expect(at, 'dim rule missing from board CSS').toBeGreaterThan(-1);
    expect(BOARD_CSS.slice(at, at + 300)).toMatch(/brightness\(0\.\d+\)/);
  });
});

describe('cards outside the winning five DIM (seats)', () => {
  it('SeatSlot accepts the table-wide winnerDisplayActive flag', () => {
    expect(SEAT).toMatch(/winnerDisplayActive\?:\s*boolean/);
  });

  it('both hole-card rows dim non-winning face-up cards while a winner shows', () => {
    const uses = SEAT.match(/isDimmed=\{\s*winnerDisplayActive\s*&&/g) || [];
    expect(uses.length, 'villain row AND hero row must both dim').toBeGreaterThanOrEqual(2);
  });

  it('the memo comparator lets the dim flag through', () => {
    expect(SEAT).toMatch(/prev\.winnerDisplayActive\s*!==\s*next\.winnerDisplayActive/);
  });

  it('TablePage raises the flag from winnerInfo', () => {
    expect(TABLE_PAGE).toMatch(/winnerDisplayActive=\{winnerInfo\.playerIds\.length\s*>\s*0\}/);
  });

  it('the seat dim rule exists and halves brightness', () => {
    const at = SEAT_CSS.indexOf('.seat__card--dimmed');
    expect(at, 'dim rule missing from seat CSS').toBeGreaterThan(-1);
    expect(SEAT_CSS.slice(at, at + 300)).toMatch(/brightness\(0\.\d+\)/);
  });
});

describe('the highlight is STEADY — the reference never pulses a winning card', () => {
  it('no infinite pulse loops on winner styling', () => {
    for (const css of [BOARD_CSS, SEAT_CSS, CARD_CSS]) {
      expect(css).not.toMatch(/ccHighlightPulse\s+[^;]*infinite/);
      expect(css).not.toMatch(/winnerCardPulse\s+[^;]*infinite/);
      expect(css).not.toMatch(/ccGlowPulse\s+[^;]*infinite/);
    }
  });

  it('CardImage no longer lifts a highlighted card off its slot', () => {
    const at = CARD_CSS.indexOf('.card-image--highlighted');
    expect(at).toBeGreaterThan(-1);
    // Only the rule BODY — the neighbouring --folded rule's grayscale() would
    // false-positive a bare /scale\(/ across a fixed-width slice.
    const body = CARD_CSS.slice(at, CARD_CSS.indexOf('}', at));
    expect(body).not.toMatch(/translateY|[^a-z]scale\(/);
  });
});

describe('the state lands as a CUT — nothing slower than 150ms', () => {
  it('board dim transition is fast', () => {
    const at = BOARD_CSS.indexOf('.community-cards__card--dimmed');
    const rule = BOARD_CSS.slice(at, at + 300);
    const ms = rule.match(/transition:\s*filter\s+0\.(\d+)s/);
    expect(ms, 'dim transition missing').not.toBeNull();
    expect(Number(`0.${ms![1]}`)).toBeLessThanOrEqual(0.15);
  });

  it('the banner enters as a hard cut, not a spring', () => {
    expect(BOARD_CSS).toMatch(/ccBannerCut/);
    expect(BOARD_CSS).not.toMatch(/ccHandNameShimmer/);
  });
});

describe('the banner is the reference banner', () => {
  it('sits BELOW the board', () => {
    const at = BOARD_CSS.indexOf('.community-cards__hand-name {');
    expect(at).toBeGreaterThan(-1);
    expect(BOARD_CSS.slice(at, at + 500)).toMatch(/top:\s*calc\(100%/);
  });

  it('gold text over a translucent dark band with the orange flare streak', () => {
    const at = BOARD_CSS.indexOf('.community-cards__hand-name {');
    const rule = BOARD_CSS.slice(at, at + 1400);
    expect(rule).toMatch(/#f5c343/i);
    const flareAt = BOARD_CSS.indexOf('.community-cards__hand-name::before');
    expect(BOARD_CSS.slice(flareAt, flareAt + 900)).toMatch(/255,\s*158,\s*64/);
  });
});
