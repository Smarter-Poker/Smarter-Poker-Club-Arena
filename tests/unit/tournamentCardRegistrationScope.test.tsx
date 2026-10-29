import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  user: { id: 'viewer-a' } as { id: string } | null,
  read: vi.fn(),
}));
vi.mock('../../src/hooks/useAuthUser', () => ({ useAuthUser: () => ({ user: mocks.user }) }));
vi.mock('../../src/context/InTabLobbyContext', () => ({ useAppNavigate: () => vi.fn() }));
vi.mock('../../src/components/lobby/game-cards/useTournamentCardText', () => ({
  useSatelliteDestination: () => null,
}));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: () => {
      const filters: Record<string, string> = {};
      const b: any = {
        select: () => b,
        eq: (k: string, v: string) => {
          filters[k] = v;
          return b;
        },
        maybeSingle: () => mocks.read(filters),
      };
      return b;
    },
  },
}));
import TournamentLobbyCard from '../../src/components/tournament/TournamentLobbyCard';
const event = {
  id: 'event',
  name: 'Event',
  type: 'mtt' as const,
  format_contract: 'mtt-v2',
  buyIn: 10,
  prizePool: 100,
  maxPlayers: 100,
  registeredPlayers: 10,
  status: 'registering' as const,
  blindStructure: '5m',
};
beforeEach(() => {
  mocks.user = { id: 'viewer-a' };
  mocks.read.mockReset();
});
afterEach(cleanup);
function deferred() {
  let resolve!: (v: any) => void;
  const promise = new Promise<any>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
it('reads registration when the viewer hydrates after the card mounts', async () => {
  mocks.user = null;
  mocks.read.mockResolvedValue({ data: { id: 'entry' }, error: null });
  const { rerender } = render(<TournamentLobbyCard tournament={event} />);
  mocks.user = { id: 'viewer-a' };
  rerender(<TournamentLobbyCard tournament={{ ...event }} />);
  await waitFor(() =>
    expect(mocks.read).toHaveBeenCalledWith({ tournament_id: 'event', user_id: 'viewer-a' })
  );
  expect(await screen.findByRole('button', { name: 'Unregister' })).toBeInTheDocument();
});
it('ignores an earlier lookup after the parent supplies confirmed registration', async () => {
  const old = deferred();
  mocks.read.mockReturnValue(old.promise);
  const { rerender } = render(<TournamentLobbyCard tournament={event} />);
  rerender(<TournamentLobbyCard tournament={event} knownRegistration />);
  await screen.findByRole('button', { name: 'Unregister' });
  await act(async () => old.resolve({ data: null, error: null }));
  expect(screen.getByRole('button', { name: 'Unregister' })).toBeInTheDocument();
});
it('cannot show the previous tournament registration on the next event', async () => {
  const old = deferred();
  mocks.read.mockImplementation((f) =>
    f.tournament_id === 'event' ? old.promise : Promise.resolve({ data: null, error: null })
  );
  const { rerender } = render(<TournamentLobbyCard tournament={event} />);
  rerender(<TournamentLobbyCard tournament={{ ...event, id: 'next' }} />);
  await waitFor(() => expect(mocks.read).toHaveBeenCalledTimes(2));
  await act(async () => old.resolve({ data: { id: 'old-entry' }, error: null }));
  expect(screen.queryByRole('button', { name: 'Unregister' })).not.toBeInTheDocument();
});
