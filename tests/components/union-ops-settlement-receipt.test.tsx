import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), success: vi.fn(), error: vi.fn() }));
vi.mock('../../src/lib/supabase', () => ({ supabase: { rpc: mocks.rpc } }));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
vi.mock('../../src/components/common/Toast', () => ({ useToast: () => mocks }));
import UnionOpsPanel from '../../src/components/union/UnionOpsPanel';
import { UnionOpsService } from '../../src/services/UnionOpsService';

const UNION_ID = '33333333-3333-4333-8333-333333333333';

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(UnionOpsService, 'getCoverageStrict').mockResolvedValue(null!);
  vi.spyOn(UnionOpsService, 'getAgentRisk').mockResolvedValue([]);
  vi.spyOn(UnionOpsService, 'getSettlementRounds').mockResolvedValue([]);
  vi.spyOn(UnionOpsService, 'getDistributionCheck').mockResolvedValue(null);
  vi.spyOn(UnionOpsService, 'getLawSelfTest').mockResolvedValue(null);
  vi.spyOn(UnionOpsService, 'getSettlementPreview').mockResolvedValue({
    union_id: UNION_ID,
    period_start: '2026-09-07',
    period_end: '2026-09-14',
    round1: { already_executed: true, rake_treasury_available: 100 },
    round2: { payees: 1, amount: 10, clubs_short: 0, short_by: 0, detail: [] },
    round3: { payees: 1, amount: 5, agents_short: 0, short_by: 0, detail: [] },
    total_to_move: 15,
    has_blockers: false,
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function confirmSettlement(data: unknown) {
  mocks.rpc.mockResolvedValue({ data, error: null });
  render(<UnionOpsPanel unionId={UNION_ID} canRun />);
  fireEvent.click(await screen.findByRole('button', { name: /^Settlement$/ }));
  fireEvent.click(await screen.findByRole('button', { name: 'Review & Run Settlement' }));
  fireEvent.click(await screen.findByRole('button', { name: /^Settle 15$/ }));
}

describe('union settlement completion message through the real service', () => {
  it.each([{ success: false, error: 'recipient_shortfalls_remaining' }, null])(
    'shows an error and never reports success for an incomplete or unknown receipt',
    async (data) => {
      await confirmSettlement(data);
      await waitFor(() => expect(mocks.error).toHaveBeenCalledTimes(1));
      expect(mocks.success).not.toHaveBeenCalled();
      expect(mocks.rpc).toHaveBeenCalledTimes(1);
    }
  );

  it('reports the verified amounts only after an explicit completion', async () => {
    await confirmSettlement({
      success: true,
      union_id: UNION_ID,
      round2_club_to_agents: { amount: 10, shortfalls: 0 },
      round3_agents_to_players: { amount: 5, shortfalls: 0 },
    });
    await waitFor(() =>
      expect(mocks.success).toHaveBeenCalledWith('Settled: clubs to agents 10, agents to players 5')
    );
    expect(mocks.error).not.toHaveBeenCalled();
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    expect(mocks.rpc).toHaveBeenCalledWith(
      'fn_union_settlement_cascade',
      expect.objectContaining({ p_union_id: UNION_ID })
    );
  });
});
