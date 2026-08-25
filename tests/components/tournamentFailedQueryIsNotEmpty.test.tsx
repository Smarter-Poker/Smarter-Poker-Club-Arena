/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  A FAILED QUERY IS NOT AN EMPTY TOURNAMENT
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * The estate's most repeated defect, on the tournament surfaces this time:
 * "No Players Seated Yet", "No Players Found", "Still In (0)" printed because
 * the client never got an answer, not because the answer was none.
 *
 * supabase-js does not THROW on a query error, it RETURNS one. Every component
 * fixed here either destructured only `data`, or matched on `!error && data`
 * and let the `finally` clear the spinner anyway. All three then rendered a
 * confident, fully-formed statement about a running tournament.
 *
 * Each component gets BOTH halves pinned, because a fix that suppresses the
 * empty state entirely is just as wrong:
 *
 *   - query FAILS  -> says so, and never prints the "none" copy;
 *   - query RETURNS []  -> prints the "none" copy, because that is true.
 *
 * Also pinned here: the two lobby-card units that were being invented rather
 * than measured (the "starting soon" flash and the late-reg window).
 */

import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// ─── Supabase: one chainable thenable per table, result set per test ─────────

type QueryResult = { data: unknown; error: unknown };

const results: Record<string, QueryResult> = {};

function setResult(table: string, result: QueryResult) {
  results[table] = result;
}

const CHAIN_METHODS = [
  'select',
  'eq',
  'neq',
  'in',
  'is',
  'or',
  'gte',
  'lte',
  'order',
  'limit',
  'range',
  'maybeSingle',
] as const;

function makeChain(table: string) {
  const settle = () => Promise.resolve(results[table] ?? { data: [], error: null });
  const chain: Record<string, unknown> = {
    then: (onOk: unknown, onErr: unknown) =>
      settle().then(onOk as never, onErr as never) as unknown,
  };
  for (const m of CHAIN_METHODS) chain[m] = () => chain;
  return chain;
}

vi.mock('@/lib/supabase', () => ({
  supabase: { from: (table: string) => makeChain(table) },
}));

vi.mock('@/core/MasterBus', () => ({
  masterBus: {
    getOrCreateChannel: () => {
      const ch = { on: () => ch, subscribe: () => ch };
      return ch;
    },
    removeRegisteredChannel: () => {},
  },
}));

const reportErrorMock = vi.fn();
vi.mock('@/utils/errorReporter', () => ({
  reportError: (...args: unknown[]) => reportErrorMock(...args),
}));

vi.mock('@/hooks/useAuthUser', () => ({
  useAuthUser: () => ({ user: { id: 'hero-1' } }),
}));

const navigateMock = vi.fn();
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: () => navigateMock };
});

import TournamentStandings from '@/components/tournament/TournamentStandings';
import { LiveChipCounts } from '@/components/tournament/LiveChipCounts';
import TournamentInfoPanel from '@/components/tournament/TournamentInfoPanel';
import TournamentLobbyCard, {
  isStartingSoon,
  lateRegState,
} from '@/components/tournament/TournamentLobbyCard';

const DB_DOWN = { data: null, error: { message: 'connection refused' } };
const NO_ROWS = { data: [], error: null };

beforeEach(() => {
  for (const k of Object.keys(results)) delete results[k];
  reportErrorMock.mockClear();
  navigateMock.mockClear();
});

afterEach(() => {
  cleanup();
});

// ═══════════════════════════════════════════════════════════════════════════
describe('TournamentStandings — failure and emptiness are different sentences', () => {
  it('does NOT draw a board of zeros when the standings query fails', async () => {
    setResult('tournament_players', DB_DOWN);
    render(<TournamentStandings tournamentId="t1" totalPlayers={9} />);

    await waitFor(() => expect(screen.getByText(/Unavailable Right Now/i)).toBeTruthy());

    // The exact false claims this component used to make.
    expect(screen.queryByText(/Still In \(0\)/i)).toBeNull();
    expect(screen.queryByText(/Remaining/i)).toBeNull();
    expect(reportErrorMock).toHaveBeenCalled();
  });

  it('DOES report an empty field when the query genuinely returns no rows', async () => {
    setResult('tournament_players', NO_ROWS);
    render(<TournamentStandings tournamentId="t1" totalPlayers={9} />);

    await waitFor(() => expect(screen.getByText(/Still In \(0\)/i)).toBeTruthy());
    expect(screen.queryByText(/Unavailable Right Now/i)).toBeNull();
  });

  it('prints whole chips, not a two-decimal money figure', async () => {
    setResult('tournament_players', {
      data: [{ user_id: 'u1', username: 'Kingfish', chips: 10000, status: 'playing' }],
      error: null,
    });
    render(<TournamentStandings tournamentId="t1" totalPlayers={9} />);

    await waitFor(() => expect(screen.getByText('10,000')).toBeTruthy());
    expect(screen.queryByText('10,000.00')).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('LiveChipCounts — "No Players Found" is a claim about the tournament', () => {
  it('says the feed stalled instead of claiming the field is empty', async () => {
    setResult('tournament_players', DB_DOWN);
    render(<LiveChipCounts tournamentId="t1" currentBigBlind={100} />);

    await waitFor(() => expect(screen.getByText(/Not Updating/i)).toBeTruthy());
    expect(screen.queryByText(/No Players Found/i)).toBeNull();
    expect(reportErrorMock).toHaveBeenCalled();
  });

  it('still says "No Players Found" when the query really returns nothing', async () => {
    setResult('tournament_players', NO_ROWS);
    render(<LiveChipCounts tournamentId="t1" currentBigBlind={100} />);

    await waitFor(() => expect(screen.getByText(/No Players Found/i)).toBeTruthy());
    expect(screen.queryByText(/Not Updating/i)).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('TournamentInfoPanel — the stat masthead must not invent zeros', () => {
  it('reports the failure and withholds the "No Players Seated Yet" claim', async () => {
    setResult('tournaments', DB_DOWN);
    setResult('tournament_players', DB_DOWN);
    render(<TournamentInfoPanel tournamentId="t1" heroUserId="hero-1" onClose={() => {}} />);

    await waitFor(() =>
      expect(screen.getByText(/Could Not Load Tournament Details/i)).toBeTruthy()
    );
    expect(screen.queryByText(/No Players Seated Yet/i)).toBeNull();
    expect(reportErrorMock).toHaveBeenCalled();
  });

  it('keeps the honest empty state when the tournament exists and has no entries', async () => {
    setResult('tournaments', {
      data: { id: 't1', name: 'Sunday Major', status: 'REGISTERING', current_level: 0 },
      error: null,
    });
    setResult('tournament_players', NO_ROWS);
    render(<TournamentInfoPanel tournamentId="t1" heroUserId="hero-1" onClose={() => {}} />);

    await waitFor(() => expect(screen.getByText(/No Players Seated Yet/i)).toBeTruthy());
    expect(screen.queryByText(/Could Not Load Tournament Details/i)).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('TournamentLobbyCard — an unanswered entry check is not "not entered"', () => {
  const base = {
    id: 't1',
    name: 'Sunday Major',
    type: 'mtt' as const,
    buyIn: 100,
    prizePool: 5000,
    maxPlayers: 0,
    registeredPlayers: 42,
    status: 'registering' as const,
    blindStructure: '10m',
  };

  it('refuses to offer a paid Register button when the check failed', async () => {
    setResult('tournament_players', DB_DOWN);
    render(
      <MemoryRouter>
        <TournamentLobbyCard tournament={base} onRegister={vi.fn()} />
      </MemoryRouter>
    );

    await waitFor(() => expect(screen.getByText(/Entry Status Unavailable/i)).toBeTruthy());
    expect(screen.queryByText(/^Register \(/i)).toBeNull();
    expect(reportErrorMock).toHaveBeenCalled();
  });

  it('offers Register normally once the check succeeds and finds no entry', async () => {
    setResult('tournament_players', { data: null, error: null });
    render(
      <MemoryRouter>
        <TournamentLobbyCard tournament={base} onRegister={vi.fn()} />
      </MemoryRouter>
    );

    await waitFor(() => expect(screen.getByText(/Register \(/i)).toBeTruthy());
    expect(screen.queryByText(/Entry Status Unavailable/i)).toBeNull();
  });

  it('calls the registration total "Entries", never a live player count', async () => {
    setResult('tournament_players', { data: null, error: null });
    render(
      <MemoryRouter>
        <TournamentLobbyCard tournament={base} onRegister={vi.fn()} />
      </MemoryRouter>
    );

    // current_players is incremented on entry and never decremented, so it is
    // an entry total. Labelling it "Players" presented drift as seat truth.
    await waitFor(() => expect(screen.getByText('Entries')).toBeTruthy());
    expect(screen.queryByText('Players')).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('TournamentLobbyCard — numbers measured, not parsed back out of copy', () => {
  it('does not flash a tournament hours away as starting soon', () => {
    // The old test was `countdown.includes('m') && parseInt(countdown) < 5`,
    // and the formatted string for this gap is "2h 30m": parseInt reads 2.
    expect(isStartingSoon(2.5 * 60 * 60_000)).toBe(false);
    expect(isStartingSoon(6 * 60_000)).toBe(false);
  });

  it('does flash inside the last five minutes, and never once started', () => {
    expect(isStartingSoon(4 * 60_000)).toBe(true);
    expect(isStartingSoon(1)).toBe(true);
    expect(isStartingSoon(0)).toBe(false);
    expect(isStartingSoon(-30_000)).toBe(false);
    expect(isStartingSoon(null)).toBe(false);
  });

  it('counts a LEVEL window down in levels', () => {
    expect(lateRegState({ levels: 6, minutes: 0, currentLevel: 2, nowMs: 0 })).toEqual({
      active: true,
      label: '4 Lvls Left',
    });
    expect(lateRegState({ levels: 6, minutes: 0, currentLevel: 5, nowMs: 0 })).toEqual({
      active: true,
      label: '1 Lvl Left',
    });
    expect(lateRegState({ levels: 6, minutes: 0, currentLevel: 6, nowMs: 0 })).toEqual({
      active: false,
      label: 'Closed',
    });
  });

  it('counts a MINUTE window down in minutes, and never labels minutes as levels', () => {
    const started = 1_000_000;
    expect(
      lateRegState({ levels: 0, minutes: 45, startedAtMs: started, nowMs: started + 10 * 60_000 })
    ).toEqual({ active: true, label: '35 Mins Left' });

    expect(
      lateRegState({ levels: 0, minutes: 45, startedAtMs: started, nowMs: started + 45 * 60_000 })
    ).toEqual({ active: false, label: 'Closed' });

    // The regression: a 45-minute window used to print "45 lvls left", forever.
    const label = lateRegState({
      levels: 0,
      minutes: 45,
      startedAtMs: started,
      nowMs: started,
    }).label;
    expect(label).not.toMatch(/lvl/i);
  });

  it('says "Open" rather than inventing a count when the window cannot be measured', () => {
    // Level window with no current_level, which is exactly what the only call
    // site passes. "6 Lvls Left" here would be a number nobody supplied.
    expect(lateRegState({ levels: 6, minutes: 0, currentLevel: null, nowMs: 0 })).toEqual({
      active: true,
      label: 'Open',
    });
    expect(lateRegState({ levels: 0, minutes: 45, startedAtMs: null, nowMs: 0 })).toEqual({
      active: true,
      label: 'Open',
    });
  });

  it('reports no window at all when the tournament has none', () => {
    expect(lateRegState({ levels: 0, minutes: 0, nowMs: 0 })).toEqual({
      active: false,
      label: '',
    });
  });
});
