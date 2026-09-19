import { beforeEach, describe, expect, it, vi } from 'vitest';
import receipts from '../fixtures/diamond-spins/wheel-v3-postgres-receipts.json';
import {
  DiamondReplayService,
  bonusReplayTitle,
  parseBonusReplay,
} from '../../src/services/DiamondReplayService';

const rpc = vi.hoisted(() => vi.fn());
vi.mock('../../src/lib/supabase', () => ({ supabase: { rpc } }));
const id = '11111111-1111-4111-8111-111111111111';
const completed_at = '2026-09-19T12:00:00.000Z';
const base = { version: 1, completed_at, diamonds: 100, boost: 1, payout_chips: 0.1 };
const crash = {
  ...base,
  game: 'crash',
  data: {
    status: 'crashed',
    growth_k: 0.12,
    cap_cents: 10000,
    elapsed_ms: 1000,
    cashout_cents: null,
    crash_cents: 110,
    auto_cashout_cents: null,
  },
};
const mines = {
  ...base,
  game: 'mines',
  data: {
    status: 'lost',
    mode: '5',
    picked: [0, 2],
    prizes: [1, 2],
    mine_cells: [2, 6, 8, 19, 24],
    road_end: null,
  },
};
const crossing = {
  ...base,
  game: 'crossing',
  data: {
    status: 'lost',
    mode: 'steady',
    picked: [0, 1],
    prizes: [1.1, 1.35, 1.7],
    mine_cells: [],
    road_end: 1,
  },
};

beforeEach(() => rpc.mockReset());
describe('completed Diamond replay parsing', () => {
  it.each(['plinko', 'crash', 'crossing', 'mines'])(
    'accepts normal and Super %s from retained native receipts',
    (game) => {
      for (const boost of [1, 2]) {
        const record = receipts.records.find(
          (r) =>
            r.kind === 'action' &&
            r.game === game &&
            (r.value as Record<string, any>).bonus?.boost_multiplier === boost
        )!;
        const raw = record.value as Record<string, any>;
        const data =
          game === 'plinko'
            ? {
                multipliers_cents: raw.multipliers_cents,
                drops: raw.drops,
                diamonds_per_drop: raw.diamonds_per_drop,
                table_name: raw.table_name,
              }
            : game === 'crash'
              ? {
                  status: raw.status,
                  growth_k: raw.growth_k,
                  cap_cents: raw.cap_cents,
                  elapsed_ms: raw.elapsed_ms,
                  cashout_cents: raw.outcome.cashout_cents,
                  crash_cents: raw.outcome.crash_cents,
                  auto_cashout_cents: raw.auto_cashout_cents,
                }
              : {
                  status: raw.status,
                  mode: raw.mode,
                  picked: raw.picked,
                  prizes: raw.prizes,
                  mine_cells: raw.proof.mine_cells,
                  road_end: game === 'crossing' ? 0 : null,
                };
        const replay = parseBonusReplay({
          ...base,
          game,
          boost,
          diamonds: raw.bet_diamonds,
          payout_chips: raw.outcome?.payout_chips ?? raw.payout_chips,
          data,
        });
        expect(replay.game).toBe(game);
        expect(replay.boost).toBe(boost);
        expect(replay.diamonds).toBe(raw.bonus.total_diamonds);
        expect(bonusReplayTitle(replay)).toBe(
          boost === 2
            ? {
                plinko: 'Super Plinko',
                crash: 'Super Crash',
                crossing: 'Super Donkey Cross',
                mines: 'Super Diamond Mines',
              }[game]
            : {
                plinko: 'Diamond Plinko',
                crash: 'Diamond Crash',
                crossing: 'Donkey Cross',
                mines: 'Diamond Mines',
              }[game]
        );
      }
    }
  );
  it.each([
    null,
    [],
    {},
    { ...crash, completed_at: 0 },
    { ...crash, boost: 3 },
    { ...crash, diamonds: 0 },
    { ...crash, diamonds: 7501 },
    { ...crash, payout_chips: 0.001 },
    { ...crash, data: { ...crash.data, status: 'open' } },
    { ...crash, data: { ...crash.data, elapsed_ms: 2147483648 } },
    { ...crash, data: { ...crash.data, cashout_cents: 105 } },
    { ...crash, data: { ...crash.data, status: 'cashed', cashout_cents: 120 } },
    { ...crash, data: { ...crash.data, auto_cashout_cents: '200' } },
    { ...crash, data: { ...crash.data, auto_cashout_cents: 10001 } },
    { ...mines, data: { ...mines.data, mode: 'unknown' } },
    { ...mines, data: { ...mines.data, mine_cells: [2, 2, 8, 19, 24] } },
    { ...mines, data: { ...mines.data, status: 'cashed' } },
    { ...mines, data: { ...mines.data, picked: [2, 0] } },
    { ...crossing, data: { ...crossing.data, road_end: 2 } },
    { ...crossing, data: { ...crossing.data, status: 'cashed', road_end: 0 } },
    { ...crossing, data: { ...crossing.data, picked: [0, 2] } },
  ])('rejects invalid or contradictory replay %#', (value) => {
    expect(() => parseBonusReplay(value)).toThrow(/Replay Could Not Be Read/);
  });
  it('accepts the persisted elapsed time of a Crash settled after a long offline delay', () => {
    const replay = { ...crash, data: { ...crash.data, elapsed_ms: 2147483647 } };
    expect(parseBonusReplay(replay)).toEqual(replay);
  });
  it('refuses altered Plinko paths and totals without replacing recorded results', () => {
    const record = receipts.records.find((r) => r.kind === 'action' && r.game === 'plinko')!;
    const raw = record.value as Record<string, any>;
    const replay = {
      ...base,
      game: 'plinko',
      payout_chips: raw.payout_chips,
      data: {
        multipliers_cents: raw.multipliers_cents,
        drops: raw.drops,
        diamonds_per_drop: raw.diamonds_per_drop,
        table_name: raw.table_name,
      },
    };
    for (const patch of [
      { path_bits: 65536 },
      { slot: 16 },
      { multiplier_cents: -1 },
      { payout_chips: 0.001 },
    ]) {
      expect(() =>
        parseBonusReplay({
          ...replay,
          data: { ...replay.data, drops: [{ ...raw.drops[0], ...patch }, ...raw.drops.slice(1)] },
        })
      ).toThrow();
    }
    expect(() => parseBonusReplay({ ...replay, payout_chips: raw.payout_chips + 1 })).toThrow();
  });
});

describe('replay service boundaries', () => {
  it('keeps private and public identifiers on their own read RPC', async () => {
    rpc.mockResolvedValue({ data: { ok: true, replay: crash }, error: null });
    expect(await DiamondReplayService.read(id)).toEqual(crash);
    expect(rpc).toHaveBeenLastCalledWith('fn_diamond_bonus_replay', { p_bonus_id: id });
    await DiamondReplayService.read(id, true);
    expect(rpc).toHaveBeenLastCalledWith('fn_diamond_bonus_shared', { p_share_id: id });
  });
  it('preserves the pagination cursor and confirmed amounts', async () => {
    const row = {
      id,
      game: 'crash' as const,
      created_at: completed_at,
      diamonds: 100,
      boost: 1,
      payout_chips: 1.23,
    };
    rpc.mockResolvedValue({ data: { ok: true, replays: [row] }, error: null });
    expect(await DiamondReplayService.list(id, row)).toEqual([row]);
    expect(rpc).toHaveBeenCalledExactlyOnceWith('fn_diamond_bonus_replays', {
      p_club_id: id,
      p_before: completed_at,
      p_before_id: id,
    });
  });
  it.each([
    null,
    { id, game: 'crash', created_at: completed_at, diamonds: 0, boost: 1, payout_chips: 1 },
    { id, game: 'crash', created_at: completed_at, diamonds: 100, boost: 1, payout_chips: 0.001 },
  ])('refuses unreadable summary %# with a useful error', async (row) => {
    rpc.mockResolvedValue({ data: { ok: true, replays: [row] }, error: null });
    await expect(DiamondReplayService.list(id)).rejects.toThrow(
      'Your Bonus History Could Not Be Read'
    );
  });
  it('does not send malformed read, share, or social post identifiers', async () => {
    await expect(DiamondReplayService.read('bad')).rejects.toThrow();
    await expect(DiamondReplayService.share('bad')).rejects.toThrow();
    await expect(DiamondReplayService.post('bad')).rejects.toThrow();
    expect(rpc).not.toHaveBeenCalled();
  });
  it('returns only confirmed sharing receipts and propagates refusals', async () => {
    rpc.mockResolvedValueOnce({ data: { ok: true, share_id: id }, error: null });
    expect(await DiamondReplayService.share(id)).toEqual({
      id,
      url: `https://smarter.poker/hub/club-arena/bonus-replay/${id}`,
    });
    rpc.mockResolvedValueOnce({ data: { ok: true, post_id: id }, error: null });
    expect(await DiamondReplayService.post(id)).toBe(id);
    rpc.mockResolvedValueOnce({
      data: { ok: false, error: 'Finish This Bonus Before Replaying It' },
      error: null,
    });
    await expect(DiamondReplayService.read(id)).rejects.toThrow('Finish This Bonus');
    rpc.mockResolvedValueOnce({ data: null, error: new Error('Connection Lost') });
    await expect(DiamondReplayService.list(id)).rejects.toThrow('Connection Lost');
  });
});
