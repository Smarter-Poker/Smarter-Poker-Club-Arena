/**
 * ONE LOOK AND FEEL, NOT ONE WINDOW (Dan 2026-09-20).
 *
 * "IT DOESN'T NEED TO BE A ONE TO ONE CLONE WITH EVERYTHING CONNECTED... JUST
 * THE SAME LOOK AND FEEL!! DO NOT ATTACH EVERYTHING TOGETHER WITH THE SAME
 * DISPLAY WINDOWS."
 *
 * Until this change the Game Board, Ticker Management, Club Messages and the
 * table creators were all printed inside ONE SpadeConsole whose title changed,
 * so every tool read as an interchangeable screen in the same physical window.
 * These tests pin the correction at the level Dan sees it: on every section
 * exactly one frame is drawn, it belongs to that section alone, and the three
 * principal sections wear three different approved frame families. The section
 * strip is navigation and sits outside every frame. The behaviour the frames
 * carry - access, the board's data, the draft guard - is unchanged and is
 * pinned by the suites beside this one.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { BrowserRouter, MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const mocks = vi.hoisted(() => ({
  access: null as
    | null
    | (() => Promise<{ allowed: boolean; unionId: string | null; reason: string }>),
  confirm: vi.fn(async () => true),
  list: null as null | (() => Promise<unknown>),
}));

vi.mock('../../src/hooks/useAuthUser', () => ({
  useAuthUser: () => ({ user: { id: 'operator-1' } }),
}));
vi.mock('../../src/hooks/useMasterBusSubscription', () => ({
  useMasterBusSubscription: () => {},
  useMasterBusSubscriptions: () => {},
}));
vi.mock('../../src/hooks/useGameManagementRealtime', () => ({
  useGameManagementRealtime: () => 'live',
  default: () => 'live',
}));
vi.mock('../../src/utils/clubIdResolver', () => ({ resolveClubUUID: async () => 'club-uuid-1' }));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: () => {} }));
vi.mock('../../src/services/GameAccessService', () => ({
  fetchGameCreationAccess: () =>
    mocks.access ? mocks.access() : Promise.resolve({ allowed: true, unionId: null, reason: 'ok' }),
}));
vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({
            data: { id: 'club-uuid-1', name: 'Deep Stack Society' },
            error: null,
          }),
        }),
      }),
    }),
  },
}));
vi.mock('../../src/services/UnionService', () => ({
  unionService: { isUnionAdmin: async () => false },
}));
vi.mock('../../src/components/common/Toast', () => ({
  useToast: () => ({ success: () => {}, error: () => {}, info: () => {} }),
}));
vi.mock('../../src/components/common/confirmDialog', () => ({ confirmDialog: mocks.confirm }));
vi.mock('../../src/services/GameManagementService', () => ({
  gameManagementService: {
    list: async () =>
      mocks.list
        ? mocks.list()
        : {
            items: [
              {
                id: 'tbl-live',
                kind: 'table',
                name: 'Friday Deep Stack',
                status: 'running',
                club_id: 'club-uuid-1',
                players: 6,
                max_players: 9,
                bucket: 0,
              },
            ],
            counts: { total: 1, live: 1, scheduled: 0, closed: 0, closedWithinHorizon: 0 },
            nextCursor: null,
          },
    getHealth: async () => ({
      latestEventSequence: 0,
      lastEventAt: null,
      eventsLastHour: 0,
      commandsLast24h: 0,
      rejectedLast24h: 0,
      integrityAlerts: 0,
      scheduledPending: 0,
      scheduledRejected24h: 0,
      eventRows: 0,
      retentionDays: 30,
    }),
  },
}));
vi.mock('../../src/services/TickerManagementService', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('../../src/services/TickerManagementService')>();
  return {
    ...original,
    tickerManagementService: {
      getManagement: async () => ({
        settings: original.DEFAULT_TICKER_SETTINGS,
        revision: 1,
        updatedAt: null,
      }),
      save: vi.fn(),
    },
  };
});
vi.mock('../../src/services/ClubMessageManagementService', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('../../src/services/ClubMessageManagementService')>();
  return {
    ...original,
    clubMessageManagementService: {
      get: async () => ({
        identity: { tagline: 'Deep Stacks Nightly', lobbyMessage: '', description: '' },
        identityRevision: 1,
        announcements: [],
      }),
      saveIdentity: vi.fn(),
      manageAnnouncement: vi.fn(),
    },
  };
});
/* The creators keep their own suites. Here they only have to land on the page
   as their own composition, so each is a marker that draws no frame. */
vi.mock('../../src/pages/CreateTablePage', () => ({
  default: () => <div data-testid="create-table-selector">Choose Game Type</div>,
  isCreateTableGameType: (value: unknown) => value === 'nlh',
  CREATE_TABLE_GAME_TYPE_IDS: ['nlh'],
}));
vi.mock('../../src/pages/TableConfigPage', () => ({
  default: () => <div data-testid="table-config">NLH Setup</div>,
}));

import GameManagementPage, {
  ContractHistoryDialog,
  EditGameDialog,
  ScheduleCloseDialog,
} from '../../src/pages/GameManagementPage';
import { holdInAppNavigation, mayLeaveCurrentPage } from '../../src/lib/navigationGuard';

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{`${location.pathname}${location.search}`}</output>;
}

const renderAt = (entry: string) =>
  render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route
          path="/clubs/:clubId/table-management"
          element={
            <>
              <GameManagementPage scope="club" />
              <LocationProbe />
            </>
          }
        />
      </Routes>
    </MemoryRouter>
  );

const renderInBrowser = () =>
  render(
    <BrowserRouter>
      <Routes>
        <Route
          path="/clubs/:clubId/table-management"
          element={
            <>
              <GameManagementPage scope="club" />
              <LocationProbe />
            </>
          }
        />
      </Routes>
    </BrowserRouter>
  );

const BASE = '/clubs/deep-stack-society/table-management';
/** Every painted frame on the page. SpadeConsole's root always carries `sc`. */
const frames = () => Array.from(document.querySelectorAll<HTMLElement>('.sc'));
const familyOf = (frame: HTMLElement) =>
  Array.from(frame.classList).find((name) => name.startsWith('sc--family-'));

describe('each Table Management section is its own page on its own frame', () => {
  beforeEach(() => {
    mocks.access = null;
    mocks.list = null;
    mocks.confirm.mockReset();
    mocks.confirm.mockResolvedValue(true);
  });

  it('draws the Game Board alone, on the spade console with the spade crest', async () => {
    renderAt(BASE);
    await screen.findByText('Friday Deep Stack');
    const drawn = frames();
    expect(drawn).toHaveLength(1);
    expect(drawn[0].classList).toContain('sc--family-spade');
    expect(drawn[0].classList).toContain('sc--crest-spade');
    expect(within(drawn[0]).getByRole('heading', { name: 'Table Management' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Ticker Management' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Club Messages' })).toBeNull();
  });

  it('normalizes dynamic game, readiness, and command labels before painting them', async () => {
    mocks.list = async () => ({
      items: [
        {
          id: 'tournament-copy',
          kind: 'tournament',
          name: 'Friday Flight',
          status: 'late_registration',
          club_id: 'club-uuid-1',
          players: 0,
          max_players: 90,
          bucket: 0,
          contract: {
            gameId: 'tournament-copy',
            version: 3,
            contractHash: 'abcdef1234567890',
            publishedAt: '2026-10-04T12:00:00Z',
            changeReason: 'operator_update',
            contractLocked: false,
            readiness: {
              state: 'incomplete',
              canStart: false,
              contractLocked: false,
              guaranteeEnforced: false,
              guaranteedPrize: 0,
              satelliteSeatGuarantee: 0,
              effectiveGuarantee: 0,
              currentPrizePool: 0,
              overlayRequired: 0,
              bankType: 'club',
              bankBalance: 0,
              bankFloor: 0,
              otherLiveExposure: 0,
              shortBy: 0,
            },
          },
          lastCommand: {
            gameId: 'tournament-copy',
            commandId: '12345678-aaaa-bbbb-cccc-123456789000',
            action: 'close',
            status: 'rejected',
            versionBefore: 2,
            versionAfter: 2,
            createdAt: '2026-10-04T12:00:00Z',
            completedAt: '2026-10-04T12:00:01Z',
            reconciliationState: 'confirmed',
          },
        },
      ],
      counts: {
        total: 1,
        live: 1,
        scheduled: 0,
        closed: 0,
        closedWithinHorizon: 0,
        closedHorizonDays: 7,
      },
      nextCursor: null,
    });
    renderAt(BASE);

    expect(await screen.findByText('Late Registration')).toBeTruthy();
    expect(screen.getByText('Incomplete')).toBeTruthy();
    expect(screen.getByText('Rejected Close')).toBeTruthy();
  });

  it('keeps the section strip outside every frame', async () => {
    renderAt(BASE);
    await screen.findByText('Friday Deep Stack');
    const strip = screen.getByRole('navigation', { name: 'Management Sections' });
    expect(strip.closest('.sc')).toBeNull();
  });

  it('draws Ticker Management as its own shark console, with no board around it', async () => {
    renderAt(`${BASE}?section=ticker`);
    const heading = await screen.findByRole('heading', { name: 'Ticker Management' });
    const drawn = frames();
    expect(drawn).toHaveLength(1);
    expect(drawn[0].classList).toContain('sc--family-shark');
    expect(drawn[0].contains(heading)).toBe(true);
    expect(document.getElementById('table-management-title')).toBeNull();
    expect(screen.queryByText('Friday Deep Stack')).toBeNull();
    expect(within(drawn[0]).getByRole('button', { name: 'Save Ticker' })).toBeTruthy();
  });

  it('draws Club Messages as its own riveted console, with no board around it', async () => {
    renderAt(`${BASE}?section=messages`);
    const heading = await screen.findByRole('heading', { name: 'Club Messages' });
    const drawn = frames();
    expect(drawn).toHaveLength(1);
    expect(drawn[0].classList).toContain('sc--family-riveted');
    expect(drawn[0].contains(heading)).toBe(true);
    expect(document.getElementById('table-management-title')).toBeNull();
    expect(within(drawn[0]).getByRole('button', { name: 'Save Identity' })).toBeTruthy();
  });

  it('gives the three principal sections three different frame families', async () => {
    const seen = new Set<string | undefined>();
    for (const [entry, title] of [
      [BASE, 'Table Management'],
      [`${BASE}?section=ticker`, 'Ticker Management'],
      [`${BASE}?section=messages`, 'Club Messages'],
    ] as const) {
      const view = renderAt(entry);
      await screen.findByRole('heading', { name: title });
      seen.add(familyOf(frames()[0]));
      view.unmount();
    }
    expect([...seen].sort()).toEqual([
      'sc--family-riveted',
      'sc--family-shark',
      'sc--family-spade',
    ]);
  });

  it('moves between sections by address, replacing the page on show', async () => {
    renderAt(BASE);
    await screen.findByText('Friday Deep Stack');
    const strip = screen.getByRole('navigation', { name: 'Management Sections' });
    await act(async () => {
      fireEvent.click(within(strip).getByRole('button', { name: /Ticker Management/ }));
    });
    await screen.findByRole('heading', { name: 'Ticker Management' });
    expect(screen.getByTestId('location').textContent).toBe(`${BASE}?section=ticker`);
    expect(frames()).toHaveLength(1);
    await act(async () => {
      fireEvent.click(within(strip).getByRole('button', { name: /Game Board/ }));
    });
    await screen.findByText('Friday Deep Stack');
    expect(screen.getByTestId('location').textContent).toBe(BASE);
  });

  it('asks before a section change throws a ticker draft away, and stays when refused', async () => {
    mocks.confirm.mockResolvedValue(false);
    renderAt(`${BASE}?section=ticker`);
    await screen.findByRole('heading', { name: 'Ticker Management' });
    const composer = await screen.findByLabelText('New Custom Ticker Message');
    await waitFor(() => expect((composer as HTMLInputElement).disabled).toBe(false));
    fireEvent.change(composer, { target: { value: 'Deep stacks tonight at nine' } });
    const strip = screen.getByRole('navigation', { name: 'Management Sections' });
    await act(async () => {
      fireEvent.click(within(strip).getByRole('button', { name: /Club Messages/ }));
    });
    expect(mocks.confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Discard the unsaved changes on this management section?',
      })
    );
    expect(screen.getByTestId('location').textContent).toBe(`${BASE}?section=ticker`);
    expect(screen.getByRole('heading', { name: 'Ticker Management' })).toBeTruthy();
  });

  it('restores the exact browser-history entry when Back is refused for a dirty draft', async () => {
    const confirm = vi.fn(() => false);
    vi.stubGlobal('confirm', confirm);
    window.history.replaceState({ idx: 0, marker: 'before' }, '', BASE);
    window.history.pushState({ idx: 1, marker: 'draft' }, '', `${BASE}?section=ticker`);
    const anchorUrl = window.location.href;
    const anchorState = window.history.state;
    const go = vi.spyOn(window.history, 'go').mockImplementation(() => {
      window.history.replaceState(anchorState, '', anchorUrl);
      window.dispatchEvent(new PopStateEvent('popstate', { state: anchorState }));
    });
    renderInBrowser();
    const composer = await screen.findByLabelText('New Custom Ticker Message');
    await waitFor(() => expect((composer as HTMLInputElement).disabled).toBe(false));
    fireEvent.change(composer, { target: { value: 'Keep this draft' } });

    act(() => {
      window.history.replaceState({ idx: 0, marker: 'before' }, '', BASE);
      window.dispatchEvent(new PopStateEvent('popstate', { state: { idx: 0, marker: 'before' } }));
    });

    expect(confirm).toHaveBeenCalledWith(
      'Leave Table Management And Discard Your Unsaved Changes?'
    );
    expect(go).toHaveBeenCalledWith(1);
    expect(window.location.href).toBe(anchorUrl);
    expect(window.history.state).toEqual(anchorState);
    expect(screen.getByRole('heading', { name: 'Ticker Management' })).toBeTruthy();
    go.mockRestore();
    vi.unstubAllGlobals();
  });

  it('allows the browser-history transition when a dirty-draft warning is accepted', async () => {
    const confirm = vi.fn(() => true);
    vi.stubGlobal('confirm', confirm);
    window.history.replaceState({ idx: 0, marker: 'before' }, '', BASE);
    window.history.pushState({ idx: 1, marker: 'draft' }, '', `${BASE}?section=ticker`);
    const go = vi.spyOn(window.history, 'go');
    renderInBrowser();
    const composer = await screen.findByLabelText('New Custom Ticker Message');
    await waitFor(() => expect((composer as HTMLInputElement).disabled).toBe(false));
    fireEvent.change(composer, { target: { value: 'Discard this draft' } });

    act(() => {
      window.history.replaceState({ idx: 0, marker: 'before' }, '', BASE);
      window.dispatchEvent(new PopStateEvent('popstate', { state: { idx: 0, marker: 'before' } }));
    });

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(go).not.toHaveBeenCalled();
    expect(window.location.pathname + window.location.search).toBe(BASE);
    expect(window.history.state).toEqual({ idx: 0, marker: 'before' });
    go.mockRestore();
    vi.unstubAllGlobals();
  });

  it('shows the Add Table selector as its own page instead of inside the board', async () => {
    renderAt(`${BASE}?create=table`);
    const selector = await screen.findByTestId('create-table-selector');
    expect(selector.closest('.sc')).toBeNull();
    expect(selector.closest('section')?.getAttribute('aria-label')).toBe('Create Table');
    expect(document.getElementById('table-management-title')).toBeNull();
  });

  it('shows the table configuration as its own page with its own way back', async () => {
    renderAt(`${BASE}?create=table&game=nlh`);
    const config = await screen.findByTestId('table-config');
    expect(config.closest('.sc')).toBeNull();
    expect(screen.getByRole('button', { name: 'Back To Game Types' })).toBeTruthy();
    expect(document.getElementById('table-management-title')).toBeNull();
  });

  it('refuses an affiliated club on the one-plate shark frame, never the board', async () => {
    mocks.access = async () => ({ allowed: true, unionId: 'union-1', reason: 'ok' });
    renderAt(BASE);
    await screen.findByRole('heading', { name: 'This Club Is Managed By Its Union' });
    const drawn = frames();
    expect(drawn).toHaveLength(1);
    expect(drawn[0].classList).toContain('sc--family-shark');
    expect(
      within(drawn[0])
        .getAllByRole('button')
        .map((b) => b.textContent)
    ).toEqual(['Return']);
    expect(screen.queryByText('Friday Deep Stack')).toBeNull();
  });

  it('checks access on the flat-headed spade, not a borrowed crest', async () => {
    mocks.access = () => new Promise(() => {});
    renderAt(BASE);
    await screen.findByText('Verifying Game-Management Access…');
    const drawn = frames();
    expect(drawn).toHaveLength(1);
    expect(drawn[0].classList).toContain('sc--crest-flat');
  });
});

describe('the dialogs over the board wear their own families', () => {
  const game = {
    id: 'game-1',
    kind: 'table' as const,
    name: 'Friday Cash',
    status: 'waiting',
    clubId: 'club-1',
    hostName: 'Shark Club',
    variant: 'NLH',
    players: 0,
    maxPlayers: 9,
    startTime: null,
    smallBlind: 1,
    bigBlind: 2,
    minBuyIn: 40,
    maxBuyIn: 200,
    buyIn: 0,
    contract: null,
    lastCommand: null,
    pendingSchedule: null,
  };

  it('edits on the riveted frame with its two plates', () => {
    render(<EditGameDialog game={game as any} busy={false} onClose={() => {}} onSave={() => {}} />);
    const frame = frames()[0];
    expect(frame.classList).toContain('sc--family-riveted');
    expect(frame.querySelectorAll('.sc-plate')).toHaveLength(2);
  });

  it('schedules a close on the flat-headed spade with its two plates', () => {
    render(
      <ScheduleCloseDialog
        game={game as any}
        busy={false}
        onClose={() => {}}
        onSchedule={() => {}}
      />
    );
    const frame = frames()[0];
    expect(frame.classList).toContain('sc--family-spade');
    expect(frame.classList).toContain('sc--crest-flat');
    expect(frame.querySelectorAll('.sc-plate')).toHaveLength(2);
  });

  it('shows contract history on the one-plate shark, so no painted plate sits empty', () => {
    render(
      <ContractHistoryDialog game={game as any} versions={[]} loading={false} onClose={() => {}} />
    );
    const frame = frames()[0];
    expect(frame.classList).toContain('sc--family-shark');
    expect(frame.querySelectorAll('.sc-plate')).toHaveLength(1);
  });

  it('normalizes readiness and change-reason values in contract history', () => {
    render(
      <ContractHistoryDialog
        game={
          {
            ...game,
            kind: 'tournament',
            contract: {
              version: 4,
              contractLocked: false,
              readiness: {
                state: 'incomplete',
                satelliteSeatGuarantee: 0,
                effectiveGuarantee: 0,
                overlayRequired: 0,
                bankType: 'club',
                bankBalance: 0,
                otherLiveExposure: 0,
                shortBy: 0,
              },
            },
          } as any
        }
        versions={[
          {
            version: 4,
            contractHash: 'abcdef1234567890',
            contract: {},
            publishedAt: '2026-10-04T12:00:00Z',
            changeReason: 'scheduled_update',
          },
        ]}
        loading={false}
        onClose={() => {}}
      />
    );
    expect(screen.getByText('Incomplete')).toBeTruthy();
    expect(screen.getByText('Scheduled Update')).toBeTruthy();
  });
});

describe('an in-app navigation asks the page holding a draft', () => {
  it('lets navigation through when nothing is held, and asks the holder when something is', () => {
    expect(mayLeaveCurrentPage()).toBe(true);
    const question = vi.fn(() => false);
    const release = holdInAppNavigation(question);
    expect(mayLeaveCurrentPage()).toBe(false);
    expect(question).toHaveBeenCalledTimes(1);
    release();
    expect(mayLeaveCurrentPage()).toBe(true);
  });

  it('releases only the holder that registered', () => {
    const first = holdInAppNavigation(() => false);
    const second = holdInAppNavigation(() => true);
    first();
    expect(mayLeaveCurrentPage()).toBe(true);
    second();
  });

  it('is asked by the hamburger menu before it navigates', () => {
    const menu = readFileSync(
      resolve(__dirname, '../../src/components/navigation/HamburgerMenu.tsx'),
      'utf8'
    );
    const body = menu.slice(menu.indexOf('const handleNavigate = (path: string) => {'));
    const guard = body.indexOf('if (!mayLeaveCurrentPage()) return;');
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(body.indexOf('navigate(path);'));
  });

  it('is held by Table Management only while a section draft is dirty', () => {
    const page = readFileSync(resolve(__dirname, '../../src/pages/GameManagementPage.tsx'), 'utf8');
    expect(page).toMatch(
      /if \(!surfaceDirty\) return;\s*return holdInAppNavigation\(\(\) =>\s*window\.confirm\('Leave Table Management And Discard Your Unsaved Changes\?'\)/
    );
  });
});

/* The error state is one of the states Dan sees: the board used to print the
   raw "TypeError: Failed to fetch", and because the health read rode in the
   same wave as the failed board read, the rail said "Reading Management
   Health" for ever. */
describe('the Game Board error state speaks plainly', () => {
  beforeEach(() => {
    mocks.access = null;
    mocks.list = () => Promise.reject(new TypeError('Failed to fetch'));
  });
  afterEach(() => {
    mocks.list = null;
    vi.unstubAllEnvs();
  });

  it('prints a plain sentence, never the raw fetch error', async () => {
    vi.stubEnv('DEV', false);
    renderAt(BASE);
    expect(
      await screen.findByText('Connection Problem. Please Check Your Internet And Try Again.')
    ).toBeTruthy();
    expect(screen.queryByText(/TypeError|Failed to fetch/i)).toBeNull();
    expect(screen.getByRole('button', { name: 'Try Again' })).toBeTruthy();
  });

  it('stops reading management health when the board read fails', async () => {
    renderAt(BASE);
    expect(await screen.findByText('Management Health Unavailable')).toBeTruthy();
    expect(screen.queryByText('Reading Management Health')).toBeNull();
  });

  it('reports unknown game counts after the first read fails instead of painting zeroes', async () => {
    renderAt(BASE);
    expect(
      await screen.findByText(
        (_content, element) =>
          element?.tagName === 'SPAN' && element.textContent === 'Unavailable Game Counts'
      )
    ).toBeTruthy();
    expect(screen.queryByText('0 Live')).toBeNull();
    expect(screen.queryByText('0 Scheduled')).toBeNull();
    expect(screen.queryByText('0 Total')).toBeNull();
  });
});
