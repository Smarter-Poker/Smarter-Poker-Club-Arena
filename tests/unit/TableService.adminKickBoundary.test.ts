import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn(), emit: vi.fn(), fetch: vi.fn() }));
vi.mock('../../src/lib/supabase', () => ({ supabase: { rpc: mocks.rpc, from: mocks.from } }));
vi.mock('../../src/services/EngineStateClient', () => ({ engineChannelClient: {} }));
vi.mock('../../src/core/MasterBus', () => ({ masterBus: { emit: mocks.emit } }));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
import { tableService } from '../../src/services/TableService';
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal('fetch', mocks.fetch);
});
afterEach(() => vi.unstubAllGlobals());
describe('TableService admin kick uses the engine departure boundary', () => {
  it('does not call the direct cashout RPC or write a second player count', async () => {
    mocks.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: true, immediate: true }),
    });
    expect(await tableService.kickPlayer('table', 'player', 'house decision')).toBe(true);
    expect(mocks.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/admin/kick'),
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ tableId: 'table', userId: 'player', reason: 'house decision' }),
      })
    );
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.from).not.toHaveBeenCalled();
  });
  it.each([{}, null, { success: false, error: 'All In' }, { success: 'true' }])(
    'does not report removal for an unconfirmed engine response %#',
    async (response) => {
      mocks.fetch.mockResolvedValue({ ok: true, status: 200, json: async () => response });
      await expect(tableService.kickPlayer('table', 'player')).rejects.toThrow();
      expect(mocks.rpc).not.toHaveBeenCalled();
      expect(mocks.from).not.toHaveBeenCalled();
      expect(mocks.emit).not.toHaveBeenCalled();
    }
  );
  it('does not fall back to SQL when the engine is unavailable', async () => {
    mocks.fetch.mockRejectedValue(new Error('connection lost'));
    await expect(tableService.kickPlayer('table', 'player')).rejects.toThrow();
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.from).not.toHaveBeenCalled();
  });
});
