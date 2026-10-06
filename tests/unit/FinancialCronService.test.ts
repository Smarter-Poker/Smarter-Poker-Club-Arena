/**
 * Retirement ratchet for the browser-owned financial cron.
 *
 * Estate-wide credit enforcement cannot be owned by an arbitrary signed-in
 * browser tab. The live Financial Health console therefore reports the absent
 * server authority honestly and exposes no Run Now mutation.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '../..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');
const retiredService = resolve(root, 'src/services/FinancialCronService.ts');

describe('browser financial cron retirement', () => {
  it('keeps the unscoped browser service deleted', () => {
    expect(() => readFileSync(retiredService, 'utf8')).toThrow();
  });

  it('keeps browser bootstrap free of a financial scheduler or global credit scan', () => {
    const boot = read('src/services/ServiceBootstrap.ts');
    expect(boot).not.toMatch(/import[^;]*FinancialCronService/);
    expect(boot).not.toMatch(/\.runSuspensionCheck\s*\(/);
    expect(boot).not.toMatch(/from\(['"]agents['"]\)/);
  });

  it('keeps the live Financial Health console read-only about missing credit authority', () => {
    const page = read('src/pages/FinancialHealthPage.tsx');
    expect(page).not.toContain('FinancialCronService');
    expect(page).not.toMatch(/\.runSuspensionCheck\s*\(/);
    expect(page).not.toMatch(/\.runReconciliation\s*\(/);
    expect(page).not.toMatch(/Run Now/);
    expect(page).toMatch(/global browser scan/i);
    expect(page).toMatch(/unavailable/i);
  });
});
