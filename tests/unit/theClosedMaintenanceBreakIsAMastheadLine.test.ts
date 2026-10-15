/**
 * THE CLOSED MAINTENANCE BREAK LIVES IN THE MASTHEAD, UNDER THE BOMB POT CLOCK
 * (Dan 2026-10-14, screenshot of the pill under the hero): "THIS NEEDS TO
 * APPEAR BELOW 'BOMB POT IN 2:47' NOT UNDER THE HERO." Supersedes the
 * 2026-09-23 bottom-of-page pill.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (p: string) => readFileSync(resolve(__dirname, '../../', p), 'utf8');
const PAGE = read('src/pages/TablePage.tsx');
const SCREEN = read('src/components/table/MaintenanceBreakScreen.tsx');
const SCREEN_CSS = read('src/components/table/MaintenanceBreakScreen.css').replace(
  /\/\*[\s\S]*?\*\//g,
  ''
);

describe('closed maintenance break', () => {
  it('renders the masthead line right after the bomb pot line', () => {
    const bomb = PAGE.indexOf('table-brand__line table-brand__line--bomb${');
    const line = PAGE.indexOf('<MaintenanceBreakLine');
    const kill = PAGE.indexOf('{tableState.killNext && (');
    expect(bomb).toBeGreaterThan(0);
    expect(line).toBeGreaterThan(bomb);
    expect(kill).toBeGreaterThan(line);
  });

  it('is a table-brand line, so it shares the bomb clock column', () => {
    expect(SCREEN).toMatch(/className="table-brand__line table-brand__line--bomb table-brand__line--maintenance"/);
  });

  it('never draws a floating pill of its own again', () => {
    expect(SCREEN).not.toMatch(/maintenance-break__minimized/);
    expect(SCREEN_CSS).not.toMatch(/maintenance-break__minimized/);
    expect(SCREEN).toMatch(/if \(minimized\) return null;/);
  });
});
