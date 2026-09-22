/** Internal game mathematics. Presentation never advertises return percentages. */
import { hmacSha256Hex, sha256Hex } from './wheelFairness';

export type ChoiceGame = 'crossing' | 'mines';
/** One road is dealt today (2026-09-19): twelve streets, 1.10x to 20.00x, so
 * every street sits inside every award's cover. The three risk ladders remain
 * so a sealed round and its replay keep verifying; no new round may name them.
 * Mirrors public.fn_choice_ladder. */
export const ROAD_LADDERS = {
  road: [110, 145, 185, 245, 315, 410, 535, 700, 910, 1180, 1540, 2000],
  steady: [110, 135, 170, 215, 275, 355, 460, 600, 800, 1100, 1600, 2400],
  bold: [150, 220, 330, 500, 800, 1300, 2200, 4000, 7500, 15000],
  extreme: [200, 400, 800, 1600, 3200, 6400, 12800, 25600],
} as const;
export type RoadRisk = keyof typeof ROAD_LADDERS;
/** CONTRACT 4 (Dan, 2026-09-21, R3): the first street is always successful. It
 * pays 0.80x, so the survival identity P(reach) = (0.8B - L)/(prize - L) makes it
 * certain with no special case: (roll + 1)(0.8B - L) <= (0.8B - L) 2^48 for every
 * roll. The player still chooses at street one (bank 0.80x or cross street two)
 * and every street is worth exactly 0.80B. Mirrors public.fn_choice_ladder_v4. */
export const ROAD_LADDERS_V4 = {
  road: [80, 145, 185, 245, 315, 410, 535, 700, 910, 1180, 1540, 2000],
} as const;
/** The contract every choice round sealed since 2026-09-21 carries. */
export const CHOICE_PAYOUT_VERSION = 4;
/** The ladder a round's mode names under its sealed contract. */
export function roadLadder(mode: string, payoutVersion?: number): readonly number[] | undefined {
  if ((payoutVersion ?? 0) >= CHOICE_PAYOUT_VERSION)
    return ROAD_LADDERS_V4[mode as keyof typeof ROAD_LADDERS_V4];
  return ROAD_LADDERS[mode as RoadRisk];
}
/** Six mines are dealt today; five, ten and fifteen remain readable for sealed boards. */
export const MINE_COUNTS = [5, 6, 10, 15] as const;
/** The one setting per game. Nobody chooses a difficulty: the payout carries it.
 * Mirrors public.fn_choice_mode. */
export const CHOICE_MODE = { crossing: 'road', mines: '6' } as const;
export const RANDOM_SPACE = 281474976710656n;

export function choose(n: number, k: number): bigint {
  if (!Number.isInteger(n) || !Number.isInteger(k) || n < 0 || k < 0 || k > n) return 0n;
  let value = 1n;
  for (let i = 1; i <= Math.min(k, n - k); i++) value = (value * BigInt(n - i + 1)) / BigInt(i);
  return value;
}

/** An exact rational number of chip cents, before unbiased settlement rounding. */
export function minePrize(betChips: number, mines: number, picks: number, minimumPayoutChips = 0) {
  if (
    !Number.isFinite(betChips) ||
    betChips < 0.01 ||
    Math.abs(betChips * 100 - Math.round(betChips * 100)) > 1e-8 ||
    !MINE_COUNTS.includes(mines as (typeof MINE_COUNTS)[number]) ||
    !Number.isInteger(picks) ||
    picks < 1 ||
    picks > 25 - mines
  ) {
    throw new Error('Invalid Mines Prize');
  }
  const betCents = BigInt(Math.round(betChips * 100));
  const minimumCents = BigInt(Math.round(minimumPayoutChips * 100));
  if (minimumCents < 0n || minimumCents * 5n >= betCents * 4n)
    throw new Error('Invalid Mines Prize');
  const surviving = choose(25 - mines, picks);
  return {
    numerator:
      minimumCents * 5n * surviving + (betCents * 4n - minimumCents * 5n) * choose(25, picks),
    denominator: 5n * surviving,
  };
}

/** CONTRACT 4 (Dan, 2026-09-21, R3): the first tile is always a diamond. The
 * board is dealt at the first pick, around it: P(survive k) = C(24-m,k-1)/C(24,k-1),
 * so prize_k = L + (0.8B - L) C(24,k-1)/C(24-m,k-1) and the first gem pays 0.80B.
 * Exact rational chip cents. Mirrors public.fn_choice_prizes_v4 for mines. */
export function minePrizeV4(
  betChips: number,
  mines: number,
  picks: number,
  minimumPayoutChips: number
) {
  if (
    !Number.isFinite(betChips) ||
    betChips < 0.01 ||
    Math.abs(betChips * 100 - Math.round(betChips * 100)) > 1e-8 ||
    !MINE_COUNTS.includes(mines as (typeof MINE_COUNTS)[number]) ||
    !Number.isInteger(picks) ||
    picks < 1 ||
    picks > 25 - mines
  ) {
    throw new Error('Invalid Mines Prize');
  }
  const betCents = BigInt(Math.round(betChips * 100));
  const minimumCents = BigInt(Math.round(minimumPayoutChips * 100));
  if (minimumCents < 0n || minimumCents * 5n >= betCents * 4n)
    throw new Error('Invalid Mines Prize');
  const surviving = choose(24 - mines, picks - 1);
  return {
    numerator:
      minimumCents * 5n * surviving + (betCents * 4n - minimumCents * 5n) * choose(24, picks - 1),
    denominator: 5n * surviving,
  };
}

/** Uniform values use rejection sampling, so a board has no modulo bias. */
export async function mineBoard(
  serverSeed: string,
  clientSeed: string,
  nonce: number,
  mines: number
) {
  if (!MINE_COUNTS.includes(mines as (typeof MINE_COUNTS)[number]))
    throw new Error('Invalid Mine Count');
  const cells = Array.from({ length: 25 }, (_, i) => i);
  let cursor = 0;
  for (let i = 24; i > 0; i--) {
    const range = i + 1;
    const limit = Math.floor(4294967296 / range) * range;
    let value: number;
    do {
      const hash = await hmacSha256Hex(serverSeed, `${clientSeed}:${nonce}:board:${cursor++}`);
      value = Number.parseInt(hash.slice(0, 8), 16);
    } while (value >= limit);
    const j = value % range;
    [cells[i], cells[j]] = [cells[j], cells[i]];
  }
  return cells.slice(0, mines).sort((a, b) => a - b);
}

/** CONTRACT 4: the twenty-four cells other than the first pick, shuffled by the
 * same Fisher-Yates with rejection sampling, on a domain that names the first
 * pick, so the board could not have been known before it and a receipt can
 * reproduce it. Mirrors public.fn_choice_board_v4. */
export async function mineBoardV4(
  serverSeed: string,
  clientSeed: string,
  nonce: number,
  mines: number,
  firstPick: number
) {
  if (!MINE_COUNTS.includes(mines as (typeof MINE_COUNTS)[number]))
    throw new Error('Invalid Mine Count');
  if (!Number.isInteger(firstPick) || firstPick < 0 || firstPick > 24)
    throw new Error('Invalid First Pick');
  const cells = Array.from({ length: 25 }, (_, i) => i).filter((c) => c !== firstPick);
  let cursor = 0;
  for (let i = 23; i > 0; i--) {
    const range = i + 1;
    const limit = Math.floor(4294967296 / range) * range;
    let value: number;
    do {
      const hash = await hmacSha256Hex(
        serverSeed,
        `${clientSeed}:${nonce}:board:${firstPick}:${cursor++}`
      );
      value = Number.parseInt(hash.slice(0, 8), 16);
    } while (value >= limit);
    const j = value % range;
    [cells[i], cells[j]] = [cells[j], cells[i]];
  }
  return cells.slice(0, mines).sort((a, b) => a - b);
}

/** The edge is charged once. Every selectable crossing target has the same expectation. */
export function roadSurvives(
  roll: bigint,
  targetCents: number,
  betChips = 1,
  minimumPayoutChips = 0
) {
  // A target of 80 is contract 4's certain first street; nothing under it exists.
  if (roll < 0n || roll >= RANDOM_SPACE || !Number.isInteger(targetCents) || targetCents < 80) {
    throw new Error('Invalid Crossing Outcome');
  }
  const betCents = BigInt(Math.round(betChips * 100));
  const minimumCents = BigInt(Math.round(minimumPayoutChips * 100));
  if (betCents <= 0n || minimumCents < 0n || minimumCents * 5n >= betCents * 4n)
    throw new Error('Invalid Crossing Outcome');
  return (
    (roll + 1n) * 5n * (betCents * BigInt(targetCents) - 100n * minimumCents) <=
    100n * (4n * betCents - 5n * minimumCents) * RANDOM_SPACE
  );
}

/** Rounding happens only after the cash-out decision, on an independent sealed draw. */
export function roundedMinePrize(numerator: bigint, denominator: bigint, roll: bigint) {
  if (numerator < 0n || denominator <= 0n || roll < 0n || roll >= RANDOM_SPACE) {
    throw new Error('Invalid Prize Rounding');
  }
  const floor = numerator / denominator;
  const remainder = numerator % denominator;
  return floor + ((roll + 1n) * denominator <= remainder * RANDOM_SPACE ? 1n : 0n);
}

export interface ChoiceProof {
  game: ChoiceGame;
  server_seed: string;
  server_seed_hash: string;
  client_seed: string;
  nonce: number;
  mines: number;
  mine_cells: number[];
  road_roll: string;
  /** Contract 4 mines: the tile the board was dealt around. */
  first_pick?: number | null;
  /** The contract the round was sealed under; absent before 2026-09-21. */
  payout_version?: number;
}

export async function verifyChoiceProof(proof: ChoiceProof) {
  if ((await sha256Hex(proof.server_seed)) !== proof.server_seed_hash) return false;
  if (proof.game === 'mines') {
    const board =
      (proof.payout_version ?? 0) >= CHOICE_PAYOUT_VERSION
        ? typeof proof.first_pick === 'number'
          ? await mineBoardV4(
              proof.server_seed,
              proof.client_seed,
              proof.nonce,
              proof.mines,
              proof.first_pick
            )
          : null
        : await mineBoard(proof.server_seed, proof.client_seed, proof.nonce, proof.mines);
    return board !== null && JSON.stringify(board) === JSON.stringify(proof.mine_cells);
  }
  const hash = await hmacSha256Hex(proof.server_seed, `${proof.client_seed}:${proof.nonce}:road`);
  return BigInt(`0x${hash.slice(0, 12)}`).toString() === proof.road_roll;
}

/** Checks the selected cells, the complete prize ladder, and the settled chip cents. */
export async function verifyChoiceRound(
  round: Omit<import('../services/DiamondChoiceService').ChoiceRound, 'payout_version'> & {
    payout_version?: number;
  }
) {
  const proof = round.proof;
  const version = round.payout_version ?? 0;
  const sealedV4 = version >= CHOICE_PAYOUT_VERSION;
  if (!proof || !(await verifyChoiceProof(proof)) || !round.picked.length) return false;
  // A contract-4 board was dealt around the first pick, and says so.
  if (sealedV4 && round.game === 'mines' && proof.first_pick !== round.picked[0]) return false;
  if (sealedV4 !== (proof.payout_version ?? 0) >= CHOICE_PAYOUT_VERSION) return false;
  const ladder = roadLadder(round.mode, version) as readonly number[];
  if (round.game === 'crossing' && !ladder) return false;
  const prize = (picks: number) =>
    sealedV4
      ? minePrizeV4(round.bet_chips, Number(round.mode), picks, round.minimum_payout_chips ?? 0)
      : minePrize(round.bet_chips, Number(round.mode), picks, round.minimum_payout_chips ?? 0);
  for (let i = 0; i < round.prizes.length; i++) {
    const exact =
      round.game === 'mines'
        ? prize(i + 1)
        : {
            numerator: BigInt(Math.round(round.bet_chips * 100)) * BigInt(ladder[i]),
            denominator: 100n,
          };
    const chips = Number(exact.numerator) / Number(exact.denominator) / 100;
    if (Math.abs(chips - round.prizes[i]) > Math.max(1, chips) * 1e-10) return false;
  }
  for (let i = 0; i < round.picked.length; i++) {
    const safe =
      round.game === 'mines'
        ? !proof.mine_cells.includes(round.picked[i])
        : round.picked[i] === i &&
          roadSurvives(
            BigInt(proof.road_roll),
            ladder[i],
            round.bet_chips,
            round.minimum_payout_chips ?? 0
          );
    if (safe === (round.status === 'lost' && i === round.picked.length - 1)) return false;
  }
  if (round.status === 'lost') return round.payout_chips === (round.minimum_payout_chips ?? 0);
  if (round.status !== 'cashed') return false;
  const n = round.picked.length;
  const rational =
    round.game === 'mines'
      ? prize(n)
      : {
          numerator: BigInt(Math.round(round.bet_chips * 100)) * BigInt(ladder[n - 1]),
          denominator: 100n,
        };
  const hash = await hmacSha256Hex(
    proof.server_seed,
    `${round.client_seed}:${round.nonce}:rounding:${n}`
  );
  const cents = roundedMinePrize(
    rational.numerator,
    rational.denominator,
    BigInt(`0x${hash.slice(0, 12)}`)
  );
  return Number(cents) === Math.round(round.payout_chips * 100);
}
