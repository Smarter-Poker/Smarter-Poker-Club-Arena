/**
 * TABLE WARM-UP — the lobby starts loading the table before the page mounts.
 *
 * Dan 2026-09-03: "the table should already be loading in the background as
 * soon as it's clicked." These tests drive services/tableWarmup against a
 * mocked mux, token and roster read, and assert the two things that decide
 * the first frame: the roster is fetched and cached for a synchronous seed,
 * and a placeholder engine subscription is opened - UNLESS the table is
 * already live, which must never be superseded by a lobby warm-up.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const acquire = vi.fn();
const prewarm = vi.fn();
const isSubscribed = vi.fn(() => false);
const getSeatedPlayers = vi.fn();

vi.mock('../src/utils/ChunkPreloader', () => ({ preloadRoute: vi.fn() }));

vi.mock('../src/services/EngineSocketMux', () => ({
  engineSocketMux: {
    prewarm: (...a: unknown[]) => prewarm(...a),
    acquireWarm: (...a: unknown[]) => acquire(...a),
    isSubscribed: (id: string) => isSubscribed(id),
  },
  isMuxEnabled: () => true,
}));
vi.mock('../src/lib/authToken', () => ({
  getFreshAccessToken: vi.fn(async () => 'jwt-token'),
}));
vi.mock('../src/services/TableService', () => ({
  tableService: { getSeatedPlayers: (id: string) => getSeatedPlayers(id) },
}));

const T = 'aaaaaaaa-1111-4111-8111-111111111111';

function fakeFacade() {
  return {
    retainWarmState: vi.fn(),
    readyState: 0,
    onmessage: null as unknown,
    onclose: null as unknown,
    close: vi.fn(),
  };
}

let warm: typeof import('../src/services/tableWarmup');

beforeEach(async () => {
  vi.useFakeTimers();
  vi.resetModules();
  acquire.mockReset().mockImplementation(() => fakeFacade());
  isSubscribed.mockReset().mockReturnValue(false);
  getSeatedPlayers.mockReset();
  warm = await import('../src/services/tableWarmup');
});
afterEach(() => {
  warm.__resetTableWarmupForTests();
  vi.useRealTimers();
});

const ROWS = [
  { user_id: 'u1', seat_number: 1, stack: 100, horse_id: null, profiles: { username: 'Ann' } },
  { user_id: 'u2', seat_number: 2, stack: 200, horse_id: 'h9', profiles: { username: 'bot' } },
];

describe('tableWarmup', () => {
  it('caches the roster for a synchronous seed once the read resolves', async () => {
    getSeatedPlayers.mockResolvedValue(ROWS);
    expect(warm.peekWarmSeats(T)).toBeNull(); // nothing yet
    warm.warmTable(T);
    expect(getSeatedPlayers).toHaveBeenCalledWith(T);
    await vi.waitFor(() => expect(warm.peekWarmSeats(T)).not.toBeNull());
    expect(warm.peekWarmSeats(T)).toHaveLength(2);
  });

  it('opens a placeholder engine subscription for a table that is NOT live', async () => {
    getSeatedPlayers.mockResolvedValue([]);
    warm.warmTable(T);
    await vi.waitFor(() => expect(acquire).toHaveBeenCalledTimes(1));
    expect(acquire.mock.calls[0][1]).toBe(T);
  });

  it('NEVER supersedes a live table: no acquire when the mux already holds it', async () => {
    isSubscribed.mockReturnValue(true);
    getSeatedPlayers.mockResolvedValue(ROWS);
    warm.warmTable(T);
    await vi.waitFor(() => expect(warm.peekWarmSeats(T)).not.toBeNull());
    expect(acquire).not.toHaveBeenCalled(); // the live socket owns the table
  });

  it('shares its in-flight read with warmSeatsPromise instead of a second query', async () => {
    let resolve!: (r: unknown[]) => void;
    getSeatedPlayers.mockReturnValue(new Promise((r) => (resolve = r)));
    warm.warmTable(T);
    const shared = warm.warmSeatsPromise(T);
    expect(shared).not.toBeNull();
    resolve(ROWS);
    await expect(shared).resolves.toHaveLength(2);
    expect(getSeatedPlayers).toHaveBeenCalledTimes(1);
  });

  it('a failed roster read does not hand a rejected promise to the prefetch', async () => {
    getSeatedPlayers.mockRejectedValue(new Error('403'));
    warm.warmTable(T);
    await vi.waitFor(() => expect(warm.warmSeatsPromise(T)).toBeNull());
    expect(warm.peekWarmSeats(T)).toBeNull();
  });

  it('a stale cached roster is not painted', async () => {
    getSeatedPlayers.mockResolvedValue(ROWS);
    warm.warmTable(T);
    await vi.waitFor(() => expect(warm.peekWarmSeats(T)).not.toBeNull());
    vi.advanceTimersByTime(warm.SEATS_FRESH_MS + 1);
    expect(warm.peekWarmSeats(T)).toBeNull();
  });

  it('a warm-up nobody claims closes its placeholder after the TTL', async () => {
    const facade = fakeFacade();
    facade.readyState = 1; // OPEN, unclaimed
    acquire.mockReturnValue(facade);
    getSeatedPlayers.mockResolvedValue([]);
    warm.warmTable(T);
    await vi.waitFor(() => expect(acquire).toHaveBeenCalled());
    vi.advanceTimersByTime(warm.WARM_TTL_MS + 1);
    expect(facade.close).toHaveBeenCalled(); // UNSUBSCRIBE sent
  });
});

describe('visible lobby table preparation', () => {
  it('warms before a click, limits speculation, and cancels work on unmount', async () => {
    let intersect!: (entries: Array<{ target: Element; isIntersecting: boolean }>) => void;
    const disconnect = vi.fn();
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(callback: typeof intersect) {
          intersect = callback;
        }
        observe = vi.fn();
        disconnect = disconnect;
      }
    );
    getSeatedPlayers.mockResolvedValue([]);
    const root = document.createElement('div');
    for (let i = 0; i < 6; i++) {
      const row = document.createElement('div');
      row.setAttribute('data-warm-table', `table-${i}`);
      root.append(row);
    }
    const cleanup = warm.observeLobbyTableWarmups([root]);
    intersect([...root.children].map((target) => ({ target, isIntersecting: true })));
    await vi.advanceTimersByTimeAsync(150);
    expect(prewarm).toHaveBeenCalled();
    expect(getSeatedPlayers).toHaveBeenCalledTimes(3);
    expect(getSeatedPlayers.mock.calls.map(([id]) => id)).toEqual([
      'table-0',
      'table-1',
      'table-2',
    ]);
    cleanup();
    expect(disconnect).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(getSeatedPlayers).toHaveBeenCalledTimes(3);
    vi.unstubAllGlobals();
  });
});

it('refreshes seats without discarding a healthy warmed table subscription', async () => {
  const facade = fakeFacade();
  facade.readyState = 1;
  acquire.mockReturnValue(facade);
  getSeatedPlayers.mockResolvedValue(ROWS);
  warm.warmTable(T);
  await vi.waitFor(() => expect(acquire).toHaveBeenCalledOnce());
  isSubscribed.mockReturnValue(true);
  await vi.advanceTimersByTimeAsync(warm.SEATS_FRESH_MS + 1);
  warm.warmTable(T);
  await vi.advanceTimersByTimeAsync(1);
  expect(getSeatedPlayers).toHaveBeenCalledTimes(2);
  expect(acquire).toHaveBeenCalledOnce();
  expect(facade.close).not.toHaveBeenCalled();
});

it('restarts an evicted warm connection immediately while reusing fresh seats', async () => {
  getSeatedPlayers.mockResolvedValue(ROWS);
  const first = fakeFacade();
  acquire.mockReturnValueOnce(first);
  warm.warmTable(T);
  await vi.advanceTimersByTimeAsync(1);
  expect(acquire).toHaveBeenCalledTimes(1);
  first.readyState = 3;
  (first.onclose as () => void)();
  warm.warmTable(T);
  await vi.advanceTimersByTimeAsync(1);
  expect(acquire).toHaveBeenCalledTimes(2);
  expect(getSeatedPlayers).toHaveBeenCalledTimes(1);
  expect(warm.peekWarmSeats(T)).toEqual(ROWS);
});

it('retries a previously full mux when slots become available without rereading seats', async () => {
  getSeatedPlayers.mockResolvedValue(ROWS);
  acquire.mockReturnValueOnce(null);
  warm.warmTable(T);
  await vi.advanceTimersByTimeAsync(1);
  warm.warmTable(T);
  await vi.advanceTimersByTimeAsync(1);
  expect(acquire).toHaveBeenCalledTimes(2);
  expect(getSeatedPlayers).toHaveBeenCalledTimes(1);
});

it('coalesces repeated intent while authentication is pending', async () => {
  const { getFreshAccessToken } = await import('../src/lib/authToken');
  let resolveToken!: (token: string) => void;
  vi.mocked(getFreshAccessToken).mockReturnValueOnce(
    new Promise((resolve) => {
      resolveToken = resolve;
    })
  );
  getSeatedPlayers.mockResolvedValue(ROWS);
  warm.warmTable(T);
  warm.warmTable(T);
  warm.warmTable(T);
  await vi.advanceTimersByTimeAsync(1);
  expect(acquire).not.toHaveBeenCalled();
  resolveToken('jwt-token');
  await vi.advanceTimersByTimeAsync(1);
  expect(acquire).toHaveBeenCalledTimes(1);
});
