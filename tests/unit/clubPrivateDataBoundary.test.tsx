import { fireEvent, render, screen, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({
  viewer: 'viewer',
  club: 'club',
  listener: null as null | ((event: unknown) => void),
  purge: vi.fn(),
  data: vi.fn(),
  warm: vi.fn(),
  stats: vi.fn(),
}));
vi.mock('../../src/core/MasterBus', () => ({
  masterBus: {
    subscribe: (_name: string, listener: (event: unknown) => void) => {
      state.listener = listener;
      return () => {
        state.listener = null;
      };
    },
  },
}));
vi.mock('../../src/contexts/ClubWorkspaceContext', () => ({
  useClubWorkspace: () => ({ clubUUID: state.club }),
}));
vi.mock('../../src/stores/useUserStore', () => ({
  useUserStore: (select: (s: unknown) => unknown) => select({ user: { id: state.viewer } }),
}));
vi.mock('../../src/lib/rosterCache', () => ({
  purgeRosterCache: state.purge,
  ROSTER_CACHE_PREFIX: 'roster_',
  ROSTER_SEARCH_PREFIX: 'search_',
}));
vi.mock('../../src/lib/clubDataCache', () => ({
  removeClubDataCaches: state.data,
  CLUB_DATA_CACHE_PREFIX: 'data_',
}));
vi.mock('../../src/lib/membershipWarmState', () => ({ clearMembershipsWarmCache: state.warm }));
vi.mock('../../src/lib/statsCache', () => ({
  clearStatsRangeMemo: state.stats,
  STATS_CACHE_PREFIX: 'stats_',
}));
import Boundary from '../../src/components/auth/ClubPrivateDataBoundary';
function Child() {
  const [value, setValue] = useState('');
  return (
    <input aria-label="Draft" value={value} onChange={(event) => setValue(event.target.value)} />
  );
}
function mount(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Boundary>
        <Child />
      </Boundary>
    </MemoryRouter>
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  state.viewer = 'viewer';
  state.club = 'club';
  localStorage.clear();
});
describe('recipient-only private scope invalidation', () => {
  it('drops displayed private data and scoped caches before a fresh generation', () => {
    localStorage.setItem('stats_' + JSON.stringify([2, 'viewer', 'target', 'club']), 'private');
    mount('/clubs/club/members');
    fireEvent.change(screen.getByLabelText('Draft'), { target: { value: 'Old Private Player' } });
    act(() => state.listener?.({ payload: { clubId: 'club', userId: 'viewer' } }));
    expect(screen.getByLabelText('Draft')).toHaveValue('');
    expect(state.purge).toHaveBeenCalledWith('viewer', 'club');
    expect(state.data).toHaveBeenCalledWith('viewer', 'club');
    expect(localStorage.length).toBe(0);
  });
  it('rechecks the mounted private club on all-club reconnect catchup', () => {
    mount('/clubs/club/members');
    fireEvent.change(screen.getByLabelText('Draft'), {
      target: { value: 'Previously Visible Player' },
    });
    act(() => state.listener?.({ payload: { userId: 'viewer' } }));
    expect(screen.getByLabelText('Draft')).toHaveValue('');
    expect(state.purge).toHaveBeenCalledWith('viewer', 'club');
  });
  it('preserves cashier drafts while clearing private read caches', () => {
    mount('/clubs/club/cashier');
    fireEvent.change(screen.getByLabelText('Draft'), { target: { value: 'Unsubmitted Amount' } });
    act(() => state.listener?.({ payload: { clubId: 'club', userId: 'viewer' } }));
    expect(screen.getByLabelText('Draft')).toHaveValue('Unsubmitted Amount');
    expect(state.purge).toHaveBeenCalledTimes(1);
  });
  it('ignores a different club or recipient', () => {
    mount('/clubs/club/data');
    fireEvent.change(screen.getByLabelText('Draft'), { target: { value: 'Current' } });
    act(() => {
      state.listener?.({ payload: { clubId: 'other', userId: 'viewer' } });
      state.listener?.({ payload: { clubId: 'club', userId: 'other' } });
    });
    expect(screen.getByLabelText('Draft')).toHaveValue('Current');
    expect(state.purge).not.toHaveBeenCalled();
  });
});

it('preserves only the member detail draft while still clearing private caches', () => {
  mount('/hub/club-arena/clubs/club/members/player/');
  fireEvent.change(screen.getByLabelText('Draft'), { target: { value: 'Keep This Draft' } });
  act(() => state.listener?.({ payload: { clubId: 'club', userId: 'viewer' } }));
  expect(screen.getByLabelText('Draft')).toHaveValue('Keep This Draft');
  expect(state.purge).toHaveBeenCalledWith('viewer', 'club');
  expect(state.data).toHaveBeenCalledWith('viewer', 'club');
});
it('still restarts private statistics nested beneath the player route', () => {
  mount('/clubs/club/members/player/statistics');
  fireEvent.change(screen.getByLabelText('Draft'), { target: { value: 'Prior Statistics' } });
  act(() => state.listener?.({ payload: { clubId: 'club', userId: 'viewer' } }));
  expect(screen.getByLabelText('Draft')).toHaveValue('');
});
it.each(['viewer', 'club'] as const)(
  'retires the member detail when its %s identity changes',
  (identity) => {
    const path = '/clubs/club/members/player';
    const view = mount(path);
    fireEvent.change(screen.getByLabelText('Draft'), { target: { value: 'Old Identity Draft' } });
    state[identity] = 'new-identity';
    view.rerender(
      <MemoryRouter initialEntries={[path]}>
        <Boundary>
          <Child />
        </Boundary>
      </MemoryRouter>
    );
    expect(screen.getByLabelText('Draft')).toHaveValue('');
  }
);
