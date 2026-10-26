import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('keeps player requests and agent decisions independent of settlement admission', () => {
  for (const path of [
    'src/components/agent/AgentCashoutPanel.tsx',
    'src/components/wallet/CashoutRequestModal.tsx',
  ]) {
    const source = readFileSync(path, 'utf8');
    expect(source).not.toContain('checkSettlementLock');
    expect(source).toContain('recoverCashoutOperation(');
    expect(source).toContain('assertCashoutStartCurrent(');
    expect(source).toContain('runCashoutOperation(');
  }
  const cashier = readFileSync('src/pages/CashierPage.tsx', 'utf8');
  const submit = cashier.slice(
    cashier.indexOf('const submitCashout ='),
    cashier.indexOf('const handleAction =')
  );
  expect(submit).not.toContain('checkSettlementLock');
  expect(cashier).toContain("if (clubId && action !== 'cashout')");
  for (const source of [
    cashier,
    readFileSync('src/components/agent/AgentCashoutPanel.tsx', 'utf8'),
    readFileSync('src/components/wallet/CashoutRequestModal.tsx', 'utf8'),
  ])
    expect(source).not.toMatch(/Cashout (?:Actions|Requests) Are Frozen/);
});
