/**
 * THE BOMB POT! TITLE STANDS ABOVE THE BOARD (Dan 2026-09-04).
 *
 * "THE 'BOMB POT' THAT EXPLODES AND APPEARS ON THE TABLE NEEDS TO BE HIGHER,
 * IT COVERS THE BOARD WHILE DISPLAYING."
 *
 * jsdom lays nothing out, so this drives measureTitleAnchor with the boxes a
 * real table produces (the numbers are the 390x844 and 1280x800 felt-harness
 * measurements from docs/changelog/2026-09-04-round-chips-and-bigger-corner-
 * buttons.md and the live tournament table read on 2026-09-04).
 */
import { describe, it, expect, vi } from 'vitest';
import { measureTitleAnchor } from '../../src/components/table/BombPotOverlay';

type Box = { top: number; bottom: number; height: number; width: number };
const box = (top: number, bottom: number, width = 100): Box => ({
  top,
  bottom,
  height: bottom - top,
  width,
});

function scopeWith(elements: Record<string, Box[]>): ParentNode {
  const mk = (b: Box) => ({ getBoundingClientRect: () => b }) as unknown as Element;
  return {
    querySelector: (sel: string) => (elements[sel]?.[0] ? mk(elements[sel][0]) : null),
    querySelectorAll: (sel: string) => (elements[sel] ?? []).map(mk),
  } as unknown as ParentNode;
}

describe('measureTitleAnchor', () => {
  it('rests the block just above whichever is higher, the pot pill or the board', () => {
    vi.stubGlobal('innerHeight', 844);
    // Phone: pot pill top at 285, board top at 259, top seats end at 166.
    const scope = scopeWith({
      '.pot-display': [box(285, 320)],
      '.community-area': [box(259, 371)],
      '.seat-wrapper': [box(75, 166), box(75, 166), box(636, 748)],
    });
    const a = measureTitleAnchor(scope, 90);
    expect(a).not.toBeNull();
    // bottom edge = board top (259) - 10px gap, expressed as CSS `bottom`.
    expect(a!.bottomPx).toBe(844 - 249);
    // band = 259 - 166 - 20 = 73 < 90 -> scaled to fit, never onto the seats.
    expect(a!.scale).toBeCloseTo(73 / 90, 5);
    vi.unstubAllGlobals();
  });

  it('does not scale when the band is tall enough', () => {
    vi.stubGlobal('innerHeight', 1000);
    const scope = scopeWith({
      '.pot-display': [box(400, 430)],
      '.community-area': [box(420, 520)],
      '.seat-wrapper': [box(100, 200)],
    });
    const a = measureTitleAnchor(scope, 90);
    expect(a!.scale).toBe(1);
    expect(a!.bottomPx).toBe(1000 - 390);
    vi.unstubAllGlobals();
  });

  it('never scales below the floor, and ignores seats below the pot', () => {
    vi.stubGlobal('innerHeight', 800);
    // Laptop: seats end at 213, pot at 279 -> 46px band for a 90px block.
    const scope = scopeWith({
      '.pot-display': [box(279, 310)],
      '.community-area': [box(303, 400)],
      '.seat-wrapper': [box(113, 213), box(215, 315), box(558, 660)],
    });
    const a = measureTitleAnchor(scope, 90);
    expect(a!.scale).toBeCloseTo(Math.max(0.62, 46 / 90), 5);
    vi.unstubAllGlobals();
  });

  it('returns null when there is nothing painted to measure (fallback position)', () => {
    vi.stubGlobal('innerHeight', 844);
    expect(measureTitleAnchor(scopeWith({}), 90)).toBeNull();
    // A hidden multi-table sibling has zero-size boxes: not an anchor.
    expect(
      measureTitleAnchor(scopeWith({ '.pot-display': [box(0, 0, 0)], '.community-area': [] }), 90)
    ).toBeNull();
    vi.unstubAllGlobals();
  });
});
