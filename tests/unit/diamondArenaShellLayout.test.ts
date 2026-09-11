/**
 * The Diamond shell keeps its own single-column layout at every width.
 *
 * It reuses `.club-home` for the black stage and the bottom clearance, and
 * that class also carries the chip lobby's desktop grid and its mobile
 * full-bleed offset (`width: 100vw; margin-left: calc(50% - 50vw)`), which the
 * unified mobile lobby resets for itself. The Diamond placeholder inherited
 * both: on desktop its lines were auto-placed across the grid, and on a
 * viewport at or under 900px with a classic scrollbar it rendered 4px
 * off-canvas with no gutter (authenticated Diamond routes, 2026-09-11). These
 * pins keep the override present and specific enough to win over `.club-home`.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CSS = readFileSync(
  join(__dirname, '..', '..', 'src/components/arena/DiamondArenaShell.css'),
  'utf8'
);

function block(selector: string, source: string): string {
  const escaped = selector.replace(/[.]/g, '\\.');
  const match = source.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  expect(match, `${selector} declares nothing`).not.toBeNull();
  return match![1];
}

describe('Diamond arena shell layout', () => {
  it('lays the shell out as one padded column instead of the chip lobby grid', () => {
    const rules = block('.club-home.diamond-arena-shell', CSS);
    expect(rules).toMatch(/display:\s*flex/);
    expect(rules).toMatch(/flex-direction:\s*column/);
    expect(rules).toMatch(/margin-left:\s*0/);
    expect(rules).toMatch(/width:\s*100%/);
    expect(rules).toMatch(/padding:\s*\d+px\s+1[2-9]px/);
    expect(rules).not.toMatch(/100vw/);
  });

  it('keeps the override where .club-home goes full bleed on narrow viewports', () => {
    const mobile = CSS.match(/@media \(max-width: 900px\) \{([\s\S]*?)\n\}/);
    expect(mobile, 'no 900px block').not.toBeNull();
    const rules = block('.club-home.diamond-arena-shell', mobile![1]);
    expect(rules).toMatch(/margin-left:\s*0/);
    expect(rules).toMatch(/width:\s*100%/);
    expect(rules).toMatch(/padding:\s*\d+px\s+1[2-9]px/);
    expect(rules).not.toMatch(/100vw/);
  });
});
