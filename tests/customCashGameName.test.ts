import { describe, expect, it } from 'vitest';
import { customCashGameName } from '../src/utils/customCashGameName';
import {
  cashEntry,
  cashTitleLines,
  type LobbyTableRow,
} from '../src/components/lobby/lobbyEntries';
import { cashCardTitle } from '../src/components/lobby/game-cards/arenaGameCardAdapter';

const table = (name: string, managed = true) =>
  cashEntry({
    id: 'named',
    name,
    game_variant: 'plo5',
    small_blind: 2,
    big_blind: 5,
    min_buy_in: 200,
    max_buy_in: 1000,
    current_players: 1,
    max_players: 6,
    status: 'waiting',
    ...(managed ? { cluster_id: 'g', cluster_template: 'classic', cluster_must_move: false } : {}),
  } as LobbyTableRow);

describe('host cash-game names survive presentation', () => {
  it.each(["CHET'S GAME", 'Friday 2', 'Main Street Friends'])(
    'retains %s without treating its suffix as a table index',
    (name) => {
      expect(customCashGameName(name)).toBe(name);
      const entry = table(name);
      expect(cashTitleLines(entry).subtitle).toContain(entry.name);
      const card = cashCardTitle(entry);
      expect(card.title).toBe('PLO5 2/5');
      expect(card.subtitle).toContain(entry.name);
      expect(card.subtitle).toContain('Classic');
    }
  );
  it.each([
    'PLO5 2/5',
    'PLO5 2/5 Classic',
    'PLO5 2/5 Madness Main 1',
    'PLO5 2/5 Lightning Games Feeder',
  ])('omits generated caption %s', (name) => {
    expect(customCashGameName(name)).toBeNull();
  });
  it('retains custom suffixes in both variant/stakes orders', () => {
    expect(customCashGameName('PLO5 2/5 Late Night')).toBe('Late Night');
    expect(customCashGameName('2/5 PLO5 Late Night')).toBe('Late Night');
  });
  it('keeps default style labels without duplicating generated names', () => {
    expect(cashTitleLines(table('PLO5 2/5 Classic')).subtitle).toBe('Classic');
  });
  it('keeps a standalone PLO host name on the lobby card', () => {
    const entry = table("CHET'S GAME 2", false);
    expect(cashCardTitle(entry).subtitle).toBe(entry.name);
  });
});
