/** Contract 5: loss protection grows with the last safe prize. Exact chip cents. */
export const RANDOM_SPACE = 281474976710656n;
type Fraction = { numerator: bigint; denominator: bigint };
const gcd = (a: bigint, b: bigint): bigint => (b === 0n ? a : gcd(b, a % b));
const fraction = (n: bigint, d: bigint): Fraction => {
  const g = gcd(n, d);
  return { numerator: n / g, denominator: d / g };
};
const ceil = (n: bigint, d: bigint) => (n + d - 1n) / d;
export function choiceLossGuarantee(prizes: readonly number[], safeSteps: number, minimum: number) {
  return Math.max(
    minimum,
    safeSteps > 0 ? Math.ceil((prizes[safeSteps - 1] ?? 0) * 50 - 1e-9) / 100 : 0
  );
}
export function minePrizeV5(
  betChips: number,
  mines: number,
  picks: number,
  minimum: number
): Fraction {
  if (
    !Number.isInteger(mines) ||
    mines < 1 ||
    mines > 24 ||
    !Number.isInteger(picks) ||
    picks < 1 ||
    picks > 25 - mines ||
    !Number.isFinite(betChips) ||
    betChips <= 0 ||
    !Number.isFinite(minimum) ||
    minimum < 0
  )
    throw new Error('Invalid Mines Prize');
  const baseline = BigInt(Math.round(minimum * 100));
  let prize = fraction(BigInt(Math.round(betChips * 100)) * 4n, 5n);
  for (let n = 1; n < picks; n++) {
    const lastHalf = ceil(prize.numerator, prize.denominator * 2n);
    const loss = baseline > lastHalf ? baseline : lastHalf;
    const remaining = BigInt(25 - n);
    prize = fraction(
      prize.numerator * remaining - loss * prize.denominator * BigInt(mines),
      prize.denominator * (remaining - BigInt(mines))
    );
  }
  return prize;
}
/** Unconditional probability of reaching a street, using the sealed prize ladder. */
export function roadProbabilityV5(
  prizes: readonly number[],
  steps: number,
  minimum: number
): Fraction {
  let chance: Fraction = { numerator: 1n, denominator: 1n };
  for (let i = 1; i < steps; i++) {
    // Road prizes are stake cents times multiplier cents / 100.
    const previous = BigInt(Math.round(prizes[i - 1] * 10000));
    const next = BigInt(Math.round(prizes[i] * 10000));
    const loss = BigInt(Math.round(choiceLossGuarantee(prizes, i, minimum) * 100)) * 100n;
    chance = fraction(chance.numerator * (previous - loss), chance.denominator * (next - loss));
  }
  return chance;
}
export function roadSurvivesV5(
  roll: bigint,
  prizes: readonly number[],
  steps: number,
  minimum: number
) {
  const p = roadProbabilityV5(prizes, steps, minimum);
  return (
    roll >= 0n && roll < RANDOM_SPACE && (roll + 1n) * p.denominator <= p.numerator * RANDOM_SPACE
  );
}
/** Chance for the next move, conditional on every safe move already reached. */
export function choiceNextOdds(
  game: 'mines' | 'crossing',
  safeSteps: number,
  prizes: readonly number[],
  minimum: number,
  version = 4,
  mines = 6
) {
  if (safeSteps >= prizes.length) return null;
  if (safeSteps === 0 && version >= 4) return { safe: 100, loss: 0 };
  let safe: number;
  if (game === 'mines') safe = (100 * (25 - mines - safeSteps)) / (25 - safeSteps);
  else {
    const loss = version >= 5 ? choiceLossGuarantee(prizes, safeSteps, minimum) : minimum;
    const previous = safeSteps > 0 ? prizes[safeSteps - 1] : prizes[0];
    safe = (100 * (previous - loss)) / (prizes[safeSteps] - loss);
  }
  return { safe, loss: 100 - safe };
}
