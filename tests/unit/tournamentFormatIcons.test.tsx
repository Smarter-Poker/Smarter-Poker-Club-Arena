import { cleanup, render, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import LobbyTable, { tournamentFormatIcon } from '../../src/components/lobby/LobbyTable';
import {
  tournamentEntry,
  type LobbyEntry,
  type LobbyTournamentRow,
} from '../../src/components/lobby/lobbyEntries';

vi.mock('../../src/services/tableWarmup', () => ({
  warmTable: vi.fn(),
  observeLobbyTableWarmups: () => () => {},
}));
vi.mock('../../src/hooks/useSpinTierAvailability', () => ({ useSpinTierAvailability: () => null }));
afterEach(() => {
  cleanup();
  localStorage.clear();
});
function event(id: string, keys: string[], kind: LobbyEntry['kind'] = 'mtt'): LobbyEntry {
  const entry = tournamentEntry(
    {
      id,
      name: id,
      format_contract: 'mtt-v1',
      game_type: 'NLH',
      status: 'REGISTERING',
      start_time: new Date(Date.now() + 600000).toISOString(),
      buy_in_amount: 10,
      buy_in_fee: 1,
      current_players: 3,
      max_players: 100,
    } as LobbyTournamentRow,
    'mtt'
  );
  return { ...entry, kind, rules: keys.map((key) => ({ key, label: key, tip: key })) };
}
const ctx = {
  waitlistedIds: new Set<string>(),
  seatedIds: new Set<string>(),
  registeredIds: new Set<string>(),
  favoriteIds: new Set<string>(),
};
describe('one tournament identity icon beside each headline', () => {
  it.each([
    [['satellite', 'freeroll', 'pko', 'freezeout'], 'satellite'],
    [['freeroll', 'mystery', 'freezeout'], 'freeroll'],
    [['pko', 'freezeout'], 'bounty'],
    [['mystery', 'freezeout'], 'bounty'],
    [['bounty', 'freezeout'], 'bounty'],
    [['freezeout', 'hyper', 'turbo'], 'freezeout'],
    [['hyper', 'turbo', 'deepstack'], 'hyper'],
    [['turbo', 'deepstack', 'rebuy'], 'turbo'],
    [['deepstack', 'rebuy'], 'deepstack'],
    [['rebuy'], 'rebuy'],
    [['reentry'], 'rebuy'],
    [['addon'], 'rebuy'],
    [[], 'standard'],
  ] as [string[], string][])('uses recorded rules %j with matching priority', (keys, expected) => {
    expect(tournamentFormatIcon(event('Unrelated Event Name', keys))).toBe(expected);
  });
  it('does not infer a type from a title or put tournament icons on cash rows', () => {
    expect(tournamentFormatIcon(event('Satellite Mystery Bounty Freezeout', []))).toBe('standard');
    expect(tournamentFormatIcon(event('Cash', ['bounty'], 'cash'))).toBeNull();
  });
  it('puts exactly one accessible SVG identity in both headlines for every tournament kind', () => {
    const entries = [
      event('Satellite', ['satellite']),
      event('Free', ['freeroll']),
      event('Mystery', ['mystery']),
      event('Freezeout', ['freezeout']),
      event('Hyper', ['hyper']),
      event('Turbo', ['turbo']),
      event('Deep', ['deepstack']),
      event('Rebuy', ['rebuy']),
      event('Spin', [], 'spin'),
      event('SNG', [], 'sng'),
    ];
    render(
      <MemoryRouter>
        <LobbyTable
          entries={entries}
          category="MTT"
          selectedId={null}
          onSelect={() => {}}
          onActivate={() => {}}
          ctx={ctx}
        />
      </MemoryRouter>
    );
    for (const entry of entries) {
      for (const selector of ['.compact-lobby tbody', '.lobby-table-wrap tbody']) {
        const row = document.querySelector(`${selector} tr[data-id="${entry.id}"]`)!;
        const icons = row.querySelectorAll('[data-tournament-icon]');
        expect(icons).toHaveLength(1);
        expect(icons[0].closest('.compact-lobby__title, .lt-name__line1')).not.toBeNull();
        expect(icons[0].getAttribute('data-tournament-icon')).toBe(tournamentFormatIcon(entry));
        expect(icons[0].querySelector('svg')).not.toBeNull();
        expect(icons[0].getAttribute('aria-label')).toMatch(/Tournament/);
        expect(within(row as HTMLElement).queryByText('Top Event')).toBeNull();
      }
    }
  });
});
