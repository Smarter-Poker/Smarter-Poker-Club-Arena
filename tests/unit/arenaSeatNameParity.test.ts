import { describe, expect, it } from 'vitest';
import { playerDisplayName } from '../../src/utils/playerDisplayName';
import { arenaPlayerName } from '../../server/src/services/supabase/arenaPlayerName';

describe('the table and Must-Move lobby use the same arena-name rule', () => {
  it('agrees across aliases, legacy names, missing fields and real-name preferences', () => {
    for (const alias of [null, '', '  ', ' PokerAlias '])
      for (const username of [null, '', 'Handle'])
        for (const display_name of [null, '', ' LegacyNick ', 'real person'])
          for (const full_name of [null, 'Real Person']) {
            const profile = {
              alias,
              username,
              display_name,
              full_name,
              first_name: 'Real',
              last_name: 'Person',
              use_real_name: true,
            };
            expect(arenaPlayerName(profile)).toBe(playerDisplayName(profile, 'arena'));
          }
    expect(arenaPlayerName(null)).toBe(playerDisplayName(null, 'arena'));
  });
});
