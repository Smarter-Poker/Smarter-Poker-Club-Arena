/**
 * THE MINIMIZED MAINTENANCE PILL LIVES AT THE BOTTOM OF THE PAGE
 * (Dan 2026-09-23, screenshot of it sitting in the iPhone status bar):
 * "THE 'MAINTENANCE BREAK' CAN NEVER BE DISPLAYED ABOVE THE ACTION BAR. IT
 * SHOULD ALWAYS BE AT THE BOTTOM OF THE PAGE."
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const CSS = readFileSync(
  resolve(__dirname, '../../src/components/table/MaintenanceBreakScreen.css'),
  'utf8'
).replace(/\/\*[\s\S]*?\*\//g, '');

describe('.maintenance-break__minimized', () => {
  const at = CSS.indexOf('.maintenance-break__minimized {');
  const rule = CSS.slice(at, CSS.indexOf('}', at));

  it('hangs from the bottom edge, clear of the action bar the hero still acts on', () => {
    // The screen is visible during `last_hand` and `resuming`, when a hand is
    // live: the pill stands above `--sp-action-reserve` (bar plus inset), not
    // inside the inset on top of the Call button (2026-09-24).
    expect(at).toBeGreaterThanOrEqual(0);
    expect(rule).toMatch(/position:\s*fixed/);
    expect(rule).toMatch(
      /bottom:\s*calc\(\s*var\(--sp-action-reserve,\s*calc\(96px \+ env\(safe-area-inset-bottom, 0px\)\)\)\s*\+\s*\d+px\s*\)/
    );
  });

  it('is never pinned to the top of the page again', () => {
    expect(rule).not.toMatch(/(^|[^-])top:/);
  });
});
