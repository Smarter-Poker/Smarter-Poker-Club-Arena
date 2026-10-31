import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({
  navigate: vi.fn(),
  emit: vi.fn(),
  rows: [] as any[],
  gate: 'unavailable',
  stage: vi.fn(),
}));
vi.mock('react-router-dom', () => ({
  useNavigate: () => m.navigate,
  useLocation: () => ({ pathname: '/clubs/club' }),
  matchPath: () => null,
}));
vi.mock('../src/hooks/useAuthUser', () => ({ useAuthUser: () => ({ user: { id: 'entrant' } }) }));
vi.mock('../src/hooks/useMasterBusSubscription', () => ({ useMasterBusSubscription: vi.fn() }));
vi.mock('../src/core/MasterBus', () => ({ masterBus: { emit: m.emit } }));
vi.mock('../src/services/tableWarmup', () => ({ warmTable: vi.fn() }));
vi.mock('../src/lib/supabase', () => ({
  supabase: {
    from: () => {
      const q: any = {
        select: () => q,
        eq: () => q,
        is: () => q,
        limit: async () => ({ data: m.rows, error: null }),
      };
      return q;
    },
  },
}));
vi.mock('../src/hooks/usePlatformCapability', () => ({ usePlatformCapability: () => m.gate }));
vi.mock('../src/services/TournamentStageService', () => ({ readTournamentStageView: m.stage }));
import TournamentAutoSeat from '../src/components/tournament/TournamentAutoSeat';
function seat(id: string, overrides = {}) {
  return {
    table_id: id,
    joined_at: new Date().toISOString(),
    tables: { tournament_id: 'event', status: 'running', name: 'Event' },
    ...overrides,
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  m.rows = [];
  m.gate = 'unavailable';
});
afterEach(cleanup);
it('opens and enters the fresh assigned tournament once, including after a remount', async () => {
  m.rows = [seat('assigned')];
  const view = render(<TournamentAutoSeat />);
  await waitFor(() =>
    expect(m.navigate).toHaveBeenCalledWith('/table/assigned', {
      state: { tournamentSeat: { tournamentId: 'event', lobbyTabId: null } },
    })
  );
  expect(m.emit).toHaveBeenCalledWith('TABLE_SEATED', { tableId: 'assigned', seat: 0 });
  view.unmount();
  render(<TournamentAutoSeat />);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(m.navigate).toHaveBeenCalledTimes(1);
});
it('does not redirect for cash games, old seats or closed tournaments', async () => {
  m.rows = [
    seat('cash', { tables: { tournament_id: null } }),
    seat('old', { joined_at: '2020-01-01' }),
    seat('closed', { tables: { tournament_id: 'event', status: 'closed' } }),
  ];
  render(<TournamentAutoSeat />);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(m.navigate).not.toHaveBeenCalled();
  expect(m.emit).not.toHaveBeenCalled();
});

it('does not select another table for the same admitted tournament', async () => {
  m.rows = [seat('first')];
  const view = render(<TournamentAutoSeat />);
  await waitFor(() => expect(m.navigate).toHaveBeenCalledTimes(1));
  view.unmount();
  m.rows = [seat('moved')];
  render(<TournamentAutoSeat />);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(m.emit).toHaveBeenCalledWith('TABLE_SEATED', { tableId: 'moved', seat: 0 });
  expect(m.navigate).toHaveBeenCalledTimes(1);
});
it('keeps later-day resumes in the background', async () => {
  m.gate = 'available';
  m.stage.mockResolvedValue({ status: 'ok', view: { currentStage: { stageNo: 2 } } });
  m.rows = [seat('day-two')];
  render(<TournamentAutoSeat />);
  await waitFor(() =>
    expect(m.emit).toHaveBeenCalledWith('TABLE_SEATED', { tableId: 'day-two', seat: 0 })
  );
  expect(m.navigate).not.toHaveBeenCalled();
});
