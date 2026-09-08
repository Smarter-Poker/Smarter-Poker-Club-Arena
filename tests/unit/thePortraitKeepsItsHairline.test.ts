/**
 * THE PORTRAIT'S 0.5px HAIRLINE - ONE DECLARATION, ONE PLACE.
 *
 * Dan, 2026-09-03: "THE FRAME IN THE GLOBAL HEADER AROUND THE PROFILE IMAGE
 * REGRESSED AND CHANGED (INSTEAD OF HAVING THE .50 PIXEL BLACK INVISIBLE
 * CIRCLE FRAME)." Dan, 2026-09-07: "the profile pic is supposed to be a .5
 * pixel black frame that 'appears invisible'".
 *
 * UPDATED 2026-09-07. This file used to require the hairline in AT LEAST two
 * `.profileAvatarSlot` rules (base + desktop) and that they agree. Two copies
 * is how it regressed in the first place (#2674 zeroed one and left the
 * other), so the contract is now the opposite: the base rule declares it,
 * nothing else does, and the desktop override inherits it. The full law - the
 * black disc that masks the baked ring, by arithmetic - is
 * tests/the-header-portrait-frame-is-a-hairline.law.test.ts; the rendered
 * proof is tests/e2e/header-portrait-frame.spec.ts.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CSS = readFileSync(
  join(process.cwd(), 'src/components/navigation/GlobalHeader.module.css'),
  'utf8'
).replace(/\/\*[\s\S]*?\*\//g, '');
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

  it('no other .profileAvatarSlot rule declares a border - the override inherits, so the two paths cannot disagree', () => {
    const withBorder = slotBlocks().filter((b) => /(^|[\s;])border(-\w+)?\s*:/.test(b));
    expect(withBorder.length).toBe(1);
    expect(withBorder[0]).toMatch(HAIRLINE);
  });

  it('it is half a pixel, not one - the 1px edge was too heavy (#2366)', () => {
    for (const b of slotBlocks()) expect(b).not.toMatch(/border:\s*1px/);
  });

  it('and it is still a circle', () => {
    expect(slotBlocks()[0]).toMatch(/border-radius:\s*50%/);
  });
});
