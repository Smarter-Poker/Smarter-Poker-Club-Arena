import { afterEach, describe, expect, it, vi } from 'vitest';
import { ScheduledTournamentService } from '../services/ScheduledTournamentService.js';
import { TournamentRecurringService } from '../services/TournamentRecurringService.js';
import { supabase } from '../services/supabase.js';
import { MTT_BLIND_PRESETS } from './mttStructurePolicy.js';

afterEach(() => vi.restoreAllMocks());
const custom = {
  mysteryBountyProfile: 'jackpot',
  mysteryBountyActivation: 'player_count',
  mysteryBountyActivationValue: 12,
  mysteryBountyPoolPercent: 75,
  mysteryBountyTopPercent: 30,
};
async function create(method: string, options: Record<string, unknown>) {
  const config = {
    name: 'Synthetic mystery options',
    type: 'mystery_bounty',
    gameVariant: 'nlh',
    buyIn: 5,
    bountyPercent: 30,
    guarantee: 0,
    startingStack: 10000,
    maxPlayers: 100,
    horsesToRegister: 0,
    blindPreset: 'TURBO',
    payoutPreset: 'NINE',
    blindStructure: MTT_BLIND_PRESETS.TURBO,
    payoutStructure: [{ place: 1, percentage: 100 }],
    ...options,
  };
  if (method === 'scheduled')
    return (new ScheduledTournamentService() as any).buildInsertRow(
      { id: 'schedule', club_id: 'club', union_id: null, name: config.name },
      config,
      new Date()
    );
  let row: Record<string, unknown> | null = null;
  const chain = {
    insert: vi.fn((value: Record<string, unknown>) => {
      row = value;
      return chain;
    }),
    select: vi.fn(() => chain),
    maybeSingle: vi.fn(async () => ({ data: { id: 'event' }, error: null })),
    update: vi.fn(() => chain),
    eq: vi.fn(async () => ({ error: null })),
  };
  vi.spyOn(supabase, 'from').mockReturnValue(chain as never);
  const service = new TournamentRecurringService();
  vi.spyOn(service as any, 'registerHorses').mockResolvedValue(0);
  await (service as any)[method](config, 'union', 'club');
  return row;
}
describe.each(['scheduled', 'createTournament', 'createXMTT'])('%s mystery creation', (method) => {
  it('includes the selected terms in the original insert', async () => {
    expect(await create(method, custom)).toMatchObject({
      mystery_bounty_profile: 'jackpot',
      mystery_bounty_activation: 'player_count',
      mystery_bounty_activation_value: 12,
      mystery_bounty_pool_percent: 75,
      mystery_bounty_regular_pool_percent: 25,
      mystery_bounty_top_percent: 30,
      bounty_amount: 1.5,
    });
  });
  it('uses the established defaults when no options were selected', async () => {
    expect(await create(method, {})).toMatchObject({
      mystery_bounty_profile: 'classic',
      mystery_bounty_activation: 'at_the_money',
      mystery_bounty_activation_value: null,
      mystery_bounty_pool_percent: 50,
      mystery_bounty_regular_pool_percent: 50,
      mystery_bounty_top_percent: 20,
    });
  });
  it('preserves a decimal pool split without a floating-point complement', async () => {
    expect(await create(method, { ...custom, mysteryBountyPoolPercent: 66.6 })).toMatchObject({
      mystery_bounty_pool_percent: 66.6,
      mystery_bounty_regular_pool_percent: 33.4,
    });
  });
  it.each([
    { mysteryBountyProfile: 'other' },
    { mysteryBountyActivation: 'never' },
    { mysteryBountyActivation: 'player_count', mysteryBountyActivationValue: 2.5 },
    { mysteryBountyPoolPercent: 120 },
    { mysteryBountyTopPercent: 0 },
  ])('does not publish malformed selected terms %j', async (options) => {
    let result: unknown;
    try {
      result = await create(method, options);
    } catch {
      result = null;
    }
    expect(result).toBeNull();
  });
});

it('restarts a completed manual event with the same published mystery terms', async () => {
  const old = {
    id: 'old',
    club_id: 'club',
    name: 'Synthetic repeating mystery',
    variant: 'mystery_bounty',
    ended_at: new Date(Date.now() - 3_600_000).toISOString(),
    restart_every_minutes: 5,
    max_players: 100,
    buy_in_amount: 4.5,
    buy_in_fee: 0.5,
    guaranteed_prize: 0,
    is_mystery_bounty: true,
    mystery_bounty_profile: 'jackpot',
    mystery_bounty_activation: 'player_count',
    mystery_bounty_activation_value: 12,
    mystery_bounty_pool_percent: 66.6,
    mystery_bounty_regular_pool_percent: 33.4,
    mystery_bounty_top_percent: 30,
  };
  let inserted: Record<string, unknown> | undefined;
  const chain = {
    select: vi.fn(() => chain),
    eq: vi.fn(() => chain),
    in: vi.fn(() => chain),
    gt: vi.fn(() => chain),
    insert: vi.fn((row: Record<string, unknown>) => {
      inserted = row;
      return chain;
    }),
    maybeSingle: vi.fn(async () => ({ data: { id: 'new' }, error: null })),
    then: (resolve: (value: unknown) => unknown) =>
      Promise.resolve({ count: 0, error: null }).then(resolve),
  };
  vi.spyOn(supabase, 'from').mockReturnValue(chain as never);
  await (new ScheduledTournamentService() as any).maybeRestartTournament(old);
  for (const [key, value] of Object.entries(old).filter(([key]) =>
    key.startsWith('mystery_bounty_')
  ))
    expect(inserted?.[key]).toEqual(value);
});
