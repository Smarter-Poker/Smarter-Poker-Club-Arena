/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  A WHEEL BELONGS TO ITS OWN TABLE — LAW (2026-09-01)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * `.sw` is `position: fixed; inset: 0; z-index: 99997; pointer-events: auto`.
 * That is correct for a single table and wrong for tile view: a Spin firing on
 * one table painted over ALL FOUR and swallowed their input for the entire
 * hold — roughly fifteen seconds. You could be timed out on a table you could
 * not see, behind a wheel you were not watching, and you could not even click
 * the tile to bring it forward because the overlay ate the click.
 *
 * THE FIX IS SCOPING, NOT SUPPRESSION, and that distinction is the law.
 * CLAUDE.md 10.6: an animation plays every time it is owed, for its full
 * duration. The draw is owed on ITS table. Hiding it on an inactive tile would
 * trade one bug for a worse one — a player who switches to that tile after the
 * shared clock has run finds the moment their format exists for already gone.
 *
 * So the wheel keeps playing and stops escaping. `scoped` swaps fixed for
 * absolute, `.multi-table-grid__stage` clips it, and `captureInput` lets the
 * click that SELECTS a tile through to the cell underneath — the player moves
 * their own view, the same principle as the no-auto-switch law.
 *
 * If a pin below goes red, read which one: making the wheel disappear on an
 * inactive tile passes the "does not cover other tiles" test and breaks 10.6.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

describe('a wheel belongs to its own table', () => {
  const wheel = read('src/components/tournament/SpinWheel.tsx');
  const css = read('src/components/tournament/SpinWheel.css');
  const table = read('src/pages/TablePage.tsx');

  it('is scoped to its tile in multi-table view', () => {
    expect(table).toContain('scoped={isMultiTable}');
    expect(wheel).toContain("scoped ? ' sw--scoped' : ''");
    // Absolute, so the tile's own stacking and clipping contain it.
    expect(css).toMatch(/\.sw--scoped\s*\{[^}]*position:\s*absolute/);
  });

  it('drops to a local z-index inside a tile rather than the viewport-level one', () => {
    // 99997 inside a tile is an invitation to escape it again later.
    expect(css).toMatch(/\.sw--scoped\s*\{[^}]*z-index:\s*(\d{1,3})\s*;/);
    const zi = Number(/\.sw--scoped\s*\{[^}]*z-index:\s*(\d+)\s*;/.exec(css)?.[1] ?? '999999');
    expect(zi).toBeLessThan(1000);
  });

  it('lets the click that selects an inactive tile through', () => {
    expect(table).toContain('captureInput={!isMultiTable || isActive}');
    expect(wheel).toContain("captureInput ? '' : ' sw--passthrough'");
    expect(css).toMatch(/\.sw--passthrough[^{]*\{[^}]*pointer-events:\s*none/);
  });

  it('STILL PLAYS on an inactive tile - scoping is not suppression', () => {
    // The draw is owed on its own table (CLAUDE.md 10.6). Nothing may gate the
    // component's mount, its data or its sequence on being the active tile.
    expect(table).not.toMatch(/<SpinWheel[\s\S]{0,400}?data=\{isActive/);
    expect(table).not.toMatch(/isActive\s*&&[\s\S]{0,40}<SpinWheel/);
    expect(wheel).not.toContain('if (!captureInput) return null');
    expect(wheel).not.toContain('if (scoped && !captureInput) return null');
  });
});
