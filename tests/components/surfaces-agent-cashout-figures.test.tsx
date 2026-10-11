/**
 * THE AGENT DESK PRINTS THE EXACT AMOUNT, WHOLE OR TO TWO PLACES (launch audit
 * R-10 and D-19, round 2, 2026-10-09). The amount on an approval row is the
 * figure about to move into the agent wallet, so it is never abbreviated; but
 * `toLocaleString()` alone printed 18,400.50 as "18,400.5", which is neither.
 * Harness: tests/components/agent-cashout-scope.test.tsx.
 */
import { readFileSync } from 'node:fs';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('../../src/hooks/useAuthUser', () => ({
  useAuthUser: () => ({ user: { id: 'cashier-a' } }),
}));
vi.mock('../../src/services/CashoutService', () => ({
  captureCashoutAccountGuard: () => () => true,
  cashoutService: {
    getAgentPendingCashouts: (...args: unknown[]) => state.read(...args),
  },
}));
vi.mock('../../src/services/CashoutOperation', () => ({
  prepareCashoutOperation: async (intent: unknown) => intent,
  captureCashoutStart: (intent: unknown) => intent,
  assertCashoutStartCurrent: () => {},
  captureCashoutReceiptCheck: (original: unknown) => original,
  recoverCashoutOperation: async () => ({ found: false }),
  runCashoutOperation: async () => true,
}));
vi.mock('../../src/utils/settlementLock', () => ({
  checkSettlementLock: async () => ({ locked: false }),
}));
vi.mock('../../src/utils/clubIdResolver', () => ({ resolveClubUUID: async (id: string) => id }));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
vi.mock('../../src/lib/date', () => ({ formatRelativeShort: () => '8h ago' }));
vi.mock('../../src/core/MasterBus', () => ({
  masterBus: {
    subscribe: () => () => {},
    subscribeDebounced: () => () => {},
    removeRegisteredChannel: vi.fn(),
    getOrCreateChannel: () => {
      const c = { on: () => c, subscribe: vi.fn() };
      return c;
    },
  },
}));
import AgentCashoutPanel from '../../src/components/agent/AgentCashoutPanel';

const row = (id: string, amount: number) => ({
  id,
  playerId: 'player-a',
  agentId: 'cashier-a',
  clubId: 'club-a',
  amount,
  status: 'pending' as const,
  playerName: id,
  createdAt: '2026-09-15T00:00:00Z',
});
const cents = (n: number) =>
  n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

beforeEach(() => {
  state.read.mockReset().mockResolvedValue([row('Fractional', 18400.5), row('Whole', 18400)]);
});
afterEach(cleanup);

it('prints a fractional request to two places, a whole one whole, and the age in Title Case', async () => {
  render(<AgentCashoutPanel clubId="club-a" />);
  await screen.findByText('Fractional');
  const figures = Array.from(document.querySelectorAll('.acp-amount-value')).map(
    (el) => el.textContent
  );
  expect(figures).toEqual([cents(18400.5), (18400).toLocaleString()]);
  expect(document.body.textContent).not.toContain(`${(18400.5).toLocaleString()}Chips`);
  expect(screen.getAllByText('8h Ago')).toHaveLength(2);
});

it('keeps even the fallback load error in Title Case (launch audit D-19)', () => {
  const src = readFileSync('src/components/agent/AgentCashoutPanel.tsx', 'utf8');
  expect(src).not.toContain("'Failed to load cashout requests'");
  expect(src).toContain("safeErrorMessage(err, 'Failed To Load Cashout Requests')");
});
