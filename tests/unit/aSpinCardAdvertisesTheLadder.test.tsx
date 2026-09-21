/**
 * A SPIN NEVER ADVERTISES A PRIZE POOL OF ZERO (2026-09-21)
 *
 * `prize_pool` for a Spin is written at START, beside the multiplier
 * (`TournamentManagerBase`), and a registering Spin carries 0. The tournament
 * lobby card printed that 0 straight through `compactChips`, so every Spin on
 * `/tournaments` advertised "PRIZE POOL 0" while it filled - a real number a
 * player reads, and not a true one.
 *
 * The main lobby already had the rule, written down with Dan's own words in
 * `lobbyEntries.spinPrizeLabel`: before the draw a Spin advertises the CEILING
 * of the ladder ("Top Prize <buy-in x 100>"), and after it shows what it
 * actually pays. This card asks the same constant and the same reveal gate
 * rather than inventing a second spin rule (10.11: one rule, one place).
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import TournamentLobbyCard from '../../src/components/tournament/TournamentLobbyCard';
import { SPIN_MAX_MULTIPLIER } from '../../src/components/lobby/lobbyEntries';

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: () => ({
      select: () => ({
        eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
      }),
    }),
  },
}));
vi.mock('../../src/hooks/useAuthUser', () => ({ useAuthUser: () => ({ user: { id: 'u1' } }) }));

const spin = (over: Record<string, unknown> = {}) => ({
  id: 's1',
  name: '3 Chip Spin',
  type: 'spin' as const,
  format_contract: 'spin-v1',
  buyIn: 3,
  prizePool: 0,
  maxPlayers: 3,
  registeredPlayers: 1,
  status: 'registering' as const,
  blindStructure: '',
  startingChips: 500,
  variant: 'spin',
  tournament_type: 'spin',
  ...over,
});

const value = (label: string) =>
  screen.getByText(label).parentElement!.lastElementChild!.textContent;

describe('a Spin card advertises the ladder, never a prize pool of zero', () => {
  it('prints the ladder ceiling while the wheel has not turned', () => {
    render(
      <MemoryRouter>
        <TournamentLobbyCard tournament={spin()} knownRegistration={false} />
      </MemoryRouter>
    );
    // 3 x 100 = 300, the top of the ladder, not the row's literal 0.
    expect(value('Top Prize')).toContain(String(3 * SPIN_MAX_MULTIPLIER));
    expect(screen.queryByText('Prize Pool')).toBeNull();
    // The draw is still secret: the ceiling is a ratio, not the drawn number.
    expect(value('Multiplier')).toBe(`Win Up To ${SPIN_MAX_MULTIPLIER}x`);
  });

  it('prints what it actually pays once the wheel has turned', () => {
    render(
      <MemoryRouter>
        <TournamentLobbyCard
          tournament={spin({
            status: 'running',
            started_at: new Date(Date.now() - 60_000).toISOString(),
            spin_multiplier: 25,
            prizePool: 75,
          })}
          knownRegistration={false}
        />
      </MemoryRouter>
    );
    expect(value('Prize Pool')).toContain('75');
    expect(value('Multiplier')).toBe('25x');
    expect(screen.queryByText('Top Prize')).toBeNull();
  });

  it('derives the pool from the drawn multiplier when the row has not been re-read', () => {
    render(
      <MemoryRouter>
        <TournamentLobbyCard
          tournament={spin({
            status: 'running',
            started_at: new Date(Date.now() - 60_000).toISOString(),
            spin_multiplier: 10,
            prizePool: 0,
          })}
          knownRegistration={false}
        />
      </MemoryRouter>
    );
    expect(value('Prize Pool')).toContain('30');
  });

  it('never leaks a drawn multiplier a pre-start row happens to carry', () => {
    render(
      <MemoryRouter>
        <TournamentLobbyCard
          tournament={spin({ spin_multiplier: 100, prizePool: 300 })}
          knownRegistration={false}
        />
      </MemoryRouter>
    );
    expect(value('Multiplier')).toBe(`Win Up To ${SPIN_MAX_MULTIPLIER}x`);
    expect(value('Top Prize')).toContain(String(3 * SPIN_MAX_MULTIPLIER));
  });

  it('leaves every non-Spin card exactly as it was', () => {
    render(
      <MemoryRouter>
        <TournamentLobbyCard
          tournament={{
            ...spin(),
            type: 'mtt',
            format_contract: 'mtt-v2',
            variant: 'nlh',
            tournament_type: 'mtt',
            maxPlayers: null,
            prizePool: 4500,
          }}
          knownRegistration={false}
        />
      </MemoryRouter>
    );
    expect(value('Prize Pool')).toContain('4.5K');
    expect(screen.queryByText('Top Prize')).toBeNull();
    expect(screen.queryByText('Multiplier')).toBeNull();
  });
});
