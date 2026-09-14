import { afterEach, describe, expect, it, vi } from 'vitest';
import { ScheduledTournamentService } from '../services/ScheduledTournamentService.js';
import { TournamentRecurringService } from '../services/TournamentRecurringService.js';
import { supabase } from '../services/supabase.js';
import { MTT_BLIND_PRESETS } from './mttStructurePolicy.js';

afterEach(() => vi.restoreAllMocks());

async function create(method: string, overrides: Record<string, unknown>) {
  const config = {
    name: 'Bounty Allocation',
    type: 'progressive_bounty',
    gameVariant: 'nlh',
    buyIn: 5,
    guarantee: 0,
    startingStack: 10000,
    maxPlayers: 100,
    horsesToRegister: 0,
    blindPreset: 'TURBO',
    payoutPreset: 'NINE',
    blindStructure: MTT_BLIND_PRESETS.TURBO,
    payoutStructure: [{ place: 1, percentage: 100 }],
    ...overrides,
  };
  if (method === 'scheduled') {
    return (new ScheduledTournamentService() as any).buildInsertRow(
      { id: 'schedule-1', club_id: 'club-1', union_id: null, name: config.name },
      config,
      new Date()
    );
  }
  let inserted: Record<string, unknown> | null = null;
  const chain = {
    insert: vi.fn((row: Record<string, unknown>) => {
      inserted = row;
      return chain;
    }),
    select: vi.fn(() => chain),
    maybeSingle: vi.fn(async () => ({ data: { id: 'event-1' }, error: null })),
    update: vi.fn(() => chain),
    eq: vi.fn(async () => ({ error: null })),
  };
  vi.spyOn(supabase, 'from').mockReturnValue(chain as never);
  const service = new TournamentRecurringService();
  vi.spyOn(service as any, 'registerHorses').mockResolvedValue(0);
  await (service as any)[method](config, 'union-1', 'club-1');
  return inserted;
}

describe.each(['scheduled', 'createTournament', 'createXMTT'])('%s bounty funding', (method) => {
  it.each([
    [{ buyIn: 5, bountyPercent: 30 }, 1.5],
    [{ buyIn: 15, bountyPercent: 30 }, 4.5],
    [{ buyIn: 15, bountyPercent: 50 }, 7.5],
    [{ buyIn: 15, bountyAmount: 6.75, bountyPercent: 50 }, 6.75],
    [{ buyIn: 5 }, 1.5],
    [{ buyIn: 5, bountyPercent: 33.33 }, 1.67],
    [{ buyIn: 5, bountyPercent: 30.1 }, 1.51],
    [{ buyIn: 5, bountyPercent: 100 }, 4.5],
    [{ buyIn: 15, bountyAmount: '6.750', bountyPercent: 50 }, 6.75],
    [{ buyIn: 15, bountyAmount: 50 }, 13.5],
  ])('saves the configured allocation in cents (%j)', async (config, bounty) => {
    const row = await create(method, config);
    expect(row).toMatchObject({ bounty_amount: bounty, is_bounty: true, is_pko: true });
    expect(Number(row.buy_in_amount) + Number(row.buy_in_fee)).toBe(config.buyIn);
    expect(bounty).toBeLessThanOrEqual(Number(row.buy_in_amount));
  });

  it.each(['bounty', 'progressive_bounty', 'mystery_bounty'])(
    'uses the same amount for the %s format and its advertised mystery range',
    async (type) => {
      const row = await create(method, { type, buyIn: 5, bountyPercent: 30 });
      expect(row).toMatchObject({
        bounty_amount: 1.5,
        is_bounty: true,
        is_pko: type === 'progressive_bounty',
        is_mystery_bounty: type === 'mystery_bounty',
        mystery_bounty_min: type === 'mystery_bounty' ? 0.75 : 0,
        mystery_bounty_max: type === 'mystery_bounty' ? 19.5 : 0,
      });
    }
  );

  it.each([
    { bountyPercent: 0 },
    { bountyPercent: -1 },
    { bountyPercent: 101 },
    { bountyPercent: 'bad' },
    { bountyPercent: Infinity },
    { bountyPercent: 30.001 },
    { bountyAmount: -1 },
    { bountyAmount: NaN },
    { bountyAmount: 'bad' },
    { bountyAmount: 0.001 },
    { bountyAmount: true },
    { buyIn: 0 },
  ])('does not insert an event with invalid bounty funding (%j)', async (config) => {
    expect(await create(method, config)).toBeNull();
  });

  it('a non-bounty format ignores unused bounty settings', async () => {
    expect(await create(method, { type: 'mtt', bountyAmount: 'bad' })).toMatchObject({
      bounty_amount: 0,
      is_bounty: false,
      is_pko: false,
      is_mystery_bounty: false,
    });
  });
});
