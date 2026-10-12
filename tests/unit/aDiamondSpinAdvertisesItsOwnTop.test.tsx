/**
 * A DIAMOND SPIN ADVERTISES THE TOP OF ITS OWN TABLE (DIAMOND PHASE 9, 2026-09-29)
 *
 * A filling Spin says "Win Up To" the top of the table it will draw from. A
 * chip Spin draws from the one compiled ladder, so it says exactly what it
 * always said. A Diamond Spin draws from the table its creation pinned, which
 * may top out elsewhere: its card says that table's top, read by
 * fn_poker_diamond_spin_ceilings, and prints no figure while it is unread. The
 * asset is the arena embed's answer (#5050), never a guess.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    rpc,
    from: () => ({
      select: () => ({
        eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
      }),
    }),
  },
}));
vi.mock('../../src/hooks/useAuthUser', () => ({ useAuthUser: () => ({ user: { id: 'u1' } }) }));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));

import {
  SPIN_MAX_MULTIPLIER,
  spinCeilingMultiplier,
  spinPayoutLabel,
  spinPrizeLabel,
  tournamentEntry,
  type LobbyTournamentRow,
} from '../../src/components/lobby/lobbyEntries';
import { arenaGameCardDataFromEntry } from '../../src/components/lobby/game-cards/arenaGameCardAdapter';
import { ArenaGameCard } from '../../src/components/lobby/game-cards/ArenaGameCard';
import TournamentLobbyCard from '../../src/components/tournament/TournamentLobbyCard';
import { withDiamondSpinCeilings } from '../../src/services/diamondSpinCeilings';
import { reportError } from '../../src/utils/errorReporter';

const DIAMONDS = { id: 'arena', asset: 'diamonds', is_platform: true, union_id: null };
const CHIPS = { id: 'club', asset: 'chips', is_platform: false, union_id: null };

const row = (o: Partial<LobbyTournamentRow> = {}): LobbyTournamentRow =>
  ({
    id: 's1',
    name: 'Diamond Spin',
    game_type: 'NLH',
    buy_in_amount: 10,
    buy_in_fee: 0,
    guaranteed_prize: 0,
    start_time: new Date().toISOString(),
    status: 'REGISTERING',
    current_players: 1,
    max_players: 3,
    starting_chips: 1000,
    format_contract: 'spin-v1',
    variant: 'spin',
    ...o,
  }) as LobbyTournamentRow;
const spin = (o: Partial<LobbyTournamentRow> = {}) => tournamentEntry(row(o), 'spin');

const card = (o: Partial<LobbyTournamentRow>, presentation: 'desktop' | 'mobile') =>
  renderToStaticMarkup(
    createElement(ArenaGameCard, {
      data: arenaGameCardDataFromEntry(spin(o)),
      actions: { primaryLabel: 'Register', secondaryLabel: 'Details' },
      presentation,
    })
  );

const lobbyCard = (o: Record<string, unknown>) => ({
  id: 's1',
  name: 'Diamond Spin',
  type: 'spin' as const,
  format_contract: 'spin-v1',
  buyIn: 10,
  prizePool: 0,
  maxPlayers: 3,
  registeredPlayers: 1,
  status: 'registering' as const,
  blindStructure: '',
  startingChips: 1000,
  variant: 'spin',
  tournament_type: 'spin',
  ...o,
});
const value = (label: string) =>
  screen.getByText(label).parentElement!.lastElementChild!.textContent;

beforeEach(() => {
  rpc.mockReset();
  vi.mocked(reportError).mockReset();
});

describe('a Diamond Spin advertises the top of its own table', () => {
  it('leaves a chip Spin exactly as it was', () => {
    for (const o of [{}, { arena: CHIPS }, { arena: [CHIPS] }, { diamond_spin_ceiling: 4 }]) {
      expect(spinCeilingMultiplier(row(o))).toBe(SPIN_MAX_MULTIPLIER);
      expect(spinPayoutLabel(spin(o))).toBe('Win Up To 100x');
      expect(spinPrizeLabel(spin(o))).toBe('Top Prize 1,000');
    }
  });

  it("advertises a Diamond Spin's own top, and its prize at the buy-in", () => {
    const own = { arena: DIAMONDS, diamond_spin_ceiling: 4 };
    expect(spinCeilingMultiplier(row(own))).toBe(4);
    expect(spinPayoutLabel(spin(own))).toBe('Win Up To 4x');
    expect(spinPrizeLabel(spin(own))).toBe('Top Prize 40');
    expect(spinPayoutLabel(spin({ arena: [DIAMONDS], diamond_spin_ceiling: 100 }))).toBe(
      'Win Up To 100x'
    );
    for (const presentation of ['desktop', 'mobile'] as const) {
      const html = card(own, presentation);
      expect(html).toContain('4x');
      expect(html).not.toContain('100x');
    }
  });

  it('prints no figure for a Diamond Spin whose top has not been read', () => {
    for (const o of [{ arena: DIAMONDS }, { arena: DIAMONDS, diamond_spin_ceiling: 0 }]) {
      expect(spinCeilingMultiplier(row(o))).toBeNull();
      expect(spinPayoutLabel(spin(o))).toBeNull();
      expect(spinPrizeLabel(spin(o))).toBeNull();
      for (const presentation of ['desktop', 'mobile'] as const) {
        const html = card(o, presentation);
        expect(html).toContain('Win Up To');
        expect(html).not.toContain('100x');
      }
    }
  });

  it('shows what a drawn Diamond Spin drew, as a chip Spin does', () => {
    const drawn = {
      arena: DIAMONDS,
      diamond_spin_ceiling: 4,
      status: 'RUNNING',
      started_at: new Date(Date.now() - 60_000).toISOString(),
      spin_multiplier: 4,
      prize_pool: 40,
    };
    expect(spinPayoutLabel(spin(drawn))).toBe('4x');
    expect(spinPrizeLabel(spin(drawn))).toBe('Prize Pool 40');
  });

  it('says the same on the tournament card', () => {
    const { unmount } = render(
      <MemoryRouter>
        <TournamentLobbyCard
          tournament={lobbyCard({ arena: DIAMONDS, diamond_spin_ceiling: 4 })}
          knownRegistration={false}
        />
      </MemoryRouter>
    );
    expect(value('Multiplier')).toBe('Win Up To 4x');
    expect(value('Top Prize')).toContain('40');
    unmount();
    render(
      <MemoryRouter>
        <TournamentLobbyCard
          tournament={lobbyCard({ arena: DIAMONDS })}
          knownRegistration={false}
        />
      </MemoryRouter>
    );
    expect(value('Multiplier')).toBe('Unavailable');
    expect(value('Top Prize')).toBe('Unavailable');
  });

  it('asks for the Diamond Spins on the board and for nothing else', async () => {
    const chip = [row({ id: 'c1' }), row({ id: 'c2', arena: CHIPS })];
    await expect(withDiamondSpinCeilings(chip)).resolves.toBe(chip);
    expect(rpc).not.toHaveBeenCalled();

    rpc.mockResolvedValueOnce({
      data: [{ tournament_id: 'd1', max_multiplier: 4 }],
      error: null,
    });
    const board = [
      row({ id: 'c1', arena: CHIPS }),
      row({ id: 'd1', arena: DIAMONDS }),
      row({ id: 'm1', arena: DIAMONDS, format_contract: 'mtt-v1', variant: 'freezeout' }),
    ];
    const read = await withDiamondSpinCeilings(board);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('fn_poker_diamond_spin_ceilings', {
      p_tournament_ids: ['d1'],
    });
    expect(read.map((r) => r.diamond_spin_ceiling)).toEqual([undefined, 4, undefined]);
  });

  it('leaves the rows as they were, and says so, when the read fails', async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'permission denied' } });
    const board = [row({ id: 'd1', arena: DIAMONDS })];
    await expect(withDiamondSpinCeilings(board)).resolves.toBe(board);
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(spinPayoutLabel(tournamentEntry(board[0], 'spin'))).toBeNull();
  });
});
