import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
vi.mock('../services/supabase/client.js', () => ({
  supabase: {
    from: vi.fn(() => {
      throw new Error('Unexpected DB read');
    }),
    rpc: vi.fn(),
  },
  maintenanceSupabase: {},
}));
const { ServerTableEngine } = await import('./ServerTableEngine.js');
const { ServerTableEngineBase } = await import('./ServerTableEngineBase.js');
const { setMaintenanceFrozen } = await import('../maintenance/freezeState.js');
function fixture() {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-28T16:00:00Z'));
  const e = Object.create(ServerTableEngine.prototype) as any;
  e.tableId = 'table';
  e.tableInfo = { cluster_id: 'cluster' };
  e.clusterLightningEnabled = true;
  e.seatedPlayers = [{ user_id: 'lucky', occupancy_id: 'original', seat_number: 1, stack: 0 }];
  e.bustedSince = new Map();
  e.lightningBustedSince = new Map();
  e.rebuyPromptOpenAt = new Map();
  e.pendingAddOns = new Map();
  e.isTournamentTable = () => false;
  e.usersWithPendingLedgerChips = vi.fn(async () => new Set());
  e.releaseBustedSeat = vi.fn(async () => true);
  return e;
}
afterEach(() => {
  setMaintenanceFrozen(false);
  vi.restoreAllMocks();
  vi.useRealTimers();
});
describe('Lightning rebuy expiry', () => {
  it('releases at 20 seconds despite fresh dialog heartbeats, never at 19,999ms', async () => {
    const e = fixture();
    e.rebuyPromptOpenAt.set('lucky', Date.now());
    await e.standUpBustedCashPlayers();
    vi.setSystemTime(Date.now() + 19_999);
    e.rebuyPromptOpenAt.set('lucky', Date.now());
    await e.standUpBustedCashPlayers();
    expect(e.releaseBustedSeat).not.toHaveBeenCalled();
    vi.setSystemTime(Date.now() + 1);
    e.rebuyPromptOpenAt.set('lucky', Date.now());
    await e.standUpBustedCashPlayers();
    expect(e.releaseBustedSeat).toHaveBeenCalledWith(
      expect.objectContaining({ occupancy_id: 'original' }),
      'busted_no_rebuy'
    );
    expect(e.seatedPlayers).toEqual([]);
  });
  it.each(['funded', 'replacement'])('resets the clock for a %s seat', async (kind) => {
    const e = fixture();
    await e.standUpBustedCashPlayers();
    vi.setSystemTime(Date.now() + 20_000);
    if (kind === 'replacement') e.seatedPlayers[0].occupancy_id = 'replacement';
    else {
      e.seatedPlayers[0].stack = 400;
      await e.standUpBustedCashPlayers();
      e.seatedPlayers[0].stack = 0;
    }
    await e.standUpBustedCashPlayers();
    expect(e.releaseBustedSeat).not.toHaveBeenCalled();
  });
  it.each(['paid', 'unknown'])('retains a seat whose rebuy is %s', async (state) => {
    const e = fixture();
    await e.standUpBustedCashPlayers();
    vi.setSystemTime(Date.now() + 20_000);
    e.usersWithPendingLedgerChips.mockResolvedValue(state === 'paid' ? new Set(['lucky']) : null);
    await e.standUpBustedCashPlayers();
    expect(e.releaseBustedSeat).not.toHaveBeenCalled();
  });
  it('retains a failed cashout and retries the same occupancy', async () => {
    const e = fixture();
    await e.standUpBustedCashPlayers();
    vi.setSystemTime(Date.now() + 20_000);
    e.releaseBustedSeat.mockResolvedValueOnce(false);
    await e.standUpBustedCashPlayers();
    expect(e.seatedPlayers).toHaveLength(1);
    await e.standUpBustedCashPlayers();
    expect(e.releaseBustedSeat).toHaveBeenCalledTimes(2);
    expect(e.seatedPlayers).toEqual([]);
  });
  it('excludes maintenance even if no parked pass executes during the break', async () => {
    const e = fixture();
    await e.standUpBustedCashPlayers();
    vi.setSystemTime(Date.now() + 10_000);
    setMaintenanceFrozen(true);
    vi.setSystemTime(Date.now() + 300_000);
    setMaintenanceFrozen(false);
    await e.standUpBustedCashPlayers();
    expect(e.releaseBustedSeat).not.toHaveBeenCalled();
    vi.setSystemTime(Date.now() + 10_000);
    await e.standUpBustedCashPlayers();
    expect(e.releaseBustedSeat).toHaveBeenCalledTimes(1);
  });
  it('protects an unsettled all-in hand', async () => {
    const e = fixture();
    await e.standUpBustedCashPlayers();
    vi.setSystemTime(Date.now() + 20_000);
    e.handController = {
      getState: () => ({ players: [{ user_id: 'lucky', is_all_in: true, is_folded: false }] }),
    };
    await e.standUpBustedCashPlayers();
    expect(e.releaseBustedSeat).not.toHaveBeenCalled();
  });
  it.each([null, undefined, NaN])('does not treat unknown stack %s as a bust', async (stack) => {
    const e = fixture();
    e.seatedPlayers[0].stack = stack;
    await e.standUpBustedCashPlayers();
    vi.setSystemTime(Date.now() + 20_000);
    await e.standUpBustedCashPlayers();
    expect(e.releaseBustedSeat).not.toHaveBeenCalled();
  });
  it('applies the same expiry to a horse', async () => {
    const e = fixture();
    e.seatedPlayers[0].is_horse = true;
    await e.standUpBustedCashPlayers();
    vi.setSystemTime(Date.now() + 20_000);
    await e.standUpBustedCashPlayers();
    expect(e.releaseBustedSeat).toHaveBeenCalledTimes(1);
  });
  it('a real parked pass delivers paid chips before deciding whether to release', async () => {
    const e = fixture();
    vi.spyOn(ServerTableEngineBase.prototype as any, 'passWhileDealingHalted').mockResolvedValue(
      undefined
    );
    e.lifecycleCanMutate = () => true;
    e.usersWithPendingLedgerChips.mockResolvedValue(new Set(['lucky']));
    e.processPendingAddOns = vi.fn(async () => {
      e.seatedPlayers[0].stack = 400;
    });
    await e.standUpBustedCashPlayers();
    vi.setSystemTime(Date.now() + 20_000);
    await e.passWhileDealingHalted();
    expect(e.processPendingAddOns).toHaveBeenCalledWith(e.seatedPlayers);
    expect(e.releaseBustedSeat).not.toHaveBeenCalled();
    expect(e.seatedPlayers[0].stack).toBe(400);
  });
  it('a real parked pass expires an unfunded seat without a browser', async () => {
    const e = fixture();
    vi.spyOn(ServerTableEngineBase.prototype as any, 'passWhileDealingHalted').mockResolvedValue(
      undefined
    );
    e.lifecycleCanMutate = () => true;
    e.processPendingAddOns = vi.fn(async () => {});
    await e.passWhileDealingHalted();
    vi.setSystemTime(Date.now() + 20_000);
    await e.passWhileDealingHalted();
    expect(e.releaseBustedSeat).toHaveBeenCalledTimes(1);
  });
  it('wires paid rebuy delivery before expiry into the shared parked pass', () => {
    const s = readFileSync('src/engine/ServerTableEngineDealing.ts', 'utf8');
    const body = s.slice(
      s.indexOf('protected override async passWhileDealingHalted()'),
      s.indexOf('protected async standUpBustedCashPlayers()')
    );
    expect(body).toContain('await super.passWhileDealingHalted()');
    expect(body).toContain('isMaintenanceFrozen()');
    expect(body.indexOf('await this.processPendingAddOns')).toBeLessThan(
      body.indexOf('await this.standUpBustedCashPlayers')
    );
    expect(body).toContain('await this.standUpBustedCashPlayers()');
  });
  it('keeps the locked paid-rebuy guard in the cashout request and required native CI', () => {
    const base = readFileSync('src/engine/ServerTableEngineBase.ts', 'utf8');
    const services = readFileSync('src/services/supabase/seats.ts', 'utf8');
    const workflow = readFileSync('../.github/workflows/ci.yml', 'utf8');
    expect(base).toContain('requireUnfunded: true');
    expect(services).toContain("supabase.rpc('fn_cashout_unfunded_seat_occupancy', cashoutArgs)");
    expect(workflow).toContain('run: python3 scripts/ci/test-lightning-rebuy-expiry-postgres.py');
  });
});
