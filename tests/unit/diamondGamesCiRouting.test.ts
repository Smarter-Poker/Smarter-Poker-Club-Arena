import { describe, expect, it } from 'vitest';
import { classifyChangedPaths } from '../../scripts/ci/classify-ci-changes.mjs';

// These paths are inputs to the real CI classifier. Keep their behavioral
// assertions separate from tests that read workflow YAML as an artifact.
describe('Diamond Games retain their financial PostgreSQL qualification', () => {
  it.each([
    'tests/sql/diamond-games-funding-identity.sql',
    'tests/sql/diamond-games-bank-fallback.sql',
    'tests/sql/diamond-plinko-denominations.sql',
    'tests/sql/diamond-crash-clicked-multiplier.sql',
    'tests/sql/diamond-spins-claimed-daily-bonus.sql',
    'tests/fixtures/accounting-delivery/diamond-games/functions.sql',
    'src/services/DiamondBonusService.ts',
    'src/services/DiamondGamesService.ts',
    'src/services/DiamondChoiceService.ts',
    'src/services/diamondBonusRecovery.ts',
    'src/utils/crashReceipt.ts',
    'src/pages/DiamondChoicePage.tsx',
    'src/pages/DiamondCrashPage.tsx',
    'src/pages/DiamondPlinkoPage.tsx',
  ])('admits the accounting job for %s', (path) => {
    expect(classifyChangedPaths([path]).server).toBe(true);
    expect(classifyChangedPaths([path]).tests).toBe(true);
  });

  it.each([
    'tests/e2e/css/diamond-games-playfield.spec.ts',
    'tests/e2e/helpers/diamond-games-fixture.mjs',
  ])('runs the actual browser fixture when %s changes', (path) => {
    expect(classifyChangedPaths([path]).src).toBe(true);
  });

  it('preserves unrelated UI and documentation classification', () => {
    expect(classifyChangedPaths(['src/components/games/ChoiceScene.tsx']).server).toBe(false);
    expect(classifyChangedPaths(['docs/changelog/example.md']).server).toBe(false);
  });
});
