import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
vi.mock('../../src/services/TournamentService', () => ({
  tournamentService: { getTournament: vi.fn(async () => null) },
}));
import GameLobbyPanel from '../../src/components/lobby/GameLobbyPanel';
import { tournamentEntry, type LobbyTournamentRow } from '../../src/components/lobby/lobbyEntries';

afterEach(cleanup);

function panel(kind: 'spin' | 'sng', status: string, registered = false) {
  const capacity = kind === 'spin' ? 3 : 2;
  const raw = {
    id: 'test-game',
    format_contract: kind === 'spin' ? 'spin-v1' : 'sng-v1',
    name: 'Observer Test',
    status,
    variant: kind === 'spin' ? 'spin' : 'nlh',
    current_players: capacity,
    max_players: capacity,
    buy_in_amount: 20,
    starting_chips: 1000,
  } as LobbyTournamentRow;
  const entry = tournamentEntry(raw, kind);
  const onSpinJoin = vi.fn();
  const onRegister = vi.fn();
  render(
    <MemoryRouter>
      <GameLobbyPanel
        entry={entry}
        clubId="club"
        currentUserId="observer"
        waitlisted={false}
        seated={false}
        registered={registered}
        busy={false}
        onClose={vi.fn()}
        onJoinTable={vi.fn()}
        onWaitlistToggle={vi.fn()}
        onRegister={onRegister}
        onUnregister={vi.fn()}
        onSpinJoin={onSpinJoin}
      />
    </MemoryRouter>
  );
  return { raw, onSpinJoin, onRegister };
}

describe.each(['spin', 'sng'] as const)('%s full game observer entry', (kind) => {
  it('offers Watch on a full running game and calls the existing observer route', () => {
    const { raw, onSpinJoin, onRegister } = panel(kind, 'RUNNING');
    const watch = screen.getByRole('button', { name: 'Watch', exact: true });
    expect(watch).not.toBeDisabled();
    fireEvent.click(watch);
    expect(onSpinJoin).toHaveBeenCalledExactlyOnceWith(raw, kind);
    expect(onRegister).not.toHaveBeenCalled();
  });
  it('does not offer a seat in a full game that has not started', () => {
    panel(kind, 'REGISTERING');
    expect(
      screen.getByRole('button', { name: kind === 'spin' ? 'Game Full' : 'Table Full' })
    ).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Watch', exact: true })).toBeNull();
  });
  it('keeps the return action for an existing entrant', () => {
    const { onSpinJoin } = panel(kind, 'RUNNING', true);
    fireEvent.click(
      screen.getByRole('button', { name: kind === 'spin' ? 'Return To Game' : 'Return To Table' })
    );
    expect(onSpinJoin).toHaveBeenCalledOnce();
  });
  it('keeps completed games closed', () => {
    panel(kind, 'COMPLETED');
    expect(screen.getByRole('button', { name: 'Game Over' })).toBeDisabled();
  });
});
