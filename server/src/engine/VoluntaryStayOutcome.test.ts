import { afterEach, describe, expect, it, vi } from 'vitest';
import { ServerTableEngine } from './ServerTableEngine.js';
import * as sessions from '../services/supabase/cashSessions.js';
afterEach(() => vi.restoreAllMocks());
function setup() {
  const engine = Object.create(ServerTableEngine.prototype) as any;
  engine.tableId = 'table';
  engine.lifecycleCanMutate = vi.fn(() => true);
  const player = { user_id: 'player', seat_number: 2, occupancy_id: 'original' };
  engine.seatedPlayers = [player];
  let resolve!: (result: any) => void;
  const pending = new Promise<any>((yes) => {
    resolve = yes;
  });
  const rpc = vi.spyOn(sessions, 'atomicCashoutVoluntary').mockReturnValue(pending);
  return { engine, player, resolve, rpc };
}
describe('voluntary outcomes belong only to the original stay', () => {
  it.each([
    { ok: true, stack: 25 },
    { ok: false, code: 'LEAVE_LOCKED', stayRemainingMs: 9000 },
  ])('never reflects a delayed %j outcome onto a replacement occupancy', async (outcome) => {
    const h = setup();
    const result = h.engine.cashoutVoluntaryStay(h.player);
    h.player.occupancy_id = 'replacement';
    h.resolve(outcome);
    await expect(result).resolves.toBeNull();
    expect(h.rpc).toHaveBeenCalledWith('player', 'table', 2, 'original');
  });
  it('does not initiate a new cashout from an already stale roster candidate', async () => {
    const h = setup();
    h.engine.seatedPlayers = [{ ...h.player, occupancy_id: 'replacement' }];
    await expect(h.engine.cashoutVoluntaryStay(h.player)).resolves.toBeNull();
    expect(h.rpc).not.toHaveBeenCalled();
  });
  it('does not reflect after the engine loses authority', async () => {
    const h = setup();
    const result = h.engine.cashoutVoluntaryStay(h.player);
    h.engine.lifecycleCanMutate.mockReturnValue(false);
    h.resolve({ ok: true, stack: 25 });
    await expect(result).resolves.toBeNull();
  });
  it.each([false, true])(
    'preserves the actual outcome when original stay is gone=%s',
    async (gone) => {
      const h = setup();
      const result = h.engine.cashoutVoluntaryStay(h.player);
      if (gone) h.engine.seatedPlayers = [];
      const outcome = { ok: true, stack: 25 };
      h.resolve(outcome);
      await expect(result).resolves.toBe(outcome);
    }
  );
});
