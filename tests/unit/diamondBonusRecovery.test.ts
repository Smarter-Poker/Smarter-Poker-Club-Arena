import { beforeEach, describe, expect, it, vi } from 'vitest';
import fixtures from '../fixtures/diamond-spins/local-postgres-receipts.json';
const receipt = fixtures.receipts.mines;
import {
  pendingBonus,
  rememberBonus,
  clearPendingBonus,
  PriorBonusPending,
} from '../../src/services/diamondBonusRecovery';
import { DiamondBonusService, BonusRefusal } from '../../src/services/DiamondBonusService';
const rpc = vi.hoisted(() => vi.fn());
vi.mock('../../src/lib/supabase', () => ({ supabase: { rpc } }));
const request = {
  clubId: receipt.club_id,
  game: 'mines' as const,
  budget: { base: receipt.bet_diamonds, doubled: false, denomination: 1 },
  commitId: receipt.commit_id,
  serverSeedHash: receipt.server_seed_hash,
  seed: receipt.client_seed,
  mode: receipt.mode,
  maxSteps: receipt.max_steps,
};
beforeEach(() => {
  sessionStorage.clear();
  rpc.mockReset();
});
describe('a saved bonus remains one wager', () => {
  it.each(['', '   ', 'a'.repeat(65)])(
    'refuses invalid custom seed %s before retaining or sending money',
    async (seed) => {
      await expect(DiamondBonusService.start({ ...request, seed }, 'alice')).rejects.toBeInstanceOf(
        BonusRefusal
      );
      expect(rpc).not.toHaveBeenCalled();
      expect(pendingBonus('alice', request.clubId, 'mines')).toBeNull();
    }
  );
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
  it('requires a commitment for fresh play but can recover an unchanged older saved wager', async () => {
    const { serverSeedHash: _hash, ...legacy } = request;
    await expect(DiamondBonusService.start(legacy, 'alice')).rejects.toThrow('Sealed Game Ticket');
    expect(rpc).not.toHaveBeenCalled();
    sessionStorage.setItem(
      `diamond-spins-pending:alice:${request.clubId}:mines`,
      JSON.stringify(legacy)
    );
    const result = {
      ...receipt,
      bonus: {
        id: '00000000-0000-0000-0000-000000000004',
        base_diamonds: receipt.bet_diamonds,
        added_diamonds: 0,
        total_diamonds: receipt.bet_diamonds,
      },
    };
    rpc.mockResolvedValueOnce({ data: result, error: null });
    await expect(DiamondBonusService.start(legacy, 'alice')).resolves.toEqual(result);
    expect(pendingBonus('alice', request.clubId, 'mines')).toBeNull();
  });
  it('retains the original hash after a substituted valid-looking commitment response', async () => {
    rpc.mockResolvedValueOnce({
      data: {
        ...receipt,
        server_seed_hash: 'f'.repeat(64),
        proof: { ...receipt.proof, server_seed_hash: 'f'.repeat(64) },
        bonus: {
          id: receipt.id,
          base_diamonds: receipt.bet_diamonds,
          added_diamonds: 0,
          total_diamonds: receipt.bet_diamonds,
        },
      },
      error: null,
    });
    await expect(DiamondBonusService.start(request, 'alice')).rejects.toThrow(
      'Could Not Be Verified'
    );
    expect(pendingBonus('alice', request.clubId, 'mines')?.serverSeedHash).toBe(
      receipt.server_seed_hash
    );
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
describe('a saved bonus settles itself (owner ruling 2026-09-21: no game asks for a check)', () => {
  it('a conflicting saved wager is handed to the page, which settles it first', async () => {
    rpc.mockResolvedValueOnce({ data: null, error: Error('Connection lost') });
    await expect(DiamondBonusService.start(request, 'alice')).rejects.toThrow('Connection lost');
    const replacement = { ...request, commitId: '00000000-0000-0000-0000-000000000005' };
    const refusal = await DiamondBonusService.start(replacement, 'alice').catch((e) => e);
    expect(refusal).toBeInstanceOf(PriorBonusPending);
    expect((refusal as PriorBonusPending).prior).toEqual(request);
    expect(rpc).toHaveBeenCalledTimes(1);
  });
  it('a saved wager that cannot be replayed is discarded, not thrown, so the page loads', () => {
    const key = `diamond-spins-pending:alice:${request.clubId}:mines`;
    sessionStorage.setItem(key, '{not json');
    expect(pendingBonus('alice', request.clubId, 'mines')).toBeNull();
    expect(sessionStorage.getItem(key)).toBeNull();
    sessionStorage.setItem(key, JSON.stringify({ ...request, commitId: 'not-a-ticket' }));
    expect(pendingBonus('alice', request.clubId, 'mines')).toBeNull();
    expect(sessionStorage.getItem(key)).toBeNull();
  });
  it('a ticket the server no longer holds is a refusal the page re-deals by itself', async () => {
    rpc.mockResolvedValueOnce({
      data: { ok: false, ticket: 'gone', error: 'That Ticket Expired. A New One Is Being Dealt' },
      error: null,
    });
    const refusal = await DiamondBonusService.start(request, 'alice').catch((e) => e);
    expect(refusal).toBeInstanceOf(BonusRefusal);
    expect((refusal as BonusRefusal).ticketGone).toBe(true);
    // Nothing was charged, so nothing is saved.
    expect(pendingBonus('alice', request.clubId, 'mines')).toBeNull();
    rpc.mockResolvedValueOnce({ data: { ok: false, error: 'Not Enough Diamonds' }, error: null });
    const ordinary = await DiamondBonusService.start(request, 'alice').catch((e) => e);
    expect((ordinary as BonusRefusal).ticketGone).toBe(false);
  });
});
