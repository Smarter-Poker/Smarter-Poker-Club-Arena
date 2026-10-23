import { expect, it } from 'vitest';
import { classifyChangedPaths } from '../../scripts/ci/classify-ci-changes.mjs';
it.each([
  'src/components/wallet/CashoutRequestModal.tsx',
  'src/components/wallet/CashoutReceiptChecks.tsx',
  'src/components/agent/AgentCashoutPanel.tsx',
  'src/pages/CashierPage.tsx',
  'src/services/CashoutService.ts',
  'src/services/CashoutOperation.ts',
  'src/pages/CashierTradePage.tsx',
  'src/hooks/useCashoutScope.ts',
  'src/hooks/usePreparedCashoutOperations.ts',
  'src/hooks/useMasterBusChannel.ts',
  'src/lib/subscribeRealtime.ts',
  'src/lib/realtimeAdmission.ts',
  'src/lib/supabase.ts',
  'src/core/MasterBus.ts',
  'src/core/IdentityDNA.ts',
  'src/utils/settlementLock.ts',
  'tests/fixtures/cashier-realtime-lifecycle/native.mjs',
])('requires native fixture qualification for %s', (path) => {
  expect(classifyChangedPaths([path]).fixture).toBe(true);
});
