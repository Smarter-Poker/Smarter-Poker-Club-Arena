import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { classifyChangedPaths } from '../../scripts/ci/classify-ci-changes.mjs';
it.each([
  'src/components/wallet/CashoutRequestModal.tsx',
  'src/components/agent/AgentCashoutPanel.tsx',
  'src/pages/CashierPage.tsx',
  'src/services/CashoutService.ts',
  'tests/fixtures/cashier-realtime-lifecycle/native.mjs',
])('requires native fixture qualification for %s', (path) => {
  expect(classifyChangedPaths([path]).fixture).toBe(true);
});
it('runs the checked cashier lifecycle before the native image is removed', () => {
  const source = readFileSync('operations/release/ci/fixture-smoke.py', 'utf8');
  const run = source.indexOf(
    "run(['python3', 'tests/fixtures/cashier-realtime-lifecycle/run-native.py'"
  );
  expect(run).toBeGreaterThan(0);
  expect(run).toBeLessThan(source.indexOf("['docker', 'image', 'rm', tag]"));
  expect(source.slice(run, run + 180)).toContain('timeout=600');
});
