import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({
  lobby: null as string | null,
  register: vi.fn(),
  seat: vi.fn(),
  navigate: vi.fn(),
  emit: vi.fn(),
  report: vi.fn(),
  error: vi.fn(),
  success: vi.fn(),
  warning: vi.fn(),
  info: vi.fn(),
}));
vi.mock('../../src/services/TournamentService', () => ({
  tournamentService: {
    findTournamentEntryTicket: async () => null,
    readTournamentUnitCents: async () => 1,
    registerPlayer: m.register,
  },
}));
vi.mock('../../src/context/InTabLobbyContext', () => ({
  useInTabLobby: () => ({ getLobbyTabId: () => m.lobby }),
  useAppNavigate: () => m.navigate,
}));
vi.mock('../../src/stores/useUserStore', () => ({
  useUserStore: (select: any) => select({ user: { id: 'player', username: 'Player' } }),
}));
vi.mock('../../src/components/common/Toast', () => ({
  useToast: () => ({ error: m.error, success: m.success, warning: m.warning, info: m.info }),
}));
vi.mock('../../src/components/tournament/signUpDialog', () => ({ signUpDialog: async () => true }));
vi.mock('../../src/core/MasterBus', () => ({ masterBus: { emit: m.emit } }));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: m.report }));
vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: () => {
      const b: any = { select: () => b, eq: () => b, abortSignal: () => b, maybeSingle: m.seat };
      return b;
    },
  },
}));
import { useTournamentRegistration } from '../../src/hooks/useTournamentRegistration';
const tournament = { id: 'event', name: 'Event', buy_in_amount: 10, status: 'RUNNING' };
beforeEach(() => {
  vi.resetAllMocks();
  sessionStorage.clear();
  m.lobby = null;
  vi.useFakeTimers();
  m.register.mockResolvedValue({ id: 'entry', table_id: 'own-table' });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
describe('a committed registration keeps its result through presentation failures', () => {
  it('retains the initiating lobby while the authoritative registration is in flight', async () => {
    m.lobby = 'lobby:original';
    let resolve!: (value: any) => void;
    m.register.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      })
    );
    const hook = renderHook(() => useTournamentRegistration());
    let pending!: Promise<void>;
    await act(async () => {
      pending = hook.result.current.register(tournament);
    });
    m.lobby = 'lobby:later';
    await act(async () => {
      resolve({ table_id: 'own-table' });
      await pending;
    });
    expect(m.navigate).toHaveBeenCalledWith('/table/own-table', {
      state: { tournamentSeat: { tournamentId: 'event', lobbyTabId: 'lobby:original' } },
    });
  });
  it('still reaches the paid seat if the page refresh callback throws', async () => {
    const hook = renderHook(() => useTournamentRegistration());
    const error = new Error('page refresh failed');
    await act(async () => {
      await hook.result.current.register(tournament, () => {
        throw error;
      });
    });
    expect(m.register).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem('ca_tourney_entered:player:event')).toBe('1');
    expect(m.navigate).toHaveBeenCalledWith('/table/own-table', {
      state: { tournamentSeat: { tournamentId: 'event', lobbyTabId: null } },
    });
    expect(m.error).not.toHaveBeenCalled();
    expect(m.report).toHaveBeenCalledWith(error, 'useTournamentRegistration.onSuccess', {
      tournamentId: 'event',
    });
    expect(hook.result.current.isRegistering).toBe(false);
  });
  it('reports the seat as unconfirmed, not registration failed, if its read throws', async () => {
    m.register.mockResolvedValue({ id: 'entry', table_id: null });
    m.seat.mockRejectedValue(new TypeError('network read failed'));
    const hook = renderHook(() => useTournamentRegistration());
    await act(async () => {
      const operation = hook.result.current.register(tournament);
      await vi.advanceTimersByTimeAsync(4000);
      await operation;
    });
    expect(m.register).toHaveBeenCalledTimes(1);
    expect(m.warning).toHaveBeenCalledWith(
      'You Are Registered. We Could Not Confirm Your Seat Yet.'
    );
    expect(m.navigate).toHaveBeenCalledWith('/tournaments/event');
    expect(m.error).not.toHaveBeenCalled();
    expect(hook.result.current.isRegistering).toBe(false);
  });
  it('joins a rejected asynchronous page callback without blocking seat navigation', async () => {
    const hook = renderHook(() => useTournamentRegistration());
    const error = new Error('async page refresh failed');
    await act(async () => {
      await hook.result.current.register(tournament, async () => {
        throw error;
      });
    });
    expect(m.navigate).toHaveBeenCalledWith('/table/own-table', {
      state: { tournamentSeat: { tournamentId: 'event', lobbyTabId: null } },
    });
    expect(m.error).not.toHaveBeenCalled();
    expect(m.report).toHaveBeenCalledWith(error, 'useTournamentRegistration.onSuccess', {
      tournamentId: 'event',
    });
  });
  it('uses a later confirmed seat after a transient lookup exception without entering twice', async () => {
    m.register.mockResolvedValue({ id: 'entry', table_id: null });
    m.seat
      .mockRejectedValueOnce(new TypeError('offline'))
      .mockResolvedValue({ data: { table_id: 'confirmed-seat' }, error: null });
    const hook = renderHook(() => useTournamentRegistration());
    await act(async () => {
      const operation = hook.result.current.register(tournament);
      await vi.advanceTimersByTimeAsync(4000);
      await operation;
    });
    expect(m.register).toHaveBeenCalledTimes(1);
    expect(m.seat).toHaveBeenCalledTimes(2);
    expect(m.navigate).toHaveBeenCalledWith('/table/confirmed-seat', {
      state: { tournamentSeat: { tournamentId: 'event', lobbyTabId: null } },
    });
    expect(m.error).not.toHaveBeenCalled();
    expect(m.warning).not.toHaveBeenCalled();
  });
  it('still reports a refused registration and never navigates', async () => {
    m.register.mockRejectedValue(new Error('registration_closed'));
    const hook = renderHook(() => useTournamentRegistration());
    await act(async () => {
      await hook.result.current.register(tournament);
    });
    expect(m.error).toHaveBeenCalledWith('registration_closed');
    expect(m.navigate).not.toHaveBeenCalled();
    expect(m.seat).not.toHaveBeenCalled();
    expect(hook.result.current.isRegistering).toBe(false);
  });
});

it('a hung seat lookup ends as unknown without repeating a committed registration', async () => {
  m.register.mockResolvedValue({ id: 'entry', table_id: null });
  m.seat.mockReturnValue(new Promise(() => {}));
  const hook = renderHook(() => useTournamentRegistration());
  let settled = false;
  await act(async () => {
    void hook.result.current.register(tournament).then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(44000);
  });
  expect(settled).toBe(true);
  expect(m.register).toHaveBeenCalledTimes(1);
  expect(m.warning).toHaveBeenCalledWith('You Are Registered. We Could Not Confirm Your Seat Yet.');
  expect(m.navigate).toHaveBeenCalledWith('/tournaments/event');
  expect(m.error).not.toHaveBeenCalled();
  expect(hook.result.current.isRegistering).toBe(false);
});
