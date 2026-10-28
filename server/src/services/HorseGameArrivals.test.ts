import { describe, it, expect, vi } from 'vitest';
import { HorseGameArrivals, parseArrivalSnapshot } from './HorseGameArrivals.js';
import { readFileSync } from 'node:fs';
const ranked = Array.from({ length: 20 }, (_, i) => 'horse-' + i);
const table = {
  cluster_id: 'game',
  settings: { horse_arrivals: { version: 1, policy_id: 'policy' } },
};
const snapshot = (released: string[] = [], capacity = 4) => ({
  version: 1,
  configured: true,
  game_id: 'game',
  policy_id: 'policy',
  ranked_horse_ids: ranked,
  released_ids: released,
  ranked_unreleased_ids: ranked.filter((x) => !released.includes(x)),
  new_identity_capacity: capacity,
});
describe('game-specific horse arrivals', () => {
  it('connects the existing fleet buyer census and offer admission to the same durable state', () => {
    const fleet = readFileSync(new URL('./HorseFleetManager.ts', import.meta.url), 'utf8');
    const release = fleet.indexOf('await gameArrivals.releaseEligible(table, pool)');
    const filter = fleet.search(/pool\s*=\s*pool\.filter[\s\S]{0,80}gameArrivals\.releasedAllowed/);
    const census = fleet.indexOf('pool: pool.map((h) => h.id)', release);
    expect(release).toBeGreaterThan(0);
    expect(filter).toBeGreaterThan(release);
    expect(census).toBeGreaterThan(filter);
    expect(fleet).toContain('seedingSupabase.rpc(name, args)');
    expect(fleet).toContain('!gameArrivals.candidateAllowed(table, h.id)');
    expect(fleet).toContain('!gameArrivals.releasedAllowed(table, offer.user_id)');
  });
  it('fails closed on a missing/invalid scoped snapshot without affecting another game', async () => {
    const report = vi.fn(),
      rpc = vi.fn().mockResolvedValue({ data: null, error: 'unavailable' });
    const state = new HorseGameArrivals(rpc, report);
    await state.load([table]);
    expect(state.candidateAllowed(table, ranked[0])).toBe(false);
    expect(state.releasedAllowed(table, ranked[0])).toBe(false);
    expect(state.releasedAllowed({ cluster_id: 'other', settings: {} }, 'any')).toBe(true);
    expect(report).toHaveBeenCalledOnce();
  });
  it('releases four ranked normally eligible identities, and only those count as buyers', async () => {
    const rpc = vi
      .fn()
      .mockResolvedValueOnce({
        data: { version: 1, complete: true, games: [snapshot()] },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { version: 1, game: snapshot(ranked.slice(0, 4), 0) },
        error: null,
      });
    const state = new HorseGameArrivals(rpc, () => {});
    await state.load([table]);
    expect(state.candidateAllowed(table, 'outsider')).toBe(false);
    expect(state.releasedAllowed(table, ranked[0])).toBe(false);
    await state.releaseEligible(
      table,
      [...ranked].reverse().map((id) => ({ id }))
    );
    expect(rpc.mock.calls[1][1].p_horse_ids).toEqual(ranked.slice(0, 4));
    expect(state.releasedAllowed(table, ranked[3])).toBe(true);
    expect(state.releasedAllowed(table, ranked[4])).toBe(false);
    await state.releaseEligible(
      table,
      ranked.map((id) => ({ id }))
    );
    expect(rpc).toHaveBeenCalledTimes(2);
  });
  it('does not release an unavailable preferred horse; rank the remaining normal candidates', async () => {
    const rpc = vi
      .fn()
      .mockResolvedValueOnce({
        data: { version: 1, complete: true, games: [snapshot(ranked.slice(0, 4), 1)] },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { version: 1, game: snapshot([...ranked.slice(0, 4), ranked[5]], 0) },
        error: null,
      });
    const state = new HorseGameArrivals(rpc, () => {});
    await state.load([table]);
    await state.releaseEligible(table, [{ id: ranked[7] }, { id: ranked[5] }]);
    expect(rpc.mock.calls[1][1].p_horse_ids).toEqual([ranked[5]]);
  });
  it('unknown release acknowledgment closes the game until durable readback; replay identity survives restart', async () => {
    const requests: string[] = [];
    for (let i = 0; i < 2; i++) {
      const rpc = vi
        .fn()
        .mockResolvedValueOnce({
          data: { version: 1, complete: true, games: [snapshot(ranked.slice(0, 4), 1)] },
          error: null,
        })
        .mockImplementationOnce((_name, args) => {
          requests.push(args.p_request_id);
          return Promise.resolve({ data: null, error: 'timeout' });
        });
      const state = new HorseGameArrivals(rpc, () => {});
      await state.load([table]);
      await state.releaseEligible(table, [{ id: ranked[4] }]);
      expect(state.releasedAllowed(table, ranked[0])).toBe(false);
    }
    expect(requests[0]).toBe(requests[1]);
  });
  it('treats malformed, duplicate, or missing markers/snapshots as scoped refusal', async () => {
    expect(parseArrivalSnapshot(snapshot(), 'game', 'wrong')).toBeNull();
    expect(
      parseArrivalSnapshot(
        { ...snapshot(), released_ids: [ranked[0], ranked[0]] },
        'game',
        'policy'
      )
    ).toBeNull();
    expect(parseArrivalSnapshot(snapshot([ranked[0]], 4), 'game', 'policy')).toBeNull();
    const state = new HorseGameArrivals(
      async () => ({ data: { version: 1, complete: true, games: [] }, error: null }),
      () => {}
    );
    await state.load([table]);
    expect(state.releasedAllowed(table, ranked[0])).toBe(false);
    expect(
      state.releasedAllowed({ cluster_id: 'bad', settings: { horse_arrivals: false } }, ranked[0])
    ).toBe(false);
  });
  it('does not let a later valid table marker hide a malformed marker for the same game', async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: { version: 1, complete: true, games: [snapshot()] },
      error: null,
    });
    const state = new HorseGameArrivals(rpc, () => {});
    await state.load([{ cluster_id: 'game', settings: { horse_arrivals: { version: 1 } } }, table]);
    expect(state.candidateAllowed(table, ranked[0])).toBe(false);
  });
  it('rejoins share released membership and no refill releases another identity', async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: { version: 1, complete: true, games: [snapshot(ranked.slice(0, 5), 0)] },
      error: null,
    });
    const state = new HorseGameArrivals(rpc, () => {});
    await state.load([table]);
    expect(state.releasedAllowed(table, ranked[0])).toBe(true);
    expect(state.releasedAllowed({ ...table }, ranked[0])).toBe(true);
    await state.releaseEligible(
      table,
      ranked.map((id) => ({ id }))
    );
    expect(rpc).toHaveBeenCalledOnce();
  });
});
