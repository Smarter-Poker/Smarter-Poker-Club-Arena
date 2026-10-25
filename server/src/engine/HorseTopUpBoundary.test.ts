import { beforeEach, describe, expect, it, vi } from 'vitest';
const calls = vi.hoisted(() => ({ batch: vi.fn(), fund: vi.fn() }));
vi.mock('../services/supabase.js', async (original) => ({
  ...(await original<typeof import('../services/supabase.js')>()),
  readHorseTopUpBatch: (...args: unknown[]) => calls.batch(...args),
  autoRebuyHorse: (...args: unknown[]) => calls.fund(...args),
}));
import { ServerTableEngineSettlement } from './ServerTableEngineSettlement.js';
const run = (engine: any, players: any[], reloaded = new Set<string>()) =>
  (ServerTableEngineSettlement.prototype as any).topUpPlo5Horses.call(
    engine,
    players,
    91,
    reloaded
  );
function engine() {
  return {
    tableId: 'table',
    tableInfo: {
      game_variant: 'plo5',
      club_id: 'club',
      big_blind: 1,
      min_buy_in: 40,
      max_buy_in: 200,
    },
    isTournamentTable: () => false,
    isDiamondCashTable: () => false,
    lifecycleCanMutate: () => true,
    getMaxBuyIn: () => 200,
    clusterLightningEnabled: false,
    hub: { emitEvent: vi.fn() },
  };
}
function players() {
  return [0, 1].map((i) => ({
    user_id: `horse-${i}`,
    username: `horse-${i}`,
    stack: 100,
    seat_number: i + 1,
    is_horse: true,
  }));
}
const context = {
  autoTopUp: true,
  clubId: 'club',
  wallet: 100000,
  invested: 100,
  sittingOut: false,
  leaving: false,
};
describe('the real settlement top-up boundary', () => {
  beforeEach(() => {
    calls.batch.mockReset().mockResolvedValue(
      new Map([
        ['horse-0', { ...context }],
        ['horse-1', { ...context }],
      ])
    );
    calls.fund.mockReset().mockResolvedValue({ status: 'funded', stack: 200 });
  });
  it('uses one shared context and emits both simultaneous purchases with authoritative stacks', async () => {
    const e = engine();
    const p = players();
    await run(e, p);
    expect(calls.batch).toHaveBeenCalledTimes(1);
    expect(calls.fund.mock.calls.map((c) => c.slice(0, 6))).toEqual([
      ['table', 'horse-0', 100, 'club', 91, 'topup'],
      ['table', 'horse-1', 100, 'club', 91, 'topup'],
    ]);
    expect(p.map((x) => x.stack)).toEqual([200, 200]);
    expect(e.hub.emitEvent.mock.calls.map((c) => [c[1].seat, c[1].stack, c[1].amount])).toEqual([
      [1, 200, 100],
      [2, 200, 100],
    ]);
  });
  it('never invents an event or stack after an unknown funding response', async () => {
    calls.fund.mockResolvedValue({ status: 'unknown' });
    const e = engine();
    const p = players();
    await run(e, p);
    expect(e.hub.emitEvent).not.toHaveBeenCalled();
    expect(p.map((x) => x.stack)).toEqual([100, 100]);
  });
  it('does not add to a rebuy, a leaving seat, or an unread wallet', async () => {
    calls.batch.mockResolvedValue(
      new Map([
        ['horse-0', { ...context, leaving: true }],
        ['horse-1', { ...context, wallet: undefined }],
      ])
    );
    await run(engine(), players(), new Set(['horse-0']));
    expect(calls.fund).not.toHaveBeenCalled();
  });
  it('stops before the next purchase after lifecycle ownership changes', async () => {
    const e = engine();
    calls.fund.mockImplementation(async () => {
      e.lifecycleCanMutate = () => false;
      return { status: 'funded', stack: 200 };
    });
    await run(e, players());
    expect(calls.fund).toHaveBeenCalledTimes(1);
    expect(e.hub.emitEvent).not.toHaveBeenCalled();
  });
  it('never touches Lightning, tournaments, or a different variant', async () => {
    for (const alter of [
      (e: ReturnType<typeof engine>) => (e.clusterLightningEnabled = true),
      (e: ReturnType<typeof engine>) => (e.isTournamentTable = () => true),
      (e: ReturnType<typeof engine>) => (e.tableInfo.game_variant = 'plo6'),
    ]) {
      const e = engine();
      alter(e);
      await run(e, players());
    }
    expect(calls.batch).not.toHaveBeenCalled();
    expect(calls.fund).not.toHaveBeenCalled();
  });
});
