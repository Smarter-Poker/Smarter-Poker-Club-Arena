import { beforeEach, describe, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
const mocks = vi.hoisted(() => ({ rpc: vi.fn(), emit: vi.fn(), auth: vi.fn() }));
vi.mock('../../src/lib/supabase', () => ({
  supabase: { rpc: mocks.rpc },
  getAuthUser: mocks.auth,
}));
vi.mock('../../src/core/MasterBus', () => ({ masterBus: { emit: mocks.emit } }));
vi.mock('../../src/utils/clubIdResolver', () => ({ resolveClubUUID: async (id: string) => id }));
import { WalletService } from '../../src/services/WalletService';
import { AgentService } from '../../src/services/AgentService';
const actor = '10000000-0000-4000-8000-000000000001';
const club = '20000000-0000-4000-8000-000000000001';
const target = '30000000-0000-4000-8000-000000000001';
const tx = '40000000-0000-4000-8000-000000000001';
beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  localStorage.clear();
  sessionStorage.clear();
  vi.stubGlobal('crypto', webcrypto);
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: {
      request: async (_key: string, _options: unknown, fn: () => unknown) => fn(),
    },
  });
  mocks.auth.mockResolvedValue({ data: { user: { id: actor } }, error: null });
});
describe.each(['self', 'send'])('canonical %s transfer', (kind) => {
  const submit = (amount = 5) =>
    kind === 'self'
      ? WalletService.agentSelfTransfer(club, amount)
      : AgentService.transferToPlayer(target, club, amount);
  const receipt = () => ({
    success: true,
    transaction_id: tx,
    amount: 5,
    agent_wallet_after: 95,
    player_wallet_after: 5,
    recipient_balance_after: 5,
    destination: 'player_wallet',
  });
  it('calls only the canonical RPC with a verified persisted operation and confirms once', async () => {
    mocks.rpc.mockResolvedValue({ data: receipt(), error: null });
    await expect(submit()).resolves.toBe(true);
    expect(mocks.rpc).toHaveBeenCalledWith(
      kind === 'self' ? 'fn_agent_wallet_self_stake' : 'fn_agent_wallet_send',
      expect.objectContaining({ p_club_id: club, p_amount: 5, p_op_id: expect.any(String) })
    );
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    expect(mocks.emit).toHaveBeenCalled();
  });
  it('coalesces overlapping submissions even when the server responds immediately', async () => {
    mocks.rpc.mockResolvedValue({ data: receipt(), error: null });
    await Promise.all(Array.from({ length: 20 }, () => submit()));
    expect(new Set(mocks.rpc.mock.calls.map((call) => call[1].p_op_id)).size).toBe(1);
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    await submit();
    expect(mocks.rpc).toHaveBeenCalledTimes(2);
    expect(mocks.rpc.mock.calls[1][1].p_op_id).not.toBe(mocks.rpc.mock.calls[0][1].p_op_id);
  });
  it('reuses the operation after a committed response is lost and does not announce false success', async () => {
    mocks.rpc.mockRejectedValueOnce(new Error('response lost'));
    await expect(submit()).rejects.toThrow('response lost');
    expect(mocks.emit).not.toHaveBeenCalled();
    const operation = mocks.rpc.mock.calls[0][1].p_op_id;
    mocks.rpc.mockResolvedValueOnce({ data: { ...receipt(), replayed: true }, error: null });
    await expect(submit()).resolves.toBe(true);
    expect(mocks.rpc.mock.calls[1][1].p_op_id).toBe(operation);
  });
  it.each([
    null,
    {},
    { success: 'true' },
    { success: true },
    { success: false, error: 'declined' },
  ])('retains identity and emits no success for %j', async (data) => {
    mocks.rpc.mockResolvedValue({ data, error: null });
    await expect(submit()).rejects.toThrow();
    await expect(submit()).rejects.toThrow();
    expect(mocks.rpc.mock.calls[1][1].p_op_id).toBe(mocks.rpc.mock.calls[0][1].p_op_id);
    expect(mocks.emit).not.toHaveBeenCalled();
  });
  it('refuses nonfinite and fractional-smallest-unit amounts before auth or RPC', async () => {
    for (const amount of [NaN, Infinity, -Infinity, 0, -1, 0.001])
      await expect(submit(amount)).rejects.toThrow();
    expect(mocks.auth).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it('does not submit when request persistence fails', async () => {
    vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
      throw new Error('storage denied');
    });
    await expect(submit()).rejects.toThrow();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it('does not submit signed out', async () => {
    mocks.auth.mockResolvedValue({ data: { user: null }, error: null });
    await expect(submit()).rejects.toThrow(/Sign In/);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  if (kind === 'send') {
    it('rejects another destination and preserves the original retry identity', async () => {
      mocks.rpc.mockResolvedValueOnce({
        data: { ...receipt(), destination: 'agent_wallet' },
        error: null,
      });
      await expect(submit()).rejects.toThrow(/Confirm/);
      expect(mocks.emit).not.toHaveBeenCalled();
      const original = mocks.rpc.mock.calls[0][1].p_op_id;
      mocks.rpc.mockResolvedValueOnce({ data: receipt(), error: null });
      await expect(submit()).resolves.toBe(true);
      expect(mocks.rpc.mock.calls[1][1].p_op_id).toBe(original);
    });
  }
  it('rejects an unrelated receipt without clearing the original identity', async () => {
    mocks.rpc.mockResolvedValue({ data: { ...receipt(), amount: 6 }, error: null });
    await expect(submit()).rejects.toThrow();
    expect(mocks.emit).not.toHaveBeenCalled();
  });
});
