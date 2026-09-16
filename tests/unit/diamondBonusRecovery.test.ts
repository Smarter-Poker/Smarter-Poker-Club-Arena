import { beforeEach, describe, expect, it, vi } from 'vitest';
import fixtures from '../fixtures/diamond-spins/local-postgres-receipts.json';
const receipt = fixtures.receipts.mines;
import {
  pendingBonus,
  rememberBonus,
  clearPendingBonus,
} from '../../src/services/diamondBonusRecovery';
import { DiamondBonusService, BonusRefusal } from '../../src/services/DiamondBonusService';
const rpc = vi.hoisted(() => vi.fn());
vi.mock('../../src/lib/supabase', () => ({ supabase: { rpc } }));
const request = {
  clubId: receipt.club_id,
  game: 'mines' as const,
  budget: { base: receipt.bet_diamonds, doubled: false, denomination: 1 },
  commitId: receipt.commit_id,
  seed: receipt.client_seed,
  mode: receipt.mode,
  maxSteps: receipt.max_steps,
};
beforeEach(() => {
  sessionStorage.clear();
  rpc.mockReset();
});
describe('a saved bonus remains one wager', () => {
  it('keeps an unanswered request across reload and refuses a replacement before any RPC', async () => {
    rpc.mockResolvedValueOnce({ data: null, error: Error('Connection lost') });
    await expect(DiamondBonusService.start(request, 'alice')).rejects.toThrow('Connection lost');
    expect(pendingBonus('alice', request.clubId, 'mines')).toEqual(request);
    expect(pendingBonus('bob', request.clubId, 'mines')).toBeNull();
    await expect(
      DiamondBonusService.start(
        { ...request, commitId: '00000000-0000-0000-0000-000000000005' },
        'alice'
      )
    ).rejects.toThrow('Previous Bonus');
    expect(rpc).toHaveBeenCalledTimes(1);
  });
  it('clears only a verified exact receipt or a definitive transactional refusal', async () => {
    rpc.mockResolvedValue({ data: { ok: false, error: 'Not Enough Diamonds' }, error: null });
    await expect(DiamondBonusService.start(request, 'alice')).rejects.toBeInstanceOf(BonusRefusal);
    expect(pendingBonus('alice', request.clubId, 'mines')).toBeNull();
    const result = {
      ...receipt,
      bonus: {
        id: '00000000-0000-0000-0000-000000000004',
        base_diamonds: receipt.bet_diamonds,
        added_diamonds: 0,
        total_diamonds: receipt.bet_diamonds,
      },
    };
    rpc.mockResolvedValueOnce({
      data: { ...result, bonus: { ...result.bonus, added_diamonds: 1 } },
      error: null,
    });
    await expect(DiamondBonusService.start(request, 'alice')).rejects.toThrow(
      'Could Not Be Verified'
    );
    expect(pendingBonus('alice', request.clubId, 'mines')).toEqual(request);
    rpc.mockResolvedValueOnce({ data: result, error: null });
    await expect(DiamondBonusService.start(request, 'alice')).resolves.toEqual(result);
    expect(pendingBonus('alice', request.clubId, 'mines')).toBeNull();
  });
  it('cannot erase another account or another ticket', () => {
    rememberBonus('alice', request);
    rememberBonus('bob', request);
    clearPendingBonus('alice', { ...request, commitId: '00000000-0000-0000-0000-000000000009' });
    expect(pendingBonus('alice', request.clubId, 'mines')).toEqual(request);
    clearPendingBonus('alice', request);
    expect(pendingBonus('bob', request.clubId, 'mines')).toEqual(request);
  });
  it('fails before sending if durable session recovery cannot be written', async () => {
    vi.stubGlobal('sessionStorage', {
      getItem: () => null,
      setItem: () => {
        throw Error('Storage unavailable');
      },
    });
    await expect(DiamondBonusService.start(request, 'alice')).rejects.toThrow(
      'Storage unavailable'
    );
    expect(rpc).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
