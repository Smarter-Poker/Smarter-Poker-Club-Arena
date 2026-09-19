import { supabase } from '../lib/supabase';
import type { BonusGame, PlinkoBall } from './DiamondBonusService';
import { PLINKO_DIAMONDS_PER_DROP } from '../utils/bonusGameBudget';
import { MINE_COUNTS, ROAD_LADDERS } from '../utils/diamondChoiceMath';

export interface BonusReplaySummary {
  id: string;
  game: BonusGame;
  created_at: string;
  diamonds: number;
  boost: number;
  payout_chips: number;
}
interface ReplayBase {
  version: 1;
  completed_at: string;
  diamonds: number;
  boost: number;
  payout_chips: number;
}
export type BonusReplay = ReplayBase &
  (
    | {
        game: 'plinko';
        data: {
          multipliers_cents: number[];
          drops: PlinkoBall[];
          diamonds_per_drop: number;
          table_name: string;
        };
      }
    | {
        game: 'crash';
        data: {
          status: 'cashed' | 'crashed';
          growth_k: number;
          cap_cents: number;
          elapsed_ms: number;
          cashout_cents: number | null;
          crash_cents: number;
          auto_cashout_cents: number | null;
        };
      }
    | {
        game: 'mines' | 'crossing';
        data: {
          status: 'cashed' | 'lost';
          mode: string;
          picked: number[];
          prizes: number[];
          mine_cells: number[] | null;
          road_end: number | null;
        };
      }
  );
const uuid = (v: unknown): v is string =>
  typeof v === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const integer = (v: unknown): v is number => finite(v) && Number.isSafeInteger(v);
const amount = (v: unknown): v is number =>
  finite(v) && Math.abs(v * 100 - Math.round(v * 100)) < 1e-8;
const date = (v: unknown) => typeof v === 'string' && Number.isFinite(Date.parse(v));
const game = (v: unknown) =>
  typeof v === 'string' && ['plinko', 'crash', 'crossing', 'mines'].includes(v);

export function parseBonusReplay(value: unknown): BonusReplay {
  const r = value as BonusReplay;
  if (
    !r ||
    typeof r !== 'object' ||
    Array.isArray(r) ||
    r.version !== 1 ||
    !game(r.game) ||
    !integer(r.diamonds) ||
    r.diamonds < 25 ||
    r.diamonds > 7500 ||
    ![1, 2].includes(r.boost) ||
    !amount(r.payout_chips) ||
    !date(r.completed_at) ||
    !r.data ||
    typeof r.data !== 'object' ||
    Array.isArray(r.data)
  )
    throw new Error('This Bonus Replay Could Not Be Read');
  if (r.game === 'plinko') {
    const d = r.data;
    if (
      !Array.isArray(d.multipliers_cents) ||
      d.multipliers_cents.length !== 17 ||
      !d.multipliers_cents.every(integer) ||
      !integer(d.diamonds_per_drop) ||
      !PLINKO_DIAMONDS_PER_DROP.some((n) => n === d.diamonds_per_drop) ||
      typeof d.table_name !== 'string' ||
      !Array.isArray(d.drops) ||
      d.drops.length !== r.diamonds / d.diamonds_per_drop ||
      d.drops.some(
        (b, i) =>
          !b ||
          b.index !== i ||
          !integer(b.path_bits) ||
          b.path_bits > 65535 ||
          !integer(b.slot) ||
          b.slot > 16 ||
          Array.from({ length: 16 }, (_, bit) => (b.path_bits >> bit) & 1).reduce(
            (a, b) => a + b,
            0
          ) !== b.slot ||
          b.multiplier_cents !== d.multipliers_cents[b.slot] ||
          !amount(b.payout_chips)
      ) ||
      d.drops.reduce((n, b) => n + Math.round(b.payout_chips * 100), 0) !==
        Math.round(r.payout_chips * 100)
    )
      throw new Error('This Plinko Replay Could Not Be Read');
  } else if (r.game === 'crash') {
    const d = r.data;
    if (
      !['cashed', 'crashed'].includes(d.status) ||
      !finite(d.growth_k) ||
      d.growth_k <= 0 ||
      !integer(d.cap_cents) ||
      d.cap_cents < 101 ||
      !integer(d.crash_cents) ||
      d.crash_cents < 100 ||
      !integer(d.elapsed_ms) ||
      d.elapsed_ms > 2147483647 ||
      (d.auto_cashout_cents !== null &&
        (!integer(d.auto_cashout_cents) ||
          d.auto_cashout_cents < 101 ||
          d.auto_cashout_cents > d.cap_cents)) ||
      (d.status === 'crashed' && d.cashout_cents !== null) ||
      (d.status === 'cashed' &&
        (!integer(d.cashout_cents) ||
          d.cashout_cents < 101 ||
          d.cashout_cents > Math.min(d.cap_cents, d.crash_cents)))
    )
      throw new Error('This Crash Replay Could Not Be Read');
  } else {
    const d = r.data;
    if (
      !['cashed', 'lost'].includes(d.status) ||
      !Array.isArray(d.picked) ||
      d.picked.length < 1 ||
      d.picked.length > 25 ||
      new Set(d.picked).size !== d.picked.length ||
      d.picked.some((n) => !integer(n) || n > 24) ||
      !Array.isArray(d.prizes) ||
      d.prizes.length < d.picked.length ||
      d.prizes.length > 25 ||
      !d.prizes.every((n, i) => finite(n) && n > 0 && (i === 0 || n >= d.prizes[i - 1])) ||
      (r.game === 'mines' &&
        (!MINE_COUNTS.some((n) => String(n) === d.mode) ||
          !Array.isArray(d.mine_cells) ||
          d.mine_cells.length !== Number(d.mode) ||
          new Set(d.mine_cells).size !== d.mine_cells.length ||
          d.mine_cells.some((n) => !integer(n) || n > 24) ||
          d.picked.slice(0, -1).some((n) => d.mine_cells!.includes(n)) ||
          d.mine_cells.includes(d.picked[d.picked.length - 1]) !== (d.status === 'lost'))) ||
      (r.game === 'crossing' &&
        (!Object.hasOwn(ROAD_LADDERS, d.mode) ||
          !integer(d.road_end) ||
          d.road_end > d.prizes.length ||
          d.picked.some((n, i) => n !== i) ||
          (d.status === 'lost'
            ? d.road_end !== d.picked.length - 1
            : d.road_end < d.picked.length)))
    )
      throw new Error('This Bonus Replay Could Not Be Read');
  }
  return r;
}
export function bonusReplayTitle(r: Pick<BonusReplay, 'game' | 'boost'>) {
  const names = {
    plinko: 'Plinko',
    crash: 'Crash',
    crossing: 'Donkey Cross',
    mines: 'Diamond Mines',
  };
  if (r.boost === 2) return `Super ${names[r.game]}`;
  return r.game === 'plinko' || r.game === 'crash' ? `Diamond ${names[r.game]}` : names[r.game];
}
async function call(name: string, args: Record<string, unknown>) {
  const { data, error } = await supabase.rpc(name, args);
  if (error) throw error;
  if (!data || data.ok !== true)
    throw new Error(data?.error || 'The Replay Request Could Not Be Completed');
  return data;
}
export const DiamondReplayService = {
  async list(clubId: string, before?: BonusReplaySummary): Promise<BonusReplaySummary[]> {
    const result = await call('fn_diamond_bonus_replays', {
      p_club_id: clubId,
      p_before: before?.created_at ?? null,
      p_before_id: before?.id ?? null,
    });
    if (
      !Array.isArray(result.replays) ||
      result.replays.some(
        (r: BonusReplaySummary) =>
          !r ||
          !uuid(r.id) ||
          !game(r.game) ||
          !amount(r.payout_chips) ||
          !integer(r.diamonds) ||
          r.diamonds < 25 ||
          r.diamonds > 7500 ||
          ![1, 2].includes(r.boost) ||
          !date(r.created_at)
      )
    )
      throw new Error('Your Bonus History Could Not Be Read');
    return result.replays;
  },
  async read(id: string, shared = false) {
    if (!uuid(id)) throw new Error('Replay Not Found');
    const result = await call(
      shared ? 'fn_diamond_bonus_shared' : 'fn_diamond_bonus_replay',
      shared ? { p_share_id: id } : { p_bonus_id: id }
    );
    return parseBonusReplay(result.replay);
  },
  async share(id: string) {
    if (!uuid(id)) throw new Error('Replay Not Found');
    const result = await call('fn_diamond_bonus_share', { p_bonus_id: id });
    if (!uuid(result.share_id)) throw new Error('The Replay Link Could Not Be Created');
    return {
      id: result.share_id,
      url: `https://smarter.poker/hub/club-arena/bonus-replay/${result.share_id}`,
    };
  },
  async post(shareId: string) {
    if (!uuid(shareId)) throw new Error('Replay Not Found');
    const result = await call('fn_diamond_bonus_share_to_feed', { p_share_id: shareId });
    if (!uuid(result.post_id)) throw new Error('The Shared Post Could Not Be Confirmed');
    return result.post_id as string;
  },
};
