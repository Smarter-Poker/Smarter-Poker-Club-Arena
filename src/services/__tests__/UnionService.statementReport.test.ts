import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn() }));
vi.mock('../../lib/supabase', () => ({ supabase: mocks }));
vi.mock('../../core/MasterBus', () => ({ masterBus: {} }));
vi.mock('../UnionApiService', () => ({ unionApi: {} }));
vi.mock('../../utils/clubIdResolver', () => ({ resolveClubUUID: vi.fn() }));
vi.mock('../../lib/constants', () => ({ QUERY_LIMITS: {} }));
vi.mock('../../utils/errorReporter', () => ({ reportError: vi.fn() }));
import UnionService from '../UnionService';

const board = { union_id: 'union-a', period_start: '2026-08-31', period_end: '2026-09-07', clubs: [] };
beforeEach(() => { vi.clearAllMocks(); mocks.rpc.mockResolvedValue({ data: board, error: null }); });
describe('union statement source', () => {
  it('requests the complete authoritative board without reading rolling club rake', async () => {
    await UnionService.getSettlementReport('union-a');
    expect(mocks.rpc).toHaveBeenCalledWith('ca_union_statement_board', { p_union_id: 'union-a', p_period_end: null, p_history: 1 });
    expect(mocks.from).not.toHaveBeenCalled();
  });
  it('resolves a period id with union scope before requesting its dates', async () => {
    const query = { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), single: vi.fn().mockResolvedValue({ data: { start_at: '2026-08-31', end_at: '2026-09-07' }, error: null }) };
    mocks.from.mockReturnValue(query);
    await UnionService.getSettlementReportForPeriod('union-a', 'period-id');
    expect(query.eq).toHaveBeenCalledWith('id', 'period-id');
    expect(query.eq).toHaveBeenCalledWith('union_id', 'union-a');
    expect(mocks.rpc).toHaveBeenCalledWith('ca_union_statement_board', { p_union_id: 'union-a', p_period_end: '2026-09-07', p_history: 1 });
  });
  it('refuses partial or mismatched date ranges and surfaces RPC failures', async () => {
    await expect(UnionService.getSettlementReport('union-a', 'period-id')).rejects.toThrow();
    await expect(UnionService.getSettlementReport('union-a', '2026-08-30', '2026-09-07')).rejects.toThrow();
    mocks.rpc.mockResolvedValue({ data: null, error: new Error('access denied') });
    await expect(UnionService.getSettlementReport('union-a')).rejects.toThrow('access denied');
  });
});
