import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import type { TickerItem } from '../../src/components/tournament/tickerMessages';

const mocks = vi.hoisted(() => ({
  userId: 'viewer-a' as string | null,
  /* The route is /clubs/club-a - a SLUG, which is a legitimate club
     identifier here (resolveClubIdFilter accepts uuid, integer code or slug).
     What resolveClubUUID hands BACK has to be a real uuid though, because the
     ticker now checks it before putting it in a uuid column: the resolver's
     documented fallback is to return its own input, and that fallback is what
     wrote 243 rows of Postgres 22P02 into horse_bug_reports.
     See tests/a-route-segment-is-not-an-id.law.test.ts. */
  clubUuid: '11111111-2222-4333-8444-555555555555',
  warn: vi.fn(),
  hidden: false,
  read: vi.fn(),
  settings: vi.fn(),
  report: vi.fn(),
  toast: vi.fn(),
  resetSettings: vi.fn(),
  listeners: new Map<string, Set<(payload: unknown) => void>>(),
  defaults: {
    enabled: true,
    speedSeconds: 24,
    backgroundColor: '#0b1a33',
    textColor: '#f5fbff',
    accentColor: '#00d4ff',
    fontFamily: 'Rajdhani',
    customMessages: [],
    serviceMessages: [],
    sources: {
      starting_soon: true,
      overlays: false,
      custom_messages: false,
      registration_closing: false,
      guarantees: false,
      table_openings: false,
      maintenance: false,
      winner_results: false,
    },
  },
}));

interface Query {
  table: string;
  columns: string;
  userId?: string;
  clubIds?: string[];
  sources?: Record<string, boolean>;
  railClubId?: string | null;
}
type Reply = { data: Record<string, unknown>[] | null; error: { message: string } | null };
const ok = (data: Record<string, unknown>[] = []): Reply => ({ data, error: null });
const failed: Reply = { data: null, error: { message: 'connection interrupted' } };

/** The name the container calls, and the seam every feed test speaks through. */
const FEED = 'fn_get_ticker_feed';

/** A successful feed. Anything not named comes back empty, which is a real
 *  answer - it CLEARS that source - and is different from `failed`. */
const feed = (over: Partial<Record<string, Record<string, unknown>[]>> = {}): Reply => ({
  data: {
    ok: true,
    clubs: 1,
    upcoming: [],
    overlays: [],
    reg_closing: [],
    guarantees: [],
    results: [],
    table_openings: [],
    ...over,
  } as unknown as Record<string, unknown>[],
  error: null,
});

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    /* THE READ IS ONE CALL NOW (2026-09-14). Five queries became
       fn_get_ticker_feed, so the harness routes the RPC through the same
       `mocks.read` seam the query builder uses: every test that made a table
       fail, hang or answer empty says the same thing about the feed, and the
       assertions stay about BEHAVIOUR rather than about which builder ran. */
    rpc: (fn: string, args: Record<string, unknown>) =>
      Promise.resolve().then(() =>
        mocks.read({
          table: fn,
          columns: '',
          userId: mocks.userId ?? undefined,
          sources: args?.p_sources as Record<string, boolean> | undefined,
          railClubId: (args?.p_rail_club_id as string | null) ?? null,
        })
      ),
    from: (table: string) => {
      const query: Query = { table, columns: '' };
      const builder = {
        select: (columns: string) => {
          query.columns = columns;
          return builder;
        },
        eq: (key: string, value: string) => {
          if (key === 'user_id') query.userId = value;
          return builder;
        },
        in: (key: string, value: string[]) => {
          if (key === 'club_id') query.clubIds = value;
          return builder;
        },
        gte: () => builder,
        lte: () => builder,
        gt: () => builder,
        is: () => builder,
        or: () => builder,
        order: () => builder,
        limit: () => builder,
        maybeSingle: () => Promise.resolve({ data: { union_id: null }, error: null }),
        then: (resolve: (value: Reply) => unknown, reject: (reason: unknown) => unknown) =>
          Promise.resolve()
            .then(() => mocks.read(query))
            .then(resolve, reject),
      };
      return builder;
    },
  },
}));
vi.mock('../../src/lib/authUtils', () => ({
  readLocalSession: () => (mocks.userId ? { userId: mocks.userId } : null),
}));
vi.mock('react-router-dom', () => ({
  useNavigate: () => vi.fn(),
  useLocation: () => ({ pathname: '/clubs/club-a' }),
}));
vi.mock('../../src/utils/errorReporter', () => ({
  reportError: mocks.report,
  reportWarning: mocks.warn,
}));
vi.mock('../../src/core/MasterBus', () => ({ busToast: mocks.toast }));
vi.mock('../../src/hooks/useTableSettings', () => ({
  useTableSettings: () => ({ settings: { showTicker: true } }),
}));
vi.mock('../../src/hooks/useMasterBusSubscription', async () => {
  const { useEffect } = await import('react');
  return {
    useMasterBusSubscription: (event: string, callback: (payload: unknown) => void) => {
      useEffect(() => {
        const listeners = mocks.listeners.get(event) ?? new Set();
        listeners.add(callback);
        mocks.listeners.set(event, listeners);
        return () => {
          listeners.delete(callback);
        };
      }, [event, callback]);
    },
  };
});
vi.mock('../../src/services/TickerManagementService', () => ({
  DEFAULT_TICKER_SETTINGS: mocks.defaults,
  resetTickerSettingsCache: mocks.resetSettings,
  tickerManagementService: { get: mocks.settings },
}));
/* importActual keeps the REAL isUUID, so this suite exercises the actual
   guard rather than a copy of it that could drift away from it. */
vi.mock('../../src/utils/clubIdResolver', async (importActual) => ({
  ...(await importActual<typeof import('../../src/utils/clubIdResolver')>()),
  resolveClubUUID: async () => mocks.clubUuid,
}));
vi.mock('../../src/components/tournament/useTopChromeOffset', () => ({
  useTopChromeOffset: () => 0,
}));
vi.mock('../../src/components/tournament/TickerRail', () => ({
  TickerRail: ({ items }: { items: TickerItem[] }) => (
    <div data-testid="rail">
      {items.map((item) => (
        <span key={item.id}>{item.subject}</span>
      ))}
    </div>
  ),
}));

import { TournamentStartingTicker } from '../../src/components/tournament/TournamentStartingTicker';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function tournament(name = 'Confirmed Event') {
  return {
    id: name,
    name,
    start_time: new Date(Date.now() + 240_000).toISOString(),
    club_id: 'club-a',
    current_players: 4,
    status: 'REGISTERING',
    tournament_type: 'MTT',
    /* Resolved by the feed now, not by a second 200-row read of
       tournament_players in the browser. */
    is_registered: false,
    foreign_club_name: null,
  };
}
function answer(query: Query): Reply {
  if (query.table === 'club_members') return ok([{ club_id: `club-${query.userId}` }]);
  if (query.table === FEED) return feed({ upcoming: [tournament()] });
  return ok();
}
async function mount() {
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(<TournamentStartingTicker />);
  });
  return view;
}
/* THE CONTAINER'S SWEEP IS NO LONGER 1Hz (2026-09-14).

   Both of the container's intervals used to run every second: one to advance a
   countdown that has since moved into TickerClock, and one to walk every
   announcement looking for the two toast thresholds. Neither needs a second,
   and the strip sits above a live poker table on the same thread, so both are
   CONTAINER_TICK_MS now. A test that advanced 1000ms and expected the sweep to
   have run was pinned to the old cadence, not to any behaviour. */
const TOAST_SWEEP_MS = 5_000;

async function tick(ms = 30_000) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}
async function emit(event: string) {
  const payload =
    event === 'AUTH_STATE_CHANGED'
      ? { userId: mocks.userId, isAuthenticated: !!mocks.userId }
      : { clubId: 'club-a' };
  await act(async () => {
    mocks.listeners.get(event)?.forEach((callback) => callback(payload));
  });
}
async function visibility(hidden: boolean) {
  mocks.hidden = hidden;
  await act(async () => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
}
function calls(table: string) {
  return mocks.read.mock.calls.filter(([query]) => query.table === table);
}

describe('the mounted ticker recovers without stale account data or overlapping reads', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-11T05:00:00Z'));
    mocks.userId = 'viewer-a';
    mocks.hidden = false;
    mocks.listeners.clear();
    mocks.read.mockReset().mockImplementation(answer);
    mocks.settings.mockReset().mockResolvedValue(mocks.defaults);
    mocks.report.mockReset();
    mocks.toast.mockReset();
    mocks.resetSettings.mockReset();
    vi.spyOn(document, 'hidden', 'get').mockImplementation(() => mocks.hidden);
    localStorage.clear();
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('clears a departing account immediately and stops its registration toasts', async () => {
    mocks.read.mockImplementation((query: Query) =>
      query.table === FEED
        ? feed({ upcoming: [{ ...tournament(), is_registered: true }] })
        : answer(query)
    );
    await mount();
    expect(screen.getByText('Confirmed Event')).toBeTruthy();
    mocks.userId = null;
    await emit('AUTH_STATE_CHANGED');
    expect(screen.queryByText('Confirmed Event')).toBeNull();
    await tick(1000);
    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it('retires a previous account membership read before it can cache or paint', async () => {
    const old = deferred<Reply>();
    mocks.read.mockImplementation((query: Query) => {
      if (query.table === 'club_members' && query.userId === 'viewer-a') return old.promise;
      if (query.table === FEED) return feed({ upcoming: [tournament(`club-${query.userId}`)] });
      return answer(query);
    });
    await mount();
    mocks.userId = 'viewer-b';
    await emit('AUTH_STATE_CHANGED');
    expect(screen.getByText('club-viewer-b')).toBeTruthy();
    await act(async () => {
      old.resolve(ok([{ club_id: 'old-account-club' }]));
    });
    expect(screen.queryByText('old-account-club')).toBeNull();
    await tick();
    /* THE SCOPE MOVED INTO THE FUNCTION (2026-09-14). The browser no longer
       ships a club-id list, so the thing that can leak an account is the
       IDENTITY the call is made as. That is what this now pins. */
    expect(calls(FEED).every(([query]) => query.userId === 'viewer-b')).toBe(true);
    expect(calls('club_members')).toHaveLength(2);
  });

  it('retires a previous account feed even if it finishes after the new feed', async () => {
    const old = deferred<Reply>();
    mocks.read.mockImplementation((query: Query) =>
      query.table === FEED
        ? query.userId === 'viewer-a'
          ? old.promise
          : feed({ upcoming: [tournament('New Account')] })
        : answer(query)
    );
    await mount();
    mocks.userId = 'viewer-b';
    await emit('AUTH_STATE_CHANGED');
    expect(screen.getByText('New Account')).toBeTruthy();
    await act(async () => {
      old.resolve(feed({ upcoming: [tournament('Old Account')] }));
    });
    expect(screen.queryByText('Old Account')).toBeNull();
    expect(screen.getByText('New Account')).toBeTruthy();
  });

  it('retries returned membership errors on the next poll without caching an empty scope', async () => {
    let memberships = 0;
    mocks.read.mockImplementation((query: Query) =>
      query.table === 'club_members' && ++memberships === 1 ? failed : answer(query)
    );
    await mount();
    expect(screen.queryByTestId('rail')).toBeNull();
    await tick();
    expect(calls('club_members')).toHaveLength(2);
    expect(screen.getByText('Confirmed Event')).toBeTruthy();
    expect(mocks.report).toHaveBeenCalled();
  });

  it('preserves confirmed announcements through a failed poll and clears on a successful empty result', async () => {
    await mount();
    mocks.read.mockImplementation((query: Query) =>
      query.table === FEED ? failed : answer(query)
    );
    await tick();
    expect(screen.getByText('Confirmed Event')).toBeTruthy();
    expect(mocks.report).toHaveBeenCalled();
    mocks.read.mockImplementation((query: Query) =>
      query.table === FEED ? feed() : answer(query)
    );
    await tick();
    expect(screen.queryByText('Confirmed Event')).toBeNull();
  });

  it('coalesces slow polls and resume events into one trailing read', async () => {
    const slow = deferred<Reply>();
    let reads = 0;
    mocks.read.mockImplementation((query: Query) =>
      query.table === FEED && ++reads === 1 ? slow.promise : answer(query)
    );
    await mount();
    await tick(90_000);
    await visibility(true);
    await visibility(false);
    await visibility(false);
    expect(calls(FEED)).toHaveLength(1);
    await act(async () => {
      slow.resolve(ok([tournament('Older Response')]));
    });
    expect(calls(FEED)).toHaveLength(2);
    expect(screen.getByText('Confirmed Event')).toBeTruthy();
    expect(screen.queryByText('Older Response')).toBeNull();
  });

  it('does not launch a queued follow-up while hidden or after unmount', async () => {
    const slow = deferred<Reply>();
    mocks.read.mockImplementation((query: Query) =>
      query.table === FEED ? slow.promise : answer(query)
    );
    const view = await mount();
    await tick();
    await visibility(true);
    await act(async () => {
      slow.resolve(ok([tournament()]));
    });
    expect(calls(FEED)).toHaveLength(1);
    view.unmount();
    await visibility(false);
    await tick(60_000);
    expect(calls(FEED)).toHaveLength(1);
  });

  it('hides a disabled source even when its replacement poll cannot finish', async () => {
    await mount();
    mocks.settings.mockResolvedValue({
      ...mocks.defaults,
      sources: { ...mocks.defaults.sources, starting_soon: false },
    });
    mocks.read.mockResolvedValue(failed);
    await emit('TICKER_SETTINGS_CHANGED');
    expect(screen.queryByText('Confirmed Event')).toBeNull();
  });

  it('coalesces slow settings reads and refreshes them immediately on resume', async () => {
    const slow = deferred<typeof mocks.defaults>();
    mocks.settings.mockReturnValueOnce(slow.promise);
    await mount();
    await tick(90_000);
    expect(mocks.settings).toHaveBeenCalledTimes(1);
    await visibility(true);
    await act(async () => {
      slow.resolve(mocks.defaults);
    });
    expect(mocks.settings).toHaveBeenCalledTimes(1);
    await visibility(false);
    expect(mocks.settings).toHaveBeenCalledTimes(2);
  });

  it('keeps confirmed content and toast history on same-account token rotation', async () => {
    mocks.read.mockImplementation((query: Query) =>
      query.table === FEED
        ? feed({ upcoming: [{ ...tournament(), is_registered: true }] })
        : answer(query)
    );
    await mount();
    await tick(TOAST_SWEEP_MS);
    expect(mocks.toast).toHaveBeenCalledTimes(1);
    /* COUNT THE FEED, NOT EVERY READ (2026-09-14). This used to compare the
       raw call count, which worked only because `supabase.rpc` was not mocked
       at all and every RPC in the tree was invisible to the harness. The RPC
       is the read now, so the harness sees them - including the responsible
       gaming check, which SHOULD re-run when auth changes and did so all
       along. The claim being made here has always been "a token rotation on
       the same account does not refetch the bar", so count the bar's read. */
    const reads = calls(FEED).length;
    await emit('AUTH_STATE_CHANGED');
    expect(screen.getByText('Confirmed Event')).toBeTruthy();
    await tick(TOAST_SWEEP_MS);
    expect(mocks.toast).toHaveBeenCalledTimes(1);
    expect(calls(FEED)).toHaveLength(reads);
    expect(mocks.resetSettings).not.toHaveBeenCalled();
  });

  it('removes a departed club immediately and discovers a joined club without waiting for the cache', async () => {
    await mount();
    mocks.read.mockImplementation((query: Query) =>
      query.table === 'club_members' ? ok() : answer(query)
    );
    await emit('CLUB_LEFT');
    expect(screen.queryByText('Confirmed Event')).toBeNull();
    mocks.read.mockImplementation(answer);
    await emit('CLUB_JOINED');
    expect(screen.getByText('Confirmed Event')).toBeTruthy();
    expect(calls('club_members')).toHaveLength(3);
  });

  it('expires preserved announcements while the network is still unavailable', async () => {
    await mount();
    mocks.read.mockResolvedValue(failed);
    await tick(280_000);
    expect(screen.queryByText('Confirmed Event')).toBeNull();
  });

  it('keeps a confirmed registration when its read fails instead of announcing it twice', async () => {
    mocks.read.mockImplementation((query: Query) =>
      query.table === FEED
        ? feed({ upcoming: [{ ...tournament(), is_registered: true }] })
        : answer(query)
    );
    await mount();
    await tick(1000);
    mocks.read.mockImplementation((query: Query) =>
      query.table === FEED ? failed : answer(query)
    );
    await tick();
    expect(screen.getByText('Confirmed Event')).toBeTruthy();
    expect(mocks.toast).toHaveBeenCalledTimes(1);
    expect(mocks.report).toHaveBeenCalledWith(failed.error, 'TickerFeed.fetch');
  });
  it('bounds a retained overlay to two poll intervals during a connection failure', async () => {
    mocks.settings.mockResolvedValue({
      ...mocks.defaults,
      sources: { ...mocks.defaults.sources, starting_soon: false, overlays: true },
    });
    mocks.read.mockImplementation((query: Query) =>
      query.table === FEED
        ? feed({
            overlays: [
              {
                id: 'overlay',
                name: 'Confirmed Overlay',
                status: 'RUNNING',
                start_time: new Date(Date.now() - 60_000).toISOString(),
                guaranteed_prize: 1000,
                prize_pool: 200,
                current_players: 2,
                buy_in_amount: 100,
                late_reg_levels: 4,
                current_level: 3,
                max_players: 100,
              },
            ],
          })
        : answer(query)
    );
    await mount();
    expect(screen.getByText('Confirmed Overlay')).toBeTruthy();
    mocks.read.mockResolvedValue(failed);
    await tick();
    expect(screen.getByText('Confirmed Overlay')).toBeTruthy();
    await tick(31_000);
    expect(screen.queryByText('Confirmed Overlay')).toBeNull();
  });
  it.each(['winner_results', 'table_openings'] as const)(
    'retains confirmed %s after returned query errors and clears on recovery',
    async (source) => {
      mocks.settings.mockResolvedValue({
        ...mocks.defaults,
        sources: { ...mocks.defaults.sources, starting_soon: false, [source]: true },
      });
      /* Both sources arrive down the SAME call now, in their own arrays, each
         with its own row budget - which is the whole point of the change: they
         used to share one eighty-row sweep ordered by `updated_at`. */
      const row = {
        id: 'operational-event',
        name: 'Confirmed Notice',
        status: 'COMPLETED',
        start_time: new Date(Date.now() - 60_000).toISOString(),
        ended_at: new Date(Date.now() - 1000).toISOString(),
        created_at: new Date(Date.now() - 1000).toISOString(),
        prize_pool: 1000,
        game_variant: 'NLH',
      };
      const arrays = source === 'winner_results' ? { results: [row] } : { table_openings: [row] };
      mocks.read.mockImplementation((query: Query) =>
        query.table === FEED ? feed(arrays) : answer(query)
      );
      await mount();
      expect(screen.getByText('Confirmed Notice')).toBeTruthy();
      mocks.read.mockImplementation((query: Query) =>
        query.table === FEED ? failed : answer(query)
      );
      await tick();
      expect(screen.getByText('Confirmed Notice')).toBeTruthy();
      expect(mocks.report).toHaveBeenCalled();
      mocks.read.mockImplementation((query: Query) =>
        query.table === FEED ? feed() : answer(query)
      );
      await tick();
      expect(screen.queryByText('Confirmed Notice')).toBeNull();
    }
  );
});
