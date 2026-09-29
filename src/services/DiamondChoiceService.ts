import { supabase } from '../lib/supabase';
import { earnedReceiptBudget } from '../utils/bonusGameBudget';
import { validBonusMinimum } from '../utils/diamondBonusPayout';
import {
  CHOICE_PAYOUT_VERSION,
  MINE_COUNTS,
  ROAD_LADDERS,
  ROAD_LADDERS_V4,
  type ChoiceGame,
  type ChoiceProof,
} from '../utils/diamondChoiceMath';

/** Every setting a round of this game, sealed under this contract, may name.
 *  Mirrors public.fn_choice_ladder_v4 / fn_choice_ladder and the mine counts. */
export function choiceModes(game: ChoiceGame, payoutVersion?: number): string[] {
  if (game === 'mines') return MINE_COUNTS.map(String);
  return Object.keys(
    (payoutVersion ?? 0) >= CHOICE_PAYOUT_VERSION ? ROAD_LADDERS_V4 : ROAD_LADDERS
  );
}

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
  /** 1: no floor (historical). 2: a tenth of the stake. 3: the Super half.
   *  4: half the stake, or for a Super award what the player paid, with the
   *  first step of the game certain (owner ruling 2026-09-21, R3). */
  payout_version?: 1 | 2 | 3 | 4;
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
  // The contract this receipt says it was sealed under; 0 is the oldest of all.
  // Written without a `payout_version : <digit>` shape on purpose: that is the
  // exact spelling scripts/ci/check-diamond-contract-parity.mjs reads as a
  // version the client ACCEPTS, and a fallback is not an accepted version.
  const version = Number.isSafeInteger(v.payout_version) ? Number(v.payout_version) : 0;
  const sealedV4 = version >= CHOICE_PAYOUT_VERSION;
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
    // THE SETTING A ROUND MAY NAME IS ITS OWN CONTRACT'S (2026-09-23). Mines
    // has always dealt one of four counts; the road's ladders were retired one
    // at a time, so a contract-4 crossing round may name only the road the v4
    // ladder deals, while a round sealed earlier keeps the ladder it was dealt.
    !choiceModes(v.game === 'mines' ? 'mines' : 'crossing', version).includes(String(v.mode))
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
      BigInt(p.road_roll) >= 281474976710656n ||
      // A receipt is sealed under ONE contract and says which one it was, so a
      // proof that disagrees with its own round about that is not this round's
      // proof. Only the contract-4 boundary is compared: a round dealt before
      // the proof carried a version at all still verifies as what it is.
      (p.payout_version ?? 0) >= CHOICE_PAYOUT_VERSION !== sealedV4 ||
      // CONTRACT 4 mines: the board is dealt at the first pick, around it, so
      // it could not have been known before the player touched a tile. The
      // proof names that tile; without it the board is unverifiable in the
      // browser, and named as any other tile it is not the board this seed
      // makes. Mirrors public.fn_choice_board_v4.
      (v.game === 'mines' &&
        sealedV4 &&
        (p.first_pick !== v.picked[0] || p.mine_cells.includes(v.picked[0])))
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

/** What the player reads when the database raised an error on a move. */
export const MOVE_NOT_TAKEN = 'The Game Could Not Take That Move';

/**
 * The server answered a move and did not make it (review 2026-09-22).
 *
 * fn_choice_act refuses with {ok:false,error} before it changes anything: the
 * maintenance break, a tile already turned, a cash-out before the first move.
 * The page read every such answer as a lost one, said "Confirming Your Move",
 * read the unchanged round back and dropped the reason, so the break was never
 * shown. A refusal is an answer: the page shows its reason and reads the game
 * again. Only an answer that never arrived is confirmed by reading the round.
 */
export class ChoiceMoveRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChoiceMoveRefused';
  }
}

/** SQLSTATEs that pass: that execution rolled back, but the next may not. */
const PASSING_SQLSTATES = new Set(['40001', '40P01', '55P03', '57014']);
/**
 * Whether an error from fn_choice_act is the database's answer. It is the rule
 * the start doors follow (DiamondBonusService.bonusErrorKind, pinned to agree
 * by tests/unit/diamondChoiceMoveAnswers.test.ts): a SQLSTATE means the
 * database ran the move and rolled it back, and PostgREST's own codes mean it
 * never ran, so nothing moved and a resend gets the same answer. The passing
 * SQLSTATEs, PGRST000-003 (the database was not reached) and an error with no
 * code at all say nothing final, so the page reads the round back.
 */
export function moveRefusedByDatabase(error: unknown): boolean {
  const code =
    error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string'
      ? (error as { code: string }).code
      : '';
  if (code.startsWith('PGRST')) return !/^PGRST00[0-3]$/.test(code);
  return /^[0-9A-Z]{5}$/.test(code) && !PASSING_SQLSTATES.has(code);
}

export const DiamondChoiceService = {
  async state(club: string, game: ChoiceGame, mode: string, bet: number): Promise<ChoiceState> {
    const v = object(
      await rpc('fn_choice_state', { p_club_id: club, p_game: game, p_mode: mode, p_bet: bet })
    );
    return parseChoiceState(v, club, game);
  },
  /** One move on an open round. A round is only ever opened through
   * DiamondBonusService.start, which saves the wager before it is sent. */
  async act(round: ChoiceRound, action: 'pick' | 'cashout', cell: number | null) {
    let answer: unknown;
    try {
      answer = await rpc('fn_choice_act', {
        p_round_id: round.id,
        p_action: action,
        p_cell: cell,
        p_expected_step: round.picked.length,
      });
    } catch (error) {
      if (moveRefusedByDatabase(error)) throw new ChoiceMoveRefused(MOVE_NOT_TAKEN);
      throw error;
    }
    const refusal = answer as { ok?: unknown; error?: unknown } | null;
    if (refusal?.ok === false && typeof refusal.error === 'string')
      throw new ChoiceMoveRefused(refusal.error);
    const next = parseChoiceRound(answer);
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
