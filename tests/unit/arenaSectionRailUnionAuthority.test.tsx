import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const UNION_A = '11111111-1111-4111-8111-111111111111';
const UNION_B = '22222222-2222-4222-8222-222222222222';

const mocks = vi.hoisted(() => ({
  canOverseeUnion: vi.fn(),
  isUnionAdmin: vi.fn(),
  reportError: vi.fn(),
  userId: 'player-1',
  subscriptions: new Map<string, (payload: Record<string, unknown>) => void>(),
}));

vi.mock('../../src/hooks/useAuthUser', () => ({
  useAuthUser: () => ({ user: { id: mocks.userId } }),
}));

vi.mock('../../src/hooks/useCanCreateUnion', () => ({
  useCanCreateUnion: () => ({ canCreateUnion: false, checking: false }),
  useCanOperateUnionNetwork: () => ({ canOperateUnionNetwork: false, checking: false }),
}));

vi.mock('../../src/contexts/ClubWorkspaceContext', () => ({
  useClubWorkspace: () => ({ routeClubId: null }),
}));

vi.mock('../../src/services/UnionService', () => ({
  unionService: {
    canOverseeUnion: mocks.canOverseeUnion,
    isUnionAdmin: mocks.isUnionAdmin,
  },
}));

vi.mock('../../src/utils/errorReporter', () => ({
  reportError: mocks.reportError,
}));

vi.mock('../../src/hooks/useMasterBusSubscription', () => ({
  useMasterBusSubscription: (
    event: string,
    handler: (payload: Record<string, unknown>) => void
  ) => {
    mocks.subscriptions.set(event, handler);
  },
}));

import ArenaSectionRail from '../../src/components/navigation/ArenaSectionRail';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function LayoutHarness() {
  const navigate = useNavigate();
  return (
    <>
      <button type="button" onClick={() => navigate(`/unions/${UNION_B}/games`)}>
        Open Union B
      </button>
      <ArenaSectionRail />
    </>
  );
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        {/* AppLayout is mounted above the child :unionId route in production.
            This wildcard deliberately gives the rail no useParams union id;
            it must recover the route ref from the layout-level location. */}
        <Route path="*" element={<LayoutHarness />} />
      </Routes>
    </MemoryRouter>
  );
}

const oversightLinks = ['Operations', 'Union Data', 'Statements', 'Settlement', 'Diamond Costs'];

describe('ArenaSectionRail union authority', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.userId = 'player-1';
    mocks.subscriptions.clear();
    mocks.canOverseeUnion.mockResolvedValue(false);
    mocks.isUnionAdmin.mockResolvedValue(false);
  });

  it('uses the layout-level route ref and keeps every privileged link hidden while authority resolves', async () => {
    const oversight = deferred<boolean>();
    const gameManagement = deferred<boolean>();
    mocks.canOverseeUnion.mockReturnValue(oversight.promise);
    mocks.isUnionAdmin.mockReturnValue(gameManagement.promise);

    renderAt(`/unions/${UNION_A}/operations`);

    expect(screen.getByRole('link', { name: 'Overview' })).toHaveAttribute(
      'href',
      `/unions/${UNION_A}`
    );
    expect(screen.getByRole('link', { name: 'Games' })).toBeInTheDocument();
    for (const label of [...oversightLinks, 'Table Management']) {
      expect(screen.queryByRole('link', { name: label })).not.toBeInTheDocument();
    }

    await waitFor(() => {
      expect(mocks.canOverseeUnion).toHaveBeenCalledWith(UNION_A);
      expect(mocks.isUnionAdmin).toHaveBeenCalledWith(UNION_A, 'player-1');
    });

    await act(async () => {
      oversight.resolve(false);
      gameManagement.resolve(false);
      await Promise.all([oversight.promise, gameManagement.promise]);
    });
  });

  it.each([
    {
      name: 'oversight without game management',
      canOversee: true,
      canManageGames: false,
      present: oversightLinks,
      absent: ['Table Management'],
    },
    {
      name: 'game management without broader oversight',
      canOversee: false,
      canManageGames: true,
      present: ['Table Management'],
      absent: oversightLinks,
    },
  ])('keeps the database authority tiers separate: $name', async (tier) => {
    mocks.canOverseeUnion.mockResolvedValue(tier.canOversee);
    mocks.isUnionAdmin.mockResolvedValue(tier.canManageGames);

    renderAt(`/unions/${UNION_A}/games`);

    await waitFor(() => {
      for (const label of tier.present) {
        expect(screen.getByRole('link', { name: label })).toBeInTheDocument();
      }
    });
    for (const label of tier.absent) {
      expect(screen.queryByRole('link', { name: label })).not.toBeInTheDocument();
    }
  });

  it('cannot let slower union-A answers expose privileged union-B links', async () => {
    const oversightA = deferred<boolean>();
    const gamesA = deferred<boolean>();
    const oversightB = deferred<boolean>();
    const gamesB = deferred<boolean>();

    mocks.canOverseeUnion.mockImplementation((unionId: string) => {
      if (unionId === UNION_A) return oversightA.promise;
      if (unionId === UNION_B) return oversightB.promise;
      throw new Error(`Unexpected union ${unionId}`);
    });
    mocks.isUnionAdmin.mockImplementation((unionId: string) => {
      if (unionId === UNION_A) return gamesA.promise;
      if (unionId === UNION_B) return gamesB.promise;
      throw new Error(`Unexpected union ${unionId}`);
    });

    renderAt(`/unions/${UNION_A}/operations`);
    await waitFor(() => expect(mocks.canOverseeUnion).toHaveBeenCalledWith(UNION_A));

    fireEvent.click(screen.getByRole('button', { name: 'Open Union B' }));
    await waitFor(() => {
      expect(mocks.canOverseeUnion).toHaveBeenCalledWith(UNION_B);
      expect(mocks.isUnionAdmin).toHaveBeenCalledWith(UNION_B, 'player-1');
    });

    await act(async () => {
      oversightB.resolve(false);
      gamesB.resolve(false);
      await Promise.all([oversightB.promise, gamesB.promise]);
    });
    await act(async () => {
      oversightA.resolve(true);
      gamesA.resolve(true);
      await Promise.all([oversightA.promise, gamesA.promise]);
    });

    expect(screen.getByRole('link', { name: 'Overview' })).toHaveAttribute(
      'href',
      `/unions/${UNION_B}`
    );
    for (const label of [...oversightLinks, 'Table Management']) {
      expect(screen.queryByRole('link', { name: label })).not.toBeInTheDocument();
    }
  });

  it('fails closed immediately when the authenticated player changes on the same union', async () => {
    mocks.canOverseeUnion.mockResolvedValue(true);
    mocks.isUnionAdmin.mockResolvedValue(true);
    const view = renderAt(`/unions/${UNION_A}/operations`);

    await waitFor(() => {
      expect(screen.getByRole('link', { name: 'Operations' })).toBeInTheDocument();
    });

    const playerTwoOversight = deferred<boolean>();
    const playerTwoGames = deferred<boolean>();
    mocks.canOverseeUnion.mockReturnValue(playerTwoOversight.promise);
    mocks.isUnionAdmin.mockReturnValue(playerTwoGames.promise);
    mocks.userId = 'player-2';

    view.rerender(
      <MemoryRouter initialEntries={[`/unions/${UNION_A}/operations`]}>
        <Routes>
          <Route path="*" element={<LayoutHarness />} />
        </Routes>
      </MemoryRouter>
    );

    for (const label of [...oversightLinks, 'Table Management']) {
      expect(screen.queryByRole('link', { name: label })).not.toBeInTheDocument();
    }
    await waitFor(() => {
      expect(mocks.isUnionAdmin).toHaveBeenCalledWith(UNION_A, 'player-2');
    });

    await act(async () => {
      playerTwoOversight.resolve(false);
      playerTwoGames.resolve(false);
      await Promise.all([playerTwoOversight.promise, playerTwoGames.promise]);
    });
  });

  it('invalidates current-union authority immediately when access changes', async () => {
    mocks.canOverseeUnion.mockResolvedValue(true);
    mocks.isUnionAdmin.mockResolvedValue(true);
    renderAt(`/unions/${UNION_A}/operations`);

    await waitFor(() => {
      expect(screen.getByRole('link', { name: 'Operations' })).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Table Management' })).toBeInTheDocument();
    });

    const refreshedOversight = deferred<boolean>();
    const refreshedGames = deferred<boolean>();
    mocks.canOverseeUnion.mockReturnValue(refreshedOversight.promise);
    mocks.isUnionAdmin.mockReturnValue(refreshedGames.promise);

    act(() => {
      mocks.subscriptions.get('UNION_UPDATED')?.({ unionId: UNION_A });
    });

    for (const label of [...oversightLinks, 'Table Management']) {
      expect(screen.queryByRole('link', { name: label })).not.toBeInTheDocument();
    }
    await waitFor(() => expect(mocks.canOverseeUnion).toHaveBeenCalledTimes(2));

    await act(async () => {
      refreshedOversight.resolve(false);
      refreshedGames.resolve(false);
      await Promise.all([refreshedOversight.promise, refreshedGames.promise]);
    });
  });
});
