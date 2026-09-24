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

  it('hangs from the bottom edge, inside the home-indicator inset', () => {
    expect(at).toBeGreaterThanOrEqual(0);
    expect(rule).toMatch(/position:\s*fixed/);
    expect(rule).toMatch(/bottom:\s*calc\(env\(safe-area-inset-bottom, 0px\) \+ \d+px\)/);
  });

  it('is never pinned to the top of the page again', () => {
    expect(rule).not.toMatch(/(^|[^-])top:/);
  });
});
