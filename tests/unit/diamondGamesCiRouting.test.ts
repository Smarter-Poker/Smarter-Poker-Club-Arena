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
    'tests/sql/diamond-wheel-funded-awards.sql',
    'tests/sql/diamond-wheel-upgrade-eight.sql',
    'tests/sql/diamond-bonus-minimum-wins.sql',
    'tests/sql/diamond-bonus-replays.sql',
    'supabase/migrations/20260919153418_public_bonus_replay_has_an_explicitly_public_reader.sql',
    'tests/fixtures/accounting-delivery/diamond-games/replay-public-guard-dependencies.sql',
    'tests/sql/diamond-daily-custody.sql',
    'tests/fixtures/accounting-delivery/diamond-games/replay-social-dependencies.sql',
    'tests/fixtures/accounting-delivery/diamond-games/daily-custody-dependencies.sql',
    'src/services/DiamondReplayService.ts',
    'src/services/DiamondStatementService.ts',
    'tests/fixtures/diamond-spins/wheel-v3-postgres-receipts.json',
    'tests/unit/wheelUpgradePostgresContract.test.ts',
    'tests/unit/wheelUpgradeReceipts.test.ts',
    'tests/fixtures/diamond-wheel-v2-receipts.json',
    'tests/fixtures/diamond-spins/wheel-earned-postgres-receipts.json',
    'tests/unit/wheelServerReceipts.test.ts',
    'tests/unit/wheelEarnedPostgresContract.test.ts',
    'src/services/DiamondWheelService.ts',
    'src/services/WheelBonusEntryService.ts',
    'src/hooks/useEarnedBonus.ts',
    'src/hooks/useBonusBudget.ts',
    'src/components/games/BonusSetup.tsx',
    'src/utils/bonusGameBudget.ts',
    'src/utils/wheelAward.ts',
    'src/utils/wheelPendingSpin.ts',
    'src/utils/wheelFairness.ts',
    'src/pages/DiamondWheelPage.tsx',
  ])('admits the accounting job for %s', (path) => {
    expect(classifyChangedPaths([path]).server).toBe(true);
    expect(classifyChangedPaths([path]).tests).toBe(true);
  });

  it.each([
    'tests/e2e/css/diamond-games-playfield.spec.ts',
    'tests/e2e/helpers/diamond-games-fixture.mjs',
    'tests/e2e/css/diamond-wheel-reveal.spec.ts',
    'tests/e2e/helpers/diamond-wheel-fixture.mjs',
    'src/components/games/gpuFrameRenderer.ts',
    'src/components/games/sceneKit.ts',
    'src/components/games/ChoiceScene.tsx',
    'src/components/plinko/PlinkoBoard.tsx',
    'src/components/crash/CrashCurve.tsx',
  ])('runs the actual browser fixture when %s changes', (path) => {
    expect(classifyChangedPaths([path]).src).toBe(true);
  });

  it('preserves unrelated UI and documentation classification', () => {
    expect(classifyChangedPaths(['src/components/games/ChoiceScene.tsx']).server).toBe(false);
    expect(classifyChangedPaths(['docs/changelog/example.md']).server).toBe(false);
  });
});
