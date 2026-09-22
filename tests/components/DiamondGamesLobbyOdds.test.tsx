/**
 * The lobby's Crash console, rendered (fairness audit 2026-09-22).
 *
 * "Instant Crash 1 In 5" was true while a crash paid nothing and false from the
 * day migration 20260919034436 made every round fund a guaranteed minimum out
 * of its own odds; "Up To 100x Per Round" was the configured ceiling, not
 * anything the server promises. Both figures are computed now - the odds from
 * the server's minimum rule across every stake a wheel award can be played at,
 * the cap from the bets the server is quoting - so this renders the page with a
 * server answer and reads what a player would read.
 */
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { GameState } from '../../src/services/DiamondGamesService';

const mocks = vi.hoisted(() => ({ gameState: vi.fn(), navigate: vi.fn() }));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => mocks.navigate };
});
vi.mock('../../src/utils/clubIdResolver', () => ({
  resolveClubUUID: async () => 'c1000000-0000-4000-8000-000000000001',
}));
vi.mock('../../src/hooks/useGameFloor', () => ({ useGameFloor: () => ({ floor: null }) }));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: () => undefined }));
vi.mock('../../src/services/DiamondWheelService', () => ({
  default: {
    getState: async () => ({
      ok: true,
      available: true,
      segments: [],
      config: { spin_price_diamonds: 100 },
    }),
    welcomeState: async () => ({ ok: true, available: false, enabled: false }),
  },
}));
vi.mock('../../src/services/DiamondChoiceService', () => ({
  DiamondChoiceService: { state: async () => ({ ok: true, available: true, bets: [100] }) },
}));
vi.mock('../../src/services/DiamondGamesService', () => ({
  default: { getState: (club: string, game: string) => mocks.gameState(club, game) },
}));

import DiamondGamesPage from '../../src/pages/DiamondGamesPage';

/** What fn_diamond_game_state answers for Crash on a healthy club, trimmed to what the lobby reads. */
const crashState = (caps: number[]): Partial<GameState> => ({
  ok: true,
  available: true,
  game: 'crash',
  config: {
    diamonds_per_chip: 100,
    min_bet_diamonds: 25,
    max_bet_diamonds: 5000,
    exposure_allowance_chips: 1528.95,
    cap_fraction: 0.95,
    max_multiplier_cents: 10000,
    growth_k: 0.04,
    purchased_only: false,
    max_rounds_per_player_per_day: 50,
    min_seconds_between_rounds: 0,
    spec_rtp: 0.8,
    house_share: 0.2,
  },
  bets: caps.map((cap_cents, i) => ({
    bet_diamonds: [25, 100, 2500, 5000][i] ?? 25,
    bet_chips: ([25, 100, 2500, 5000][i] ?? 25) / 100,
    cap_cents,
    playable: cap_cents >= 101,
  })),
  tables: [],
  open_round: null,
  frozen: false,
});

const lobby = () =>
  render(
    <MemoryRouter initialEntries={['/clubs/shark/diamond-games']}>
      <Routes>
        <Route path="/clubs/:clubId/diamond-games" element={<DiamondGamesPage />} />
      </Routes>
    </MemoryRouter>
  );

describe('the lobby prints the crash odds the server plays', () => {
  it('derives the instant crash from the minimum, and the cap from the quote', async () => {
    mocks.gameState.mockImplementation(async (_club: string, game: string) =>
      game === 'crash'
        ? crashState([10000, 10000, 5905, 3000])
        : { ok: true, available: true, game, bets: [], tables: [], frozen: false }
    );
    lobby();
    // An ordinary award keeps a tenth of its stake, rounded up to the cent.
    await waitFor(() => expect(screen.getByText('1 In 4.2 To 4.3')).toBeTruthy());
    expect(screen.getByText('Instant Crash')).toBeTruthy();
    expect(screen.getByText('On An Ordinary Award')).toBeTruthy();
    expect(screen.queryByText('1 In 5')).toBeNull();
    // The best multiplier the server is quoting right now, not the 100x ceiling
    // by luck: a thinner quote prints a smaller figure (the next case).
    expect(screen.getByText('100x')).toBeTruthy();
    expect(screen.queryByText('Per Round')).toBeNull();
  });

  it('follows the quote down when the pool can promise less', async () => {
    mocks.gameState.mockImplementation(async (_club: string, game: string) =>
      game === 'crash'
        ? crashState([4200, 4000, 2100, 0])
        : { ok: true, available: true, game, bets: [], tables: [], frozen: false }
    );
    lobby();
    await waitFor(() => expect(screen.getByText('42x')).toBeTruthy());
    expect(screen.queryByText('100x')).toBeNull();
  });

  it('prints no crash figure at all when the server did not answer', async () => {
    mocks.gameState.mockImplementation(async (_club: string, game: string) =>
      game === 'crash'
        ? {
            ok: true,
            available: false,
            reason: 'not_configured',
            game: 'crash',
            bets: [],
            tables: [],
            frozen: false,
          }
        : { ok: true, available: true, game, bets: [], tables: [], frozen: false }
    );
    lobby();
    await waitFor(() => expect(screen.getByText('Closed')).toBeTruthy());
    expect(screen.queryByText('Instant Crash')).toBeNull();
    expect(screen.queryByText(/^1 In /)).toBeNull();
    // Plinko keeps its own "Up To"; the crash console has none to print.
    expect(screen.getAllByText('Up To')).toHaveLength(1);
    expect(screen.queryByText('Your Award Sets Your Round')).toBeNull();
  });
});
