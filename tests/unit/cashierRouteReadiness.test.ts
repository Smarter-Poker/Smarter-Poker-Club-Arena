import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync('tests/e2e/routes/club-operations-exhaustive.spec.ts', 'utf8');

describe('Cashier route readiness before Advanced navigation certification', () => {
  it('uses the existing route budget for the positive Cashier Simple marker only', () => {
    expect(source).toContain("operation.id === 'cashier' ? { timeout: 30_000 } : {}");
    expect(source).toContain("if (operation.id === 'cashier') test.setTimeout(120_000)");
    const caseBudget = source.indexOf("if (operation.id === 'cashier') test.setTimeout(120_000)");
    const ready = source.indexOf('const simpleReadyOptions');
    expect(caseBudget).toBeLessThan(ready);
    const simple = source.indexOf('toBeVisible(simpleReadyOptions)', ready);
    const advancedClick = source.indexOf("name: 'Advanced', exact: true", simple);
    const advancedMarker = source.indexOf('modeAttribute}="advanced"', advancedClick);
    const originalNav = source.indexOf("name: 'Club Operations Sections'", advancedMarker);
    expect(ready).toBeGreaterThan(-1);
    expect(simple).toBeGreaterThan(ready);
    expect(advancedClick).toBeGreaterThan(simple);
    expect(advancedMarker).toBeGreaterThan(advancedClick);
    expect(originalNav).toBeGreaterThan(advancedMarker);
  });

  it('still refuses a missing Simple marker and retains content and permission checks', () => {
    const start = source.indexOf('if (modeAttribute)');
    const end = source.indexOf('operation.marker', start);
    const branch = source.slice(start, end);
    expect(branch).not.toMatch(/catch|test\.skip|waitForTimeout|isVisible\(/);
    expect(branch).toContain('await expect(page.locator');
    expect(source).toContain('This Surface Could Not Load');
    expect(source).toContain('This Tool Is Restricted');
    expect(source).toContain('Club Operations Is Restricted');
    expect(source).toContain('Financials Are Restricted');
  });
});
