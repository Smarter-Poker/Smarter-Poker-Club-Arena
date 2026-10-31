import { afterEach, describe, expect, it, vi } from 'vitest';
import { TournamentManager } from './TournamentManager.js';
import { supabase } from '../services/supabase.js';
function harness() {
  const claim = vi.fn(async () => ({ data: { state: 'announcement_owned' }, error: null }));
  const ack = vi.fn(async (): Promise<any> => ({ data: true, error: null }));
  const query: any = {
    select: () => query,
    eq: () => query,
    then: (resolve: any) => Promise.resolve({ count: 9, error: null }).then(resolve),
  };
  vi.spyOn(supabase, 'from').mockReturnValue(query);
  vi.spyOn(supabase, 'rpc').mockImplementation(((name: string) => {
    if (name === 'fn_claim_final_table_transition') return { maybeSingle: claim };
    if (name === 'fn_ack_final_table_announcement') return ack();
    if (name === 'fn_read_final_table_transition')
      return {
        maybeSingle: async () => ({
          data: { triggered: true, ownership_token: 'other', announced_at: null },
          error: null,
        }),
      };
    throw new Error(`unexpected RPC ${name}`);
  }) as any);
  const manager: any = Object.assign(Object.create(TournamentManager.prototype), {
    isFinalTable: false,
    pendingFinalTableAnnouncement: null,
    durableTournamentBreaks: new Map(),
    tournamentCache: { format_contract: 'mtt-v2', table_size: 9 },
    tournamentId: '11111111-1111-4111-8111-111111111111',
    finalTableTransitionOwner: '22222222-2222-4222-8222-222222222222',
    eliminationMutationAllowed: vi.fn(() => true),
    countLiveTablesWithPlayers: vi.fn(async () => 1),
    liveTournamentTableIdsWithPlayers: vi.fn(async () => ['table']),
    requestUrgentEliminationSweepAfter: vi.fn(),
    broadcast: vi.fn(async () => true),
  });
  return { manager, claim, ack };
}
afterEach(() => vi.restoreAllMocks());
describe('the original final-table announcement retains its unfinished outcome', () => {
  it('continues a failed send without reclaiming the durable transition', async () => {
    const { manager, claim, ack } = harness();
    manager.broadcast.mockResolvedValueOnce(false);
    await manager.prepareFreshTableBalance();
    expect(manager.isFinalTable).toBe(true);
    expect(ack).not.toHaveBeenCalled();
    await manager.prepareFreshTableBalance();
    expect(manager.broadcast).toHaveBeenCalledTimes(2);
    expect(claim).toHaveBeenCalledTimes(1);
    expect(ack).toHaveBeenCalledTimes(1);
    await manager.prepareFreshTableBalance();
    expect(manager.broadcast).toHaveBeenCalledTimes(2);
  });
  it.each(['false', 'error', 'throw'])(
    'continues an %s acknowledgement without replaying accepted presentation',
    async (failure) => {
      const { manager, ack } = harness();
      if (failure === 'throw') ack.mockRejectedValueOnce(new Error('lost response'));
      else
        ack.mockResolvedValueOnce({
          data: false,
          error: failure === 'error' ? { message: 'unavailable' } : null,
        });
      await manager.prepareFreshTableBalance();
      await manager.prepareFreshTableBalance();
      expect(manager.broadcast).toHaveBeenCalledTimes(1);
      expect(ack).toHaveBeenCalledTimes(2);
      expect(manager.pendingFinalTableAnnouncement).toBeNull();
    }
  );
  it('retains pending delivery while mutation authority is revoked', async () => {
    const { manager } = harness();
    manager.broadcast.mockResolvedValueOnce(false);
    await manager.prepareFreshTableBalance();
    manager.eliminationMutationAllowed.mockReturnValue(false);
    await manager.prepareFreshTableBalance();
    expect(manager.broadcast).toHaveBeenCalledTimes(1);
    manager.eliminationMutationAllowed.mockReturnValue(true);
    await manager.prepareFreshTableBalance();
    expect(manager.broadcast).toHaveBeenCalledTimes(2);
  });
  it('does not announce a transition owned by another manager', async () => {
    const { manager, claim } = harness();
    claim.mockResolvedValueOnce({ data: { state: 'already_persisted' }, error: null });
    await manager.prepareFreshTableBalance();
    expect(manager.isFinalTable).toBe(true);
    expect(manager.broadcast).not.toHaveBeenCalled();
  });
});
