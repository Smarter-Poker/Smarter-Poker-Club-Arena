/**
 * THE SEAT CHANGE BUTTON IS ON THE LEFT (Dan 2026-10-14): "THE 'SEAT CHANGE'
 * BUTTON SHOULD NEVER BE IN THE UPPER RIGHT HAND CORNER, IT SHOULD BE ON THE
 * LEFT SIDE."
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PAGE = readFileSync(resolve(__dirname, '../../src/pages/TablePage.tsx'), 'utf8');
const CSS = readFileSync(resolve(__dirname, '../../src/components/table/TableHUD.css'), 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  ''
);

describe('seat change dock', () => {
  it('wraps the cash must-move box', () => {
    const dock = PAGE.indexOf('<div className="hud-seat-change-dock">');
    const hud = PAGE.indexOf('<CashClusterHUD', dock);
    expect(dock).toBeGreaterThan(0);
    expect(hud - dock).toBeLessThan(80);
  });

  it('is pinned to the left edge, never the right', () => {
    const at = CSS.indexOf('.hud-seat-change-dock {');
    const rule = CSS.slice(at, CSS.indexOf('}', at));
    expect(at).toBeGreaterThanOrEqual(0);
    expect(rule).toMatch(/position:\s*fixed/);
    expect(rule).toMatch(/left:\s*6px/);
    expect(rule).toMatch(/right:\s*auto/);
  });
});
