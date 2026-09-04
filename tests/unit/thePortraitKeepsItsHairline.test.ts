/**
 * THE PORTRAIT'S 0.5px HAIRLINE, ON BOTH PATHS.
 *
 * Dan, 2026-09-03: "THE FRAME IN THE GLOBAL HEADER AROUND THE PROFILE IMAGE
 * REGRESSED AND CHANGED (INSTEAD OF HAVING THE .50 PIXEL BLACK INVISIBLE
 * CIRCLE FRAME)."
 *
 * The edge has been 0.5px since #2366, narrowed from 1px for a reason: the
 * baked artwork's aperture and the photo are two circles that never agree to
 * the pixel, and without a hairline the seam reads as a ragged edge. #2674's
 * mobile pass set the base rule to `border: 0` while the desktop override kept
 * its own copy - so the frame survived on a laptop and vanished on a phone.
 * Measured live before the fix: `border: 0px none` on the rendered slot.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CSS = readFileSync(
  join(process.cwd(), 'src/components/navigation/GlobalHeader.module.css'),
  'utf8'
);
const HAIRLINE = /border:\s*0\.5px\s+solid\s+rgba\(0,\s*0,\s*0,\s*0\.94\)/;

/** Every `.profileAvatarSlot { ... }` block in the file, base and overrides. */
function slotBlocks(): string[] {
  const out: string[] = [];
  const re = /\.profileAvatarSlot\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(CSS))) out.push(CSS.slice(m.index, CSS.indexOf('}', m.index)));
  return out;
}

describe('the portrait keeps its hairline', () => {
  it('the base rule carries the 0.5px edge, not border: 0', () => {
    const base = slotBlocks()[0];
    expect(base, '.profileAvatarSlot must exist').toBeTruthy();
    expect(base).toMatch(HAIRLINE);
    expect(base, 'border: 0 is the regression Dan reported').not.toMatch(/border:\s*0;/);
  });

  it('every .profileAvatarSlot rule that sets a border sets the same one', () => {
    // The desktop override restates it because it also moves and resizes the
    // slot. What must never happen again is the two paths disagreeing.
    const withBorder = slotBlocks().filter((b) => /border:/.test(b));
    expect(withBorder.length).toBeGreaterThanOrEqual(2);
    for (const b of withBorder) expect(b).toMatch(HAIRLINE);
  });

  it('it is half a pixel, not one - the 1px edge was too heavy (#2366)', () => {
    for (const b of slotBlocks().filter((x) => /border:/.test(x))) {
      expect(b).not.toMatch(/border:\s*1px/);
    }
  });

  it('and it is still a circle', () => {
    expect(slotBlocks()[0]).toMatch(/border-radius:\s*50%/);
  });
});
