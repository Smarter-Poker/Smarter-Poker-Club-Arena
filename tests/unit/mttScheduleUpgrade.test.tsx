import { cleanup, fireEvent, render, within, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import LobbyTable, { tournamentClockLine } from '../../src/components/lobby/LobbyTable';
import { tournamentEntry, type LobbyTournamentRow } from '../../src/components/lobby/lobbyEntries';
import {
  FILTER_SPECS,
  emptyFilterValue,
  rowPassesFilter,
} from '../../src/components/lobby/advancedFilterSpec';
import { defaultSortForTab } from '../../src/components/lobby/lobbyViewPrefs';
vi.mock('../../src/services/tableWarmup', () => ({
  warmTable: vi.fn(),
  observeLobbyTableWarmups: () => () => {},
}));
vi.mock('../../src/hooks/useSpinTierAvailability', () => ({ useSpinTierAvailability: () => null }));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  localStorage.clear();
});
const now = Date.parse('2026-10-31T18:00:00Z');
function event(id: string, over: Partial<LobbyTournamentRow> = {}) {
  return tournamentEntry(
    {
      id,
      name: id,
      format_contract: 'mtt-v1',
      game_type: 'NLH',
      status: 'REGISTERING',
      start_time: new Date(now + 120 * 60000).toISOString(),
      buy_in_amount: 10,
      buy_in_fee: 1,
      guaranteed_prize: 100,
      current_players: 3,
      max_players: 100,
      starting_chips: 5000,
      ...over,
    } as LobbyTournamentRow,
    'mtt'
  );
}
const ctx = {
  waitlistedIds: new Set<string>(),
  seatedIds: new Set<string>(),
  registeredIds: new Set<string>(),
  favoriteIds: new Set<string>(),
};
function board(entries: ReturnType<typeof event>[]) {
  return render(
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
}
const ids = () =>
  Array.from(document.querySelectorAll('.lobby-table-wrap tbody tr[id]')).map((el) =>
    el.id.replace('lt-row-', '')
  );
describe('MTT schedule upgrade', () => {
  it('defaults to Recommended, all variants and satellites excluded', () => {
    expect(defaultSortForTab('MTT')).toBe('recommended');
    const defaults = emptyFilterValue(FILTER_SPECS.MTT);
    expect(defaults.games).toEqual(FILTER_SPECS.MTT.games!.map((g) => g.key));
    expect(defaults.hide).toEqual(['satellite']);
    const row = {
      variant: 'mtt',
      price: 10,
      seats: 500,
      tableSeats: 9,
      seatsTaken: 3,
      status: 'REGISTERING',
      name: 'Regular',
      row: { satellite_target_id: null, satellite_target: null, name: 'Regular' },
      settings: {},
    };
    expect(rowPassesFilter(FILTER_SPECS.MTT, defaults, row)).toBe(true);
    const satellite = {
      ...row,
      name: 'Satellite',
      row: { ...row.row, name: 'Satellite', satellite_target_id: 'target' },
    };
    expect(rowPassesFilter(FILTER_SPECS.MTT, defaults, satellite)).toBe(false);
    expect(rowPassesFilter(FILTER_SPECS.MTT, { ...defaults, hide: [] }, satellite)).toBe(true);
  });
  it('replaces a stale prestart projection with the actual late-reg clock, including 75:30', () => {
    const e = event('late', {
      status: 'RUNNING',
      started_at: new Date(now - 270000).toISOString(),
      late_reg_mins: 80,
    });
    const stale = { ...e, status: 'starting_soon' as const };
    expect(tournamentClockLine(stale, now)?.text).toBe('Late Reg Ends In 75:30');
    expect(tournamentClockLine(stale, now + 80 * 60000)).toBeNull();
  });
  it('shows no live countdown for terminal events or missing start clocks', () => {
    expect(tournamentClockLine(event('completed', { status: 'COMPLETED' }), now)).toBeNull();
    expect(tournamentClockLine(event('cancelled', { status: 'CANCELLED' }), now)).toBeNull();
    expect(tournamentClockLine(event('undated', { start_time: '' }), now)).toBeNull();
  });
  it('does not invent a start for an overdue held event', () => {
    expect(
      tournamentClockLine(event('held', { start_time: new Date(now - 1).toISOString() }), now)?.text
    ).toBe('Start Pending');
  });
  it('orders late registration, soon, open then running and locks top events above a chosen sort', () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const started_at = new Date(now - 60000).toISOString();
    board([
      event('running', { status: 'RUNNING', started_at, late_reg_mins: 0 }),
      event('open'),
      event('soon', { start_time: new Date(now + 60000).toISOString() }),
      event('late', { status: 'RUNNING', started_at, late_reg_mins: 80 }),
      event('top', { is_pinned: true, buy_in_amount: 1 }),
    ]);
    expect(ids()).toEqual(['top', 'late', 'soon', 'open', 'running']);
    const compactTop = document.querySelector('.compact-lobby tr[data-id="top"]')!;
    expect(compactTop.classList.contains('is-featured')).toBe(true);
    expect(within(compactTop as HTMLElement).queryByText('Top Event')).toBeNull();
    const heading = document.querySelector('.lobby-table-wrap thead') as HTMLElement;
    fireEvent.click(document.querySelector('.compact-lobby thead th')!);
    expect(ids()).toEqual(['top', 'late', 'soon', 'open', 'running']);
    const price = within(heading).getByRole('columnheader', { name: /buy-in/i });
    fireEvent.click(within(price).queryByRole('button') ?? price);
    expect(ids()[0]).toBe('top');
  });
  it('updates badge and ordering when time crosses the soon boundary without a row write', () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    board([event('open'), event('next', { start_time: new Date(now + 3601000).toISOString() })]);
    expect(document.querySelector('#lt-row-next')?.className).toContain('lt-row--registering');
    act(() => vi.advanceTimersByTime(2000));
    expect(document.querySelector('#lt-row-next')?.className).toContain('lt-row--starting_soon');
    expect(ids()).toEqual(['next', 'open']);
  });
  it('labels open late registration truthfully in both layouts, then changes to Running at closure', () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    board([
      event('late', {
        status: 'RUNNING',
        started_at: new Date(now - 60000).toISOString(),
        late_reg_mins: 80,
      }),
    ]);
    for (const row of document.querySelectorAll('tr[data-id="late"]')) {
      expect(within(row as HTMLElement).getByText('Late Reg', { exact: true })).toBeTruthy();
      expect(within(row as HTMLElement).queryByText('Running', { exact: true })).toBeNull();
    }
    vi.setSystemTime(now + 80 * 60000);
    act(() => vi.advanceTimersByTime(1000));
    for (const row of document.querySelectorAll('tr[data-id="late"]')) {
      expect(within(row as HTMLElement).getByText('Running', { exact: true })).toBeTruthy();
      expect(within(row as HTMLElement).queryByText('Late Reg', { exact: true })).toBeNull();
    }
  });
  it.each([
    ['satellite', 'is-satellite'],
    ['freeroll', 'is-freeroll'],
    ['mystery', 'is-bounty'],
    ['pko', 'is-bounty'],
    ['bounty', 'is-bounty'],
    ['freezeout', 'is-freezeout'],
    ['reentry', 'is-rebuy'],
    ['turbo', 'is-turbo'],
    ['hyper', 'is-hyper'],
    ['deepstack', 'is-deepstack'],
  ])('retains the %s schema in both layouts even with a large guarantee', (key, rowClass) => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const entry = event('typed', { guaranteed_prize: 10000 });
    entry.rules = [{ key, label: key, tip: key }];
    board([entry]);
    const rows = document.querySelectorAll('tr[data-id="typed"]');
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row.classList.contains(rowClass)).toBe(true);
    const compact = document.querySelector('.compact-lobby tr[data-id="typed"]')!;
    expect(within(compact as HTMLElement).getAllByText('10K GTD')).toHaveLength(1);
  });
});
