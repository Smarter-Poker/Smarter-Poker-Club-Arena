import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({
  tables: vi.fn(),
  seats: vi.fn(),
  query: vi.fn(),
  channel: vi.fn(),
  rpc: vi.fn(),
}));
vi.mock('../../src/hooks/useAuthUser', () => ({
  useAuthUser: () => ({ user: { id: 'observer' } }),
}));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
vi.mock('../../src/utils/haptic', () => ({ default: vi.fn() }));
vi.mock('../../src/services/HapticService', () => ({ triggerHaptic: vi.fn() }));
vi.mock('../../src/utils/settlementLock', () => ({
  checkSettlementLock: vi.fn().mockResolvedValue({ locked: false }),
}));
vi.mock('../../src/components/common/Toast', () => ({ useToast: () => ({ error: vi.fn() }) }));
vi.mock('../../src/hooks/useMasterBusSubscription', () => ({ useMasterBusSubscription: vi.fn() }));
vi.mock('../../src/utils/unionScope', () => ({
  clubGamesOrFilter: async (id: string) => `club_id.eq.${id}`,
}));
vi.mock('../../src/core/MasterBus', () => ({
  masterBus: {
    subscribeDebounced: () => vi.fn(),
    removeRegisteredChannel: vi.fn(),
    emit: vi.fn(),
    getOrCreateChannel: () => {
      const channel = {
        on: state.channel.mockImplementation(() => channel),
        subscribe: () => channel,
      };
      return channel;
    },
  },
}));
vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    rpc: state.rpc,
    from: (table: string) => {
      const filters: Record<string, unknown> = {};
      let signal: AbortSignal | undefined;
      const query = {
        select: () => query,
        order: () => query,
        range: () => query,
        eq: (key: string, value: unknown) => {
          filters[key] = value;
          return query;
        },
        in: (key: string, value: unknown) => {
          filters[key] = value;
          return query;
        },
        or: (value: string) => {
          filters.or = value;
          return query;
        },
        abortSignal: (value: AbortSignal) => {
          signal = value;
          return query;
        },
        maybeSingle: () => state.query(table, filters, signal),
        then: (resolve: (value: unknown) => void) =>
          Promise.resolve(state.query(table, filters, signal)).then(resolve),
      };
      return query;
    },
  },
}));
import AdminTableHeatmap from '../../src/components/admin/AdminTableHeatmap';
import AgentPromoPanel from '../../src/components/agent/AgentPromoPanel';
const table = (players = 2, name = 'Cash A') => ({
  id: 'table-a',
  name,
  game_variant: 'nlh',
  small_blind: 1,
  big_blind: 2,
  ante: 0,
  max_players: 9,
  current_players: players,
  status: 'running',
  game_type: 'cash',
});
const flush = () =>
  act(async () => {
    await Promise.resolve();
  });
let visible = 'visible';
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  visible = 'visible';
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(
    () => visible as DocumentVisibilityState
  );
  state.tables.mockResolvedValue([table()]);
  state.seats.mockResolvedValue([]);
  state.query.mockImplementation(async (name: string) => ({
    data:
      name === 'agents'
        ? { id: 'agent', promo_wallet_balance: 100 }
        : name === 'tables'
          ? [table()]
          : [],
    error: null,
  }));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('operator views observe only their visible scope', () => {
  it('updates the heatmap from scoped reads and respects an explicitly empty prop list', async () => {
    const view = render(<AdminTableHeatmap clubId="club-a" />);
    await flush();
    expect(screen.getByText('Cash A')).toBeDefined();
    state.query.mockResolvedValue({ data: [table(4, 'Changed')], error: null });
    await act(() => vi.advanceTimersByTimeAsync(15_000));
    expect(screen.getByText('Changed')).toBeDefined();
    expect(state.channel).not.toHaveBeenCalled();
    view.rerender(<AdminTableHeatmap clubId="club-a" tables={[]} />);
    await flush();
    const calls = state.query.mock.calls.length;
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(state.query).toHaveBeenCalledTimes(calls);
    expect(screen.getByText('No Tables Available For God View.')).toBeDefined();
  });
  it('shows heatmap read failure without inventing an empty club', async () => {
    state.query.mockResolvedValue({ data: null, error: new Error('RLS refused') });
    render(<AdminTableHeatmap clubId="club-a" />);
    await flush();
    expect(screen.getByRole('alert').textContent).toContain(
      'Table Activity Could Not Be Refreshed'
    );
    expect(screen.queryByText('No Tables Available For God View.')).toBeNull();
  });
});

describe('promo float observation does not rewrite money', () => {
  it('uses scoped balance payloads without rereading every player for activity, and fences deletes', async () => {
    state.query.mockImplementation(async (name: string) => ({
      data:
        name === 'agents'
          ? { id: 'agent', promo_wallet_balance: 500 }
          : name === 'club_members'
            ? [{ user_id: 'player-one', chip_balance: 20 }]
            : [],
      error: null,
    }));
    render(<AgentPromoPanel clubId="club-a" userId="agent-a" role="agent" />);
    await flush();
    const event = state.channel.mock.calls[0][2];
    const row = {
      club_id: 'club-a',
      user_id: 'player-one',
      agent_id: 'agent-a',
      role: 'player',
      chip_balance: 20,
    };
    const readCount = () =>
      state.query.mock.calls.filter(([name]) => name === 'club_members').length;
    expect(readCount()).toBe(1);
    await act(async () => {
      event({ eventType: 'UPDATE', new: { ...row, last_active_at: 'later' } });
      event({ eventType: 'UPDATE', new: { ...row, club_id: 'club-b', chip_balance: 99 } });
      event({ eventType: 'DELETE', old: { club_id: 'club-b', user_id: 'player-one' } });
    });
    expect(readCount()).toBe(1);
    await act(async () => event({ eventType: 'UPDATE', new: { ...row, chip_balance: '75' } }));
    expect(screen.getByRole('option', { name: /Chips: 75$/ })).toBeDefined();
    expect(readCount()).toBe(1);
    await act(async () =>
      event({ eventType: 'DELETE', old: { club_id: 'club-a', user_id: 'player-one' } })
    );
    expect(screen.queryByRole('option', { name: /player-o/ })).toBeNull();
    expect(readCount()).toBe(1);
  });
  it('keeps newer membership balance and removal events when an older read finishes', async () => {
    let finish!: (value: unknown) => void;
    state.query.mockImplementation(async (name: string) => ({
      data:
        name === 'agents'
          ? { id: 'agent', promo_wallet_balance: 500 }
          : name === 'club_members'
            ? [
                { user_id: 'player-one', chip_balance: 20 },
                { user_id: 'player-two', chip_balance: 30 },
              ]
            : [],
      error: null,
    }));
    render(<AgentPromoPanel clubId="club-a" userId="agent-a" role="agent" />);
    await flush();
    const event = state.channel.mock.calls[0][2];
    await act(async () =>
      event({
        eventType: 'UPDATE',
        new: {
          club_id: 'club-a',
          user_id: 'player-one',
          agent_id: 'agent-a',
          role: 'player',
          chip_balance: 75,
        },
      })
    );
    state.query.mockImplementation((name: string) =>
      name === 'club_members'
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : Promise.resolve({
            data: name === 'agents' ? { id: 'agent', promo_wallet_balance: 500 } : [],
            error: null,
          })
    );
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    await act(async () => {
      event({
        eventType: 'UPDATE',
        new: {
          club_id: 'club-a',
          user_id: 'player-one',
          agent_id: 'agent-a',
          role: 'player',
          chip_balance: 75,
        },
      });
      event({ eventType: 'DELETE', old: { club_id: 'club-a', user_id: 'player-two' } });
      finish({
        data: [
          { user_id: 'player-one', chip_balance: 20 },
          { user_id: 'player-two', chip_balance: 30 },
        ],
        error: null,
      });
    });
    expect(screen.getByRole('option', { name: /Chips: 75$/ })).toBeDefined();
    expect(screen.queryByRole('option', { name: /Chips: 30$/ })).toBeNull();
  });
  it('rereads unknown and malformed membership data without inventing zero or accepting an old scope', async () => {
    state.query.mockImplementation(async (name: string) => ({
      data:
        name === 'agents'
          ? { id: 'agent', promo_wallet_balance: 500 }
          : name === 'club_members'
            ? [{ user_id: 'player-one', chip_balance: 20 }]
            : [],
      error: null,
    }));
    const view = render(<AgentPromoPanel clubId="club-a" userId="agent-a" role="agent" />);
    await flush();
    const oldEvent = state.channel.mock.calls[0][2];
    await act(async () =>
      oldEvent({
        eventType: 'INSERT',
        new: {
          club_id: 'club-a',
          user_id: 'new-player',
          agent_id: 'agent-a',
          role: 'player',
          chip_balance: 5,
        },
      })
    );
    expect(state.query.mock.calls.filter(([name]) => name === 'club_members')).toHaveLength(2);
    state.query.mockImplementation(async (name: string) => ({
      data: name === 'agents' ? { id: 'agent', promo_wallet_balance: 500 } : null,
      error: name === 'club_members' ? new Error('Denied') : null,
    }));
    await act(async () =>
      oldEvent({
        eventType: 'UPDATE',
        new: {
          club_id: 'club-a',
          user_id: 'player-one',
          agent_id: 'agent-a',
          role: 'player',
          chip_balance: null,
        },
      })
    );
    expect(screen.getByRole('alert')).toBeDefined();
    expect(screen.queryByRole('option', { name: /Chips: 0$/ })).toBeNull();
    view.rerender(<AgentPromoPanel clubId="club-b" userId="agent-b" role="agent" />);
    await flush();
    const calls = state.query.mock.calls.length;
    await act(async () =>
      oldEvent({
        eventType: 'INSERT',
        new: {
          club_id: 'club-a',
          user_id: 'new-player',
          agent_id: 'agent-a',
          role: 'player',
          chip_balance: 5,
        },
      })
    );
    expect(state.query).toHaveBeenCalledTimes(calls);
  });
  it('removes a reassigned player and observes assignments missing from the filtered stream', async () => {
    let players = [
      { user_id: 'player-one', chip_balance: 20 },
      { user_id: 'player-two', chip_balance: 30 },
    ];
    state.query.mockImplementation(async (name: string) => ({
      data:
        name === 'agents'
          ? { id: 'agent', promo_wallet_balance: 500 }
          : name === 'club_members'
            ? players
            : [],
      error: null,
    }));
    render(<AgentPromoPanel clubId="club-a" userId="agent-a" role="agent" />);
    await flush();
    const event = state.channel.mock.calls[0][2];
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'player-one' } });
    await act(async () =>
      event({
        eventType: 'UPDATE',
        new: {
          club_id: 'club-a',
          user_id: 'player-one',
          agent_id: null,
          role: 'player',
          chip_balance: 20,
        },
      })
    );
    expect(screen.queryByRole('option', { name: /Chips: 20$/ })).toBeNull();
    expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('');
    players = [];
    // A reassignment no longer matching agent_id may send no WAL event.
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(screen.getByText('No Players Assigned To You Yet.')).toBeDefined();
  });
  it('refreshes only the narrow float every eight seconds and retains the low-cost membership carrier', async () => {
    render(<AgentPromoPanel clubId="club-a" userId="agent-a" role="agent" />);
    await flush();
    expect(screen.getByText('100')).toBeDefined();
    state.query.mockImplementation(async (name: string) => ({
      data: name === 'agents' ? { id: 'agent', promo_wallet_balance: 70 } : [],
      error: null,
    }));
    await act(() => vi.advanceTimersByTimeAsync(8_000));
    expect(screen.getByText('70')).toBeDefined();
    expect(state.query.mock.calls.filter(([name]) => name === 'club_members')).toHaveLength(1);
    expect(state.channel.mock.calls.map(([, spec]) => spec.table)).toEqual(['club_members']);
    expect(state.rpc).not.toHaveBeenCalled();
  });
  it('does not label a denied or missing agent balance as zero', async () => {
    state.query.mockImplementation(async (name: string) => ({
      data: name === 'agents' ? null : [],
      error: name === 'agents' ? new Error('Refused') : null,
    }));
    render(<AgentPromoPanel clubId="club-a" userId="agent-a" role="agent" />);
    await flush();
    expect(screen.getByText('Unavailable')).toBeDefined();
    expect(screen.queryByText('No Promo Chips Available')).toBeNull();
    expect(state.rpc).not.toHaveBeenCalled();
  });
  it('discards a former agents delayed reply after identity changes', async () => {
    let finish!: (value: unknown) => void;
    state.query.mockImplementation((name: string, filters: Record<string, unknown>) =>
      name === 'agents' && filters.user_id === 'agent-a'
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : Promise.resolve({
            data: name === 'agents' ? { id: 'agent-b', promo_wallet_balance: 22 } : [],
            error: null,
          })
    );
    const view = render(<AgentPromoPanel clubId="club-a" userId="agent-a" role="agent" />);
    await flush();
    view.rerender(<AgentPromoPanel clubId="club-a" userId="agent-b" role="agent" />);
    await flush();
    await act(async () =>
      finish({ data: { id: 'agent-a', promo_wallet_balance: 999 }, error: null })
    );
    expect(screen.getByText('22')).toBeDefined();
    expect(screen.queryByText('999')).toBeNull();
  });
  it('keeps a delayed command reply owned by its original account', async () => {
    let finish!: (value: unknown) => void;
    state.rpc.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    state.query.mockImplementation(async (name: string) => ({
      data:
        name === 'agents'
          ? { id: 'agent', promo_wallet_balance: 500 }
          : name === 'club_members'
            ? [{ user_id: 'player-one', chip_balance: 0 }]
            : [],
      error: null,
    }));
    const onOldDistribute = vi.fn();
    const view = render(
      <AgentPromoPanel
        clubId="club-a"
        userId="agent-a"
        role="agent"
        onDistribute={onOldDistribute}
      />
    );
    await flush();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'player-one' } });
    fireEvent.change(screen.getByPlaceholderText('Enter Promo Chip Amount'), {
      target: { value: '20' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send 20 Promo Chips' }));
    await flush();
    expect(state.rpc).toHaveBeenCalledOnce();
    view.rerender(<AgentPromoPanel clubId="club-a" userId="agent-b" role="agent" />);
    await flush();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'player-one' } });
    fireEvent.change(screen.getByPlaceholderText('Enter Promo Chip Amount'), {
      target: { value: '30' },
    });
    await act(async () => finish({ data: { success: true }, error: null }));
    expect(onOldDistribute).not.toHaveBeenCalled();
    expect((screen.getByPlaceholderText('Enter Promo Chip Amount') as HTMLInputElement).value).toBe(
      '30'
    );
  });
});
