import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadSeatedPlayers } from './tables.js';
import { supabase } from './client.js';

afterEach(() => vi.restoreAllMocks());

describe('the engine roster uses the Must-Move lobby poker alias', () => {
  it.each([
    [
      'horse',
      { is_horse: true, alias: 'TableAlias', username: 'old_handle', display_name: 'OldHorseName' },
      'TableAlias',
    ],
    [
      'human social preference',
      {
        is_horse: false,
        alias: 'TableAlias',
        username: 'old_handle',
        display_name: 'Real Person',
        full_name: 'Real Person',
        use_real_name: true,
      },
      'TableAlias',
    ],
    [
      'real-name-only legacy row',
      { display_name: 'Real Person', first_name: 'Real', last_name: 'Person' },
      'Player',
    ],
    ['legacy pseudonym', { display_name: 'RiverKing', full_name: 'Real Person' }, 'RiverKing'],
  ])('%s matches in both roster transports', async (_label, profile, expected) => {
    const seat = { id: 'seat', user_id: 'user', occupancy_id: 'stay', seat_number: 1, stack: 20 };
    const selections: string[] = [];
    let results: unknown[] = [];
    vi.spyOn(supabase, 'from').mockImplementation((() => {
      const q: any = {
        select: (s: string) => {
          selections.push(s);
          return q;
        },
        eq: () => q,
        is: () => q,
        order: () => Promise.resolve(results.shift()),
        in: () => Promise.resolve(results.shift()),
      };
      return q;
    }) as any);
    results = [{ data: [{ ...seat, profile: { id: 'user', ...profile } }], error: null }];
    const embedded = await loadSeatedPlayers('table');
    results = [
      { data: null, error: { message: 'embedding unavailable' } },
      { data: [seat], error: null },
      { data: [{ id: 'user', ...profile }], error: null },
    ];
    const fallback = await loadSeatedPlayers('table');
    expect(embedded[0].username).toBe(expected);
    expect(fallback[0].username).toBe(expected);
    expect(embedded[0]).not.toHaveProperty('full_name');
    expect(embedded[0]).not.toHaveProperty('first_name');
    expect(selections[0]).toContain('alias');
    expect(selections[3]).toContain('alias');
  });
});
