/** Internal game mathematics. Presentation never advertises return percentages. */
import { hmacSha256Hex, sha256Hex } from './wheelFairness';

export type ChoiceGame = 'crossing' | 'mines';
export const ROAD_LADDERS = {
  steady: [110, 135, 170, 215, 275, 355, 460, 600, 800, 1100, 1600, 2400],
  bold: [150, 220, 330, 500, 800, 1300, 2200, 4000, 7500, 15000],
  extreme: [200, 400, 800, 1600, 3200, 6400, 12800, 25600],
} as const;
export type RoadRisk = keyof typeof ROAD_LADDERS;
export const MINE_COUNTS = [5, 10, 15] as const;
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
    !MINE_COUNTS.includes(mines as 5 | 10 | 15) ||
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

/** Uniform values use rejection sampling, so a board has no modulo bias. */
export async function mineBoard(
  serverSeed: string,
  clientSeed: string,
  nonce: number,
  mines: number
) {
  if (!MINE_COUNTS.includes(mines as 5 | 10 | 15)) throw new Error('Invalid Mine Count');
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

/** The edge is charged once. Every selectable crossing target has the same expectation. */
export function roadSurvives(
  roll: bigint,
  targetCents: number,
  betChips = 1,
  minimumPayoutChips = 0
) {
  if (roll < 0n || roll >= RANDOM_SPACE || !Number.isInteger(targetCents) || targetCents < 101) {
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
}

export async function verifyChoiceProof(proof: ChoiceProof) {
  if ((await sha256Hex(proof.server_seed)) !== proof.server_seed_hash) return false;
  if (proof.game === 'mines') {
    const board = await mineBoard(proof.server_seed, proof.client_seed, proof.nonce, proof.mines);
    return JSON.stringify(board) === JSON.stringify(proof.mine_cells);
  }
  const hash = await hmacSha256Hex(proof.server_seed, `${proof.client_seed}:${proof.nonce}:road`);
  return BigInt(`0x${hash.slice(0, 12)}`).toString() === proof.road_roll;
}

/** Checks the selected cells, the complete prize ladder, and the settled chip cents. */
export async function verifyChoiceRound(
  round: import('../services/DiamondChoiceService').ChoiceRound
) {
  const proof = round.proof;
  if (!proof || !(await verifyChoiceProof(proof)) || !round.picked.length) return false;
  const ladder = ROAD_LADDERS[round.mode as RoadRisk];
  for (let i = 0; i < round.prizes.length; i++) {
    const exact =
      round.game === 'mines'
        ? minePrize(round.bet_chips, Number(round.mode), i + 1, round.minimum_payout_chips ?? 0)
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
      ? minePrize(round.bet_chips, Number(round.mode), n, round.minimum_payout_chips ?? 0)
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
