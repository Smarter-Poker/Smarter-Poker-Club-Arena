/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — CashoutService
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * REWRITTEN 2026-08-25, in the same commit as the behaviour it pins.
 *
 * Every leg used to be a fetch to a World Hub API route holding the service role
 * key, and this suite asserted THAT: a stubbed `fetch` returning `{ success:
 * false }`, and a "refuse when there is no session" case aimed at
 * callClubArenaApi. All four legs are now SECURITY DEFINER RPCs that derive the
 * actor from auth.uid(), so those assertions describe a path that no longer
 * exists. Leaving them would have been the "someone else will fix the test"
 * failure CLAUDE.md section 8 is about.
 *
 * What is pinned now is what the money depends on:
 *   - the RPC each leg calls, by name;
 *   - that a refusal arriving as DATA (`{ success: false, error }`) throws
 *     rather than being reported as success - the class of bug that had the
 *     cashier hard-coding `{ success: true }` over a failed send;
 *   - that no balance event is emitted for money that did not move;
 *   - that every call carries a p_op_id, because a retry without one sends twice.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/lib/supabase', () => {
  const buildChain = (): any => {
    const handler: ProxyHandler<any> = {
      get: (_target, prop) => {
        if (prop === 'maybeSingle' || prop === 'single')
          return () => Promise.resolve({ data: null, error: null });
        if (prop === 'then')
          return (resolve: (v: any) => void) => resolve({ data: null, error: null });
        return vi.fn().mockReturnValue(new Proxy({}, handler));
      },
    };
    return new Proxy({}, handler);
  };
  return {
    supabase: {
      auth: {
        getSession: vi.fn(() =>
          Promise.resolve({
            data: { session: { access_token: 'test-jwt', user: { id: 'player-1' } } },
            error: null,
          })
        ),
        getUser: vi.fn(() => Promise.resolve({ data: { user: { id: 'player-1' } }, error: null })),
      },
      from: () => buildChain(),
      rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
    },
  };
});

vi.mock('../../src/core/MasterBus', () => ({
  masterBus: { emit: vi.fn(), subscribe: vi.fn(() => vi.fn()) },
}));

vi.mock('../../src/utils/retryAsync', () => ({
  retryAsync: <T>(fn: () => Promise<T>) => fn(),
}));

vi.mock('../../src/utils/clubIdResolver', () => ({
  resolveClubUUID: (id: string) => Promise.resolve(id),
  isUUID: () => true,
}));

vi.mock('../../src/services/PushNotificationService', () => ({
  pushNotificationService: { sendToUser: vi.fn().mockResolvedValue(true) },
}));

import { cashoutService } from '../../src/services/CashoutService';
import { masterBus } from '../../src/core/MasterBus';
import { supabase } from '../../src/lib/supabase';
import { pushNotificationService } from '../../src/services/PushNotificationService';

const rpc = supabase.rpc as unknown as ReturnType<typeof vi.fn>;

/** A refusal the way the RPCs actually send one: 200 OK, `success: false`. */
const refuse = (error: string) => rpc.mockResolvedValueOnce({ data: { success: false, error } });
const accept = (payload: Record<string, unknown>) =>
  rpc.mockResolvedValueOnce({ data: { success: true, ...payload } });

describe('CashoutService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rpc.mockResolvedValue({ data: null, error: null });
  });

  describe('export shape', () => {
    it('should export cashoutService with all methods', () => {
      expect(typeof cashoutService.requestCashout).toBe('function');
      expect(typeof cashoutService.cancelCashout).toBe('function');
      expect(typeof cashoutService.approveCashout).toBe('function');
      expect(typeof cashoutService.completeCashout).toBe('function');
      expect(typeof cashoutService.rejectCashout).toBe('function');
      expect(typeof cashoutService.getCashout).toBe('function');
      expect(typeof cashoutService.getAgentPendingCashouts).toBe('function');
      expect(typeof cashoutService.claimBackSend).toBe('function');
    });
  });

  describe('getCashout', () => {
    it('should return null for unknown cashout', async () => {
      const result = await cashoutService.getCashout('nonexistent');
      expect(result).toBeNull();
    });
  });

  describe('getAgentPendingCashouts', () => {
    it('reads the scoped queue RPC, not the table', async () => {
      rpc.mockResolvedValueOnce({ data: [], error: null });
      const result = await cashoutService.getAgentPendingCashouts('agent-1', 'club-1');
      expect(result).toEqual([]);
      expect(rpc).toHaveBeenCalledWith('fn_cashout_queue', {
        p_club_id: 'club-1',
        p_status: 'pending',
      });
    });

    it('maps a queue row without a second round trip for the name', async () => {
      rpc.mockResolvedValueOnce({
        data: [
          {
            id: 'c1',
            club_id: 'club-1',
            player_id: 'p1',
            player_name: 'Dana',
            player_avatar: '',
            agent_id: 'a1',
            amount: 500,
            status: 'pending',
            player_note: null,
            agent_note: null,
            created_at: '2026-08-25T00:00:00Z',
          },
        ],
        error: null,
      });
      const [row] = await cashoutService.getAgentPendingCashouts('a1');
      expect(row.playerName).toBe('Dana');
      expect(row.amount).toBe(500);
      expect(rpc).toHaveBeenCalledTimes(1);
    });
  });

  describe('the money legs call the RPC that owns the rule', () => {
    it('requestCashout escrows through fn_cashout_request with an op id', async () => {
      accept({ cashout_id: 'c1', agent_id: 'a1', amount: 250, player_name: 'Dana' });
      await cashoutService.requestCashout('p1', 'club-1', 250, 'cabbing home');
      const [name, args] = rpc.mock.calls[0];
      expect(name).toBe('fn_cashout_request');
      expect(args.p_club_id).toBe('club-1');
      expect(args.p_amount).toBe(250);
      expect(args.p_op_id).toMatch(/^[0-9a-f-]{36}$/i);
    });

    it('leaves the agent notification to the RPC and does not double-push', async () => {
      // REWRITTEN 2026-08-30 (#1498). The old name said it: "by push as well as
      // the in-app row the RPC wrote". That extra push was a duplicate --
      // tr_notify_agent_on_cashout raises 'cashout_request' on the INSERT and
      // trg_mirror_notification_to_push_outbox turns it into a push. The client
      // was sending a second one over the same event, through a transport that
      // OneSignal's retirement had already killed, so nobody noticed.
      accept({ cashout_id: 'c1', agent_id: 'agent-9', amount: 250, player_name: 'Dana' });
      await cashoutService.requestCashout('p1', 'club-1', 250);
      expect(rpc.mock.calls[0][0]).toBe('fn_cashout_request');
      expect(pushNotificationService.sendToUser).not.toHaveBeenCalled();
    });

    it('approveCashout calls fn_cashout_approve, which is what notifies the player', async () => {
      // fn_cashout_approve writes the notification itself, inside the money
      // transaction, with type 'cashout_approved'. The client must not add a
      // second push over the same event.
      accept({ cashout_id: 'c1', player_id: 'p1', club_id: 'club-1', amount: 250 });
      await cashoutService.approveCashout('c1', 'a1');
      expect(rpc.mock.calls[0][0]).toBe('fn_cashout_approve');
      expect(pushNotificationService.sendToUser).not.toHaveBeenCalled();
    });

    it('rejectCashout and cancelCashout share fn_cashout_release', async () => {
      accept({ cashout_id: 'c1', player_id: 'p1', club_id: 'club-1', amount: 250 });
      await cashoutService.rejectCashout('c1', 'a1', 'no');
      expect(rpc.mock.calls[0][0]).toBe('fn_cashout_release');

      rpc.mockClear();
      accept({ cashout_id: 'c2', player_id: 'p1', club_id: 'club-1', amount: 250 });
      await cashoutService.cancelCashout('c2', 'p1');
      expect(rpc.mock.calls[0][0]).toBe('fn_cashout_release');
    });

    it('sendChipsToPlayer spends the AGENT WALLET, not a generic transfer', async () => {
      accept({ transaction_id: 't1', amount: 100 });
      await cashoutService.sendChipsToPlayer('a1', 'p1', 'club-1', 100, 'buy in');
      const [name, args] = rpc.mock.calls[0];
      expect(name).toBe('fn_agent_wallet_send');
      expect(args.p_destination).toBe('player_wallet');
      expect(args.p_op_id).toMatch(/^[0-9a-f-]{36}$/i);
    });

    it('claimBackSend is anchored on a TRANSACTION, never on a member', async () => {
      accept({ amount: 100, agent_wallet_after: 900 });
      const out = await cashoutService.claimBackSend('club-1', 'tx-1');
      const [name, args] = rpc.mock.calls[0];
      expect(name).toBe('fn_agent_wallet_claim_back');
      expect(args.p_transaction_id).toBe('tx-1');
      expect(args).not.toHaveProperty('p_player_id');
      expect(out.agentWalletAfter).toBe(900);
    });
  });

  describe('a refusal is never reported as success', () => {
    it('throws the servers reason when requestCashout is refused', async () => {
      refuse('You Only Hold 10 Chips');
      await expect(cashoutService.requestCashout('p1', 'club-1', 999)).rejects.toThrow(
        'You Only Hold 10 Chips'
      );
      expect(masterBus.emit).not.toHaveBeenCalledWith('BALANCE_UPDATED', expect.anything());
    });

    it('throws when a cashout cannot be approved, and emits nothing', async () => {
      refuse('That Cash Out Has Already Been Dealt With');
      await expect(cashoutService.approveCashout('unknown-id', 'agent-1')).rejects.toThrow(
        'That Cash Out Has Already Been Dealt With'
      );
      expect(masterBus.emit).not.toHaveBeenCalledWith('CASHOUT_APPROVED', expect.anything());
    });

    it('throws when a claim back falls outside the ten minute window', async () => {
      refuse(
        'The Ten Minute Window To Claim These Chips Back Has Closed. The Player Must Request A Cash Out Instead'
      );
      await expect(cashoutService.claimBackSend('club-1', 'tx-1')).rejects.toThrow(
        /Ten Minute Window/
      );
      expect(masterBus.emit).not.toHaveBeenCalledWith('BALANCE_UPDATED', expect.anything());
    });

    it('surfaces a transport error rather than swallowing it', async () => {
      rpc.mockResolvedValueOnce({ data: null, error: { message: 'network down' } });
      await expect(cashoutService.cancelCashout('c1', 'p1')).rejects.toThrow('network down');
    });
  });

  describe('the chip removal policy stays shut', () => {
    it('canRemoveChips is always false', async () => {
      await expect(cashoutService.canRemoveChips('a1', 'p1', 'club-1', 10)).resolves.toBe(false);
    });

    it('removeChipsFromPlayer refuses outright', async () => {
      await expect(cashoutService.removeChipsFromPlayer('a1', 'p1', 'club-1', 10)).rejects.toThrow(
        /cannot remove chips/i
      );
    });
  });
});

describe('exact-cent request boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  it.each([0.01, 0.29, 1.25, 308.5, 1e9])(
    'serializes %s unchanged into the original atomic RPC',
    async (amount) => {
      accept({ cashout_id: 'cent-request', replayed: true });
      await cashoutService.requestCashout('p1', 'club-1', amount, undefined, 'cent-operation');
      expect(rpc).toHaveBeenCalledWith('fn_cashout_request', {
        p_club_id: 'club-1',
        p_amount: amount,
        p_note: null,
        p_op_id: 'cent-operation',
      });
      expect(JSON.parse(JSON.stringify(rpc.mock.calls[0][1])).p_amount).toBe(amount);
    }
  );
  it.each([
    NaN,
    Infinity,
    -Infinity,
    0,
    -1,
    1.001,
    0.30000000000000004,
    1e9 + 0.01,
    Number.MAX_SAFE_INTEGER,
  ])('refuses invalid %s before the RPC', async (amount) => {
    await expect(cashoutService.requestCashout('p1', 'club-1', amount)).rejects.toThrow();
    expect(rpc).not.toHaveBeenCalled();
  });
});
