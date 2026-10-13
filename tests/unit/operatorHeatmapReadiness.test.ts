import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
const source = readFileSync('tests/e2e/routes/operator-read-observers.spec.ts', 'utf8');
describe('visible heatmap certification prerequisites', () => {
  it('foregrounds the observer and verifies visible online state before requiring repeated reads', () => {
    expect(source).toContain('test.setTimeout(150_000)');
    const front = source.indexOf('await page.bringToFront()');
    const ready = source.indexOf('visibility: document.visibilityState, online: navigator.onLine');
    const verdict = source.indexOf(".toEqual({ visibility: 'visible', online: true })");
    const repeated = source.indexOf('toBeGreaterThanOrEqual(2)');
    expect(front).toBeGreaterThan(-1);
    expect(ready).toBeGreaterThan(front);
    expect(verdict).toBeGreaterThan(ready);
    expect(repeated).toBeGreaterThan(verdict);
  });
  it('preserves authoritative scoped reads and refuses missing refreshes', () => {
    expect(source).toContain('timeout: 45_000');
    expect(source).toContain('expect(response.status()).toBe(200)');
    expect(source).toContain("expect(url.searchParams.get('is_deleted')).toBe('eq.false')");
    expect(source).not.toMatch(/waitForTimeout|Object\.defineProperty|dispatchEvent|catch\(/);
    expect(source).toContain('Table Activity Could Not Be Refreshed.');
  });
});
