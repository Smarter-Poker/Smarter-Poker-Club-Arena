import { supabase } from '../lib/supabase';
import { earnedReceiptBudget } from '../utils/bonusGameBudget';
import { validBonusMinimum } from '../utils/diamondBonusPayout';
import {
  MINE_COUNTS,
  ROAD_LADDERS,
  type ChoiceGame,
  type ChoiceProof,
} from '../utils/diamondChoiceMath';

export interface ChoiceRound {
  ok: true;
  id: string;
  game: ChoiceGame;
  club_id: string;
  award_id?: string;
  status: 'open' | 'cashed' | 'lost';
  mode: string;
  bet_diamonds: number;
  bet_chips: number;
  diamonds_per_chip: number;
  picked: number[];
  max_steps: number;
  prizes: number[];
  payout_chips: number;
  minimum_payout_chips?: number;
  /** 1: no floor (historical). 2: a tenth of the stake. 3: the Super half. */
  payout_version?: 1 | 2 | 3;
  server_seed_hash: string;
  client_seed: string;
  nonce: number;
  commit_id: string;
  proof: ChoiceProof | null;
}
export interface ChoiceState {
  ok: true;
  available: boolean;
  frozen: boolean;
  reason: string | null;
  diamonds: number;
  member_chips: number;
  is_member: boolean;
  diamonds_per_chip: number;
  bets: number[];
  max_steps: number;
  prizes: number[];
  open_round: ChoiceRound | null;
  history: ChoiceRound[];
  rounds_today: number;
  daily_limit: number;
  diamonds_today: number;
  seconds_until_next: number;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('The Game Response Could Not Be Verified');
  const v = value as Record<string, unknown>;
  if (v.ok === false && typeof v.error === 'string') throw new Error(v.error);
  if (v.ok !== true) throw new Error('The Game Response Could Not Be Verified');
  return v;
}
export function parseChoiceRound(value: unknown): ChoiceRound {
  const v = object(value);
  const finite = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
  const cells = (x: unknown): x is number[] =>
    Array.isArray(x) &&
    x.every((n) => Number.isInteger(n) && n >= 0 && n < 25) &&
    new Set(x).size === x.length;
  if (
    typeof v.id !== 'string' ||
    !/^[a-f0-9-]{36}$/i.test(v.id) ||
    !['crossing', 'mines'].includes(String(v.game)) ||
    !['open', 'cashed', 'lost'].includes(String(v.status)) ||
    !cells(v.picked) ||
    !Array.isArray(v.prizes) ||
    !v.prizes.every((x) => finite(x) && x > 0) ||
    !Number.isInteger(v.max_steps) ||
    Number(v.max_steps) < 1 ||
    Number(v.max_steps) > 20 ||
    v.prizes.length !== v.max_steps ||
    v.picked.length > Number(v.max_steps) ||
    typeof v.payout_chips !== 'number' ||
    !Number.isFinite(v.payout_chips) ||
    typeof v.commit_id !== 'string' ||
    v.payout_chips < 0 ||
    typeof v.club_id !== 'string' ||
    typeof v.server_seed_hash !== 'string' ||
    !/^[a-f0-9]{64}$/.test(v.server_seed_hash) ||
    typeof v.client_seed !== 'string' ||
    !v.client_seed.length ||
    v.client_seed.length > 64 ||
    !Number.isSafeInteger(v.nonce) ||
    Number(v.nonce) < 1 ||
    !finite(v.bet_chips) ||
    v.bet_chips <= 0 ||
    !Number.isSafeInteger(v.bet_diamonds) ||
    Number(v.bet_diamonds) < 25 ||
    (v.award_id !== undefined && !earnedReceiptBudget(v)) ||
    Number(v.bet_diamonds) > (earnedReceiptBudget(v) ? 7500 : 5000) ||
    !Number.isSafeInteger(v.diamonds_per_chip) ||
    Number(v.diamonds_per_chip) <= 0 ||
    Math.abs(Number(v.bet_diamonds) / Number(v.diamonds_per_chip) - v.bet_chips) > 1e-8 ||
    Math.abs(v.payout_chips * 100 - Math.round(v.payout_chips * 100)) > 1e-8 ||
    !(v.game === 'mines'
      ? MINE_COUNTS.map(String)
      : (Object.keys(ROAD_LADDERS) as string[])
    ).includes(String(v.mode))
  ) {
    throw new Error('The Game Response Could Not Be Verified');
  }
  if (
    (v.status !== 'open' && !v.picked.length) ||
    (v.status === 'open' && v.picked.length >= Number(v.max_steps))
  )
    throw new Error('The Game Response Could Not Be Verified');
  if (v.game === 'crossing' && v.picked.some((n, i) => n !== i))
    throw new Error('The Game Response Could Not Be Verified');
  if (v.status === 'open' && v.proof !== null)
    throw new Error('The Game Response Could Not Be Verified');
  if (
    !validBonusMinimum(v) ||
    (v.status === 'open' && v.payout_chips !== 0) ||
    (v.status === 'lost' && v.payout_chips !== (v.minimum_payout_chips ?? 0))
  )
    throw new Error('The Game Response Could Not Be Verified');
  if (v.status !== 'open') {
    const p = v.proof as ChoiceProof | null;
    if (
      !p ||
      p.game !== v.game ||
      p.server_seed_hash !== v.server_seed_hash ||
      p.client_seed !== v.client_seed ||
      p.nonce !== v.nonce ||
      typeof p.server_seed !== 'string' ||
      !/^[a-f0-9]{64}$/.test(p.server_seed) ||
      !cells(p.mine_cells) ||
      (p.game === 'mines' && (p.mines !== Number(v.mode) || p.mine_cells.length !== p.mines)) ||
      (p.game === 'crossing' && (p.mines !== 0 || p.mine_cells.length !== 0)) ||
      typeof p.road_roll !== 'string' ||
      !/^\d+$/.test(p.road_roll) ||
      BigInt(p.road_roll) >= 281474976710656n
    ) {
      throw new Error('The Game Response Could Not Be Verified');
    }
  }
  return v as unknown as ChoiceRound;
}

export function parseChoiceState(value: unknown, club: string, game: ChoiceGame): ChoiceState {
  const v = object(value);
  if (
    typeof v.available !== 'boolean' ||
    typeof v.frozen !== 'boolean' ||
    ![v.rounds_today, v.daily_limit, v.diamonds_today, v.seconds_until_next].every(
      (n) => Number.isSafeInteger(n) && Number(n) >= 0
    ) ||
    !Array.isArray(v.prizes) ||
    !Array.isArray(v.bets) ||
    !Array.isArray(v.history) ||
    !Number.isInteger(v.max_steps) ||
    typeof v.is_member !== 'boolean' ||
    typeof v.member_chips !== 'number' ||
    !Number.isFinite(v.member_chips) ||
    v.member_chips < 0 ||
    typeof v.diamonds !== 'number' ||
    !Number.isFinite(v.diamonds) ||
    v.diamonds < 0 ||
    !Number.isSafeInteger(v.diamonds_per_chip) ||
    Number(v.diamonds_per_chip) < 1 ||
    !v.prizes.every((p) => typeof p === 'number' && Number.isFinite(p) && p > 0) ||
    v.prizes.length !== v.max_steps
  ) {
    throw new Error('The Game Response Could Not Be Verified');
  }
  if (v.open_round !== null) v.open_round = parseChoiceRound(v.open_round);
  v.history = v.history.map(parseChoiceRound);
  const rows = [
    ...(v.open_round ? [v.open_round as ChoiceRound] : []),
    ...(v.history as ChoiceRound[]),
  ];
  if (rows.some((row) => row.game !== game || row.club_id !== club))
    throw new Error('The Round Belongs To A Different Club');
  return v as unknown as ChoiceState;
}

async function rpc(name: string, args: Record<string, unknown>) {
  const { data, error } = await supabase.rpc(name as never, args as never);
  if (error) throw error;
  return data;
}

export const DiamondChoiceService = {
  async state(club: string, game: ChoiceGame, mode: string, bet: number): Promise<ChoiceState> {
    const v = object(
      await rpc('fn_choice_state', { p_club_id: club, p_game: game, p_mode: mode, p_bet: bet })
    );
    return parseChoiceState(v, club, game);
  },
  async start(
    club: string,
    game: ChoiceGame,
    mode: string,
    bet: number,
    commit: string,
    seed: string,
    maxSteps: number
  ) {
    return parseChoiceRound(
      await rpc('fn_choice_start', {
        p_club_id: club,
        p_game: game,
        p_mode: mode,
        p_bet: bet,
        p_commit_id: commit,
        p_client_seed: seed,
        p_max_steps: maxSteps,
      })
    );
  },
  async act(round: ChoiceRound, action: 'pick' | 'cashout', cell: number | null) {
    const next = parseChoiceRound(
      await rpc('fn_choice_act', {
        p_round_id: round.id,
        p_action: action,
        p_cell: cell,
        p_expected_step: round.picked.length,
      })
    );
    const immutable = [
      'id',
      'award_id',
      'game',
      'club_id',
      'mode',
      'bet_diamonds',
      'bet_chips',
      'diamonds_per_chip',
      'max_steps',
      'commit_id',
      'server_seed_hash',
      'client_seed',
      'nonce',
    ] as const;
    if (
      immutable.some((field) => next[field] !== round[field]) ||
      JSON.stringify(earnedReceiptBudget(next as unknown as Record<string, unknown>)) !==
        JSON.stringify(earnedReceiptBudget(round as unknown as Record<string, unknown>)) ||
      next.prizes.some((prize, index) => prize !== round.prizes[index]) ||
      next.picked.length < round.picked.length ||
      round.picked.some((cell, index) => next.picked[index] !== cell)
    )
      throw new Error('The Result Does Not Match Your Saved Round');
    return next;
  },
};
