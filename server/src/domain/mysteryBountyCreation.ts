/** Creation metadata only: entry funding and inventory remain database-owned. */
export interface MysteryBountyCreationInput {
  mysteryBountyProfile?: unknown;
  mysteryBountyActivation?: unknown;
  mysteryBountyActivationValue?: unknown;
  mysteryBountyPoolPercent?: unknown;
  mysteryBountyTopPercent?: unknown;
}

export function mysteryBountyCreationOptions(input: MysteryBountyCreationInput) {
  const profile = input.mysteryBountyProfile ?? 'classic';
  const activation = input.mysteryBountyActivation ?? 'at_the_money';
  const value = input.mysteryBountyActivationValue ?? null;
  const pool = input.mysteryBountyPoolPercent ?? 50;
  const top = input.mysteryBountyTopPercent ?? 20;
  const number = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
  if (!['balanced', 'classic', 'jackpot'].includes(String(profile)) || typeof profile !== 'string')
    throw new Error('Invalid mystery bounty profile');
  if (
    !['at_the_money', 'percent_field', 'player_count'].includes(String(activation)) ||
    typeof activation !== 'string'
  )
    throw new Error('Invalid mystery bounty activation');
  if (activation === 'percent_field' && (!number(value) || value <= 0 || value > 100))
    throw new Error('Invalid mystery bounty activation percentage');
  if (
    activation === 'player_count' &&
    (!number(value) || !Number.isSafeInteger(value) || value < 2)
  )
    throw new Error('Invalid mystery bounty activation player count');
  if (!number(pool) || pool < 0 || pool > 100 || Number(pool.toFixed(2)) !== pool)
    throw new Error('Invalid mystery bounty pool percentage');
  if (!number(top) || top <= 0 || top > 100)
    throw new Error('Invalid mystery bounty top percentage');
  return {
    mysteryBountyProfile: profile,
    mysteryBountyActivation: activation,
    mysteryBountyActivationValue: activation === 'at_the_money' ? null : value,
    mysteryBountyPoolPercent: pool,
    mysteryBountyTopPercent: top,
  };
}

export function mysteryBountyCreationColumns(input: MysteryBountyCreationInput) {
  const options = mysteryBountyCreationOptions(input);
  return {
    mystery_bounty_profile: options.mysteryBountyProfile,
    mystery_bounty_activation: options.mysteryBountyActivation,
    mystery_bounty_activation_value: options.mysteryBountyActivationValue,
    mystery_bounty_pool_percent: options.mysteryBountyPoolPercent,
    mystery_bounty_regular_pool_percent:
      (10000 - Math.round(options.mysteryBountyPoolPercent * 100)) / 100,
    mystery_bounty_top_percent: options.mysteryBountyTopPercent,
  };
}
