/**
 * TABLE WARM-UP - visible lobby tables start loading before the card opens;
 * intent also prepares a chosen table before the page mounts.
 *
 * Dan, 2026-09-03: "every single table when you join now says 'connecting to
 * the table' and then shows generic block letters ... tables must load and be
 * running with avatars already on and the players playing as soon as a user
 * clicks View Table or Join Table. The table should already be loading in
 * the background as soon as it's clicked."
 *
 * Measured in his browser against production before this file existed: the
 * lobby card opened, View Table was tapped, TablePage mounted, and ONLY THEN
 * did the seat read and the engine SUBSCRIBE go out - so the first second of
 * every table was an empty felt with a "Connecting To The Table" banner, and
 * the roster and avatars arrived seconds later (the seat read was also 403ing;
 * see TableService.getSeatedPlayers for that half of the story).
 *
 * This module does the two loads that decide what the first frame shows, from
 * the LOBBY, the moment a game card is opened:
 *
 *   1. THE ROSTER. tableService.getSeatedPlayers - seats plus names plus
 *      avatars - into a short-lived cache that TablePage reads SYNCHRONOUSLY
 *      in its initial state, so the felt's first paint already has every
 *      player on it. The in-flight promise is shared with TablePage's own
 *      prefetch so a click during the read does not fire a second one.
 *
 *   2. THE ENGINE SUBSCRIPTION. A placeholder facade is acquired on the shared
 *      /ws/multi socket, which sends SUBSCRIBE now and makes the engine run
 *      its join gates while the player is still reading the card. When
 *      TablePage's EngineStateClient acquires the same table it supersedes the
 *      placeholder (EngineSocketMux.acquire, CLOSE_MUX_SUPERSEDED - no
 *      UNSUBSCRIBE is sent), and the server answers its SUBSCRIBE from the
 *      subscription that already exists. Buffered public state seeds entry,
 *      followed by an authoritative SUBSCRIBED plus a resync
 *      SNAPSHOT, no gates. That is the difference between the felt animating on
 *      mount and "Connecting To The Table".
 *
 * WHAT IT MUST NEVER DO: supersede a LIVE table. A player sitting at a table
 * in the multi-table view who opens that same game's card in the lobby must
 * not have their real socket told to stand down by a placeholder. The mux is
 * asked whether it already holds that table (isSubscribed) and the warm-up
 * skips the socket half when it does; the roster half is harmless either way.
 *
 * A warm-up nobody claims is released after WARM_TTL_MS: the placeholder
 * facade is closed (which sends UNSUBSCRIBE) and the cached roster dropped.
 * Cached rows are only handed out while younger than SEATS_FRESH_MS, so a
 * stale roster is never painted over a live table; TablePage's own read and
 * the engine snapshot remain the authorities that follow.
 */
import { getFreshAccessToken } from '../lib/authToken';
import { engineSocketMux, isMuxEnabled, type MuxTableSocket } from './EngineSocketMux';
import { tableService } from './TableService';
import { preloadRoute } from '../utils/ChunkPreloader';

/** How long an unclaimed warm-up is kept alive (socket + roster). */
export const WARM_TTL_MS = 25_000;
/** A cached roster older than this is not painted; the live read replaces it. */
export const SEATS_FRESH_MS = 15_000;

/** One row of tableService.getSeatedPlayers - what TablePage's prefetch paints from. */
export type WarmSeat = Awaited<ReturnType<typeof tableService.getSeatedPlayers>>[number];

interface WarmEntry {
  startedAt: number;
  seats: WarmSeat[] | null;
  seatsAt: number;
  promise: Promise<WarmSeat[]>;
  /** The roster read rejected; TablePage's prefetch makes its own. */
  seatsFailed: boolean;
  facade: MuxTableSocket | null;
  socketPending: boolean;
  ttl: ReturnType<typeof setTimeout> | null;
}

const entries = new Map<string, WarmEntry>();

/** A speculative read must never strand the real table's shared prefetch. */
function withWarmDeadline<T>(request: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return new Promise<T>((resolve, reject) => {
    timer = setTimeout(() => reject(new Error('Table preparation timed out')), timeoutMs);
    // Observe both eventual outcomes without cancelling the shared auth SDK.
    request.then(resolve, reject);
  }).finally(() => clearTimeout(timer));
}

/** Engine URL resolution shared with useEngineTableState (same env contract). */
function engineBaseUrl(): string {
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
  return (
    env?.VITE_GAME_SERVER_URL ||
    (env?.PROD ? 'https://engine.smarter.poker' : 'http://localhost:8080')
  );
}

function dropEntry(tableId: string, entry: WarmEntry, closeFacade: boolean): void {
  if (entries.get(tableId) !== entry) return;
  entries.delete(tableId);
  if (entry.ttl !== null) clearTimeout(entry.ttl);
  if (closeFacade && entry.facade && entry.facade.readyState !== 3) {
    // release() -> UNSUBSCRIBE. A superseded facade is already CLOSED (3) and
    // must not release: the table now belongs to the real client.
    entry.facade.close(1000, 'table warm-up expired unclaimed');
  }
  entry.facade = null;
}

async function warmSocket(tableId: string, entry: WarmEntry): Promise<void> {
  if (!isMuxEnabled() || entry.socketPending) return;
  if (entry.facade && entry.facade.readyState !== 3) return;
  if (engineSocketMux.isSubscribed(tableId)) return; // a live table owns it
  entry.socketPending = true;
  try {
    const token = await withWarmDeadline(getFreshAccessToken(), 15_000);
    if (!token) return;
    // The entry may have expired or been claimed while the token resolved.
    if (entries.get(tableId) !== entry) return;
    if (engineSocketMux.isSubscribed(tableId)) return;
    const facade = engineSocketMux.acquireWarm(engineBaseUrl(), tableId, token);
    if (!facade) return;
    entry.facade = facade;
    // Retain bounded public state. Historical/private events are not replayed.
    facade.onmessage = null;
    facade.onclose = () => {
      if (entry.facade === facade) entry.facade = null;
    };
  } catch {
    // Preparation is best-effort; a later intent may retry the connection.
  } finally {
    entry.socketPending = false;
  }
}

/**
 * Start loading a table in the background. Idempotent while fresh: a table
 * already warming (or already live) is left alone; a stale one restarts.
 */
export function warmTable(tableId: string | null | undefined): void {
  if (!tableId) return;
  preloadRoute(`/table/${tableId}`);
  const existing = entries.get(tableId);
  if (existing && Date.now() - existing.startedAt < SEATS_FRESH_MS) {
    // Fresh seats do not imply a live stream: actual entry may have reclaimed
    // this speculative slot, or all slots may have been occupied earlier.
    void warmSocket(tableId, existing);
    return;
  }
  // Refresh roster data without tearing down a healthy speculative stream.
  // Otherwise every refresh pays another SUBSCRIBE just as the user enters.
  const entry: WarmEntry = existing ?? {
    startedAt: Date.now(),
    seats: null,
    seatsAt: 0,
    promise: Promise.resolve([]),
    seatsFailed: false,
    facade: null,
    socketPending: false,
    ttl: null,
  };
  if (entry.ttl !== null) clearTimeout(entry.ttl);
  entry.startedAt = Date.now();
  entry.seatsFailed = false;
  entry.ttl = setTimeout(() => dropEntry(tableId, entry, true), WARM_TTL_MS);
  const request = withWarmDeadline(tableService.getSeatedPlayers(tableId), 5_000)
    .then((seats) => {
      if (entries.get(tableId) === entry && entry.promise === request) {
        entry.seats = seats;
        entry.seatsAt = Date.now();
      }
      return seats;
    })
    .catch((err) => {
      // The warm-up is best-effort; TablePage's own prefetch reports a failure
      // it cannot recover from. Mark the read failed so that prefetch makes its
      // own instead of inheriting a rejected one. The entry stays: its TTL
      // still owns the placeholder socket.
      if (entry.promise === request) entry.seatsFailed = true;
      throw err;
    });
  entry.promise = request;
  // Nobody may ever await this promise (the card closes, the player leaves); a
  // rejection must not surface as an unhandled one.
  entry.promise.catch(() => undefined);
  entries.set(tableId, entry);
  void warmSocket(tableId, entry);
}

/**
 * Rows for a table warmed recently - synchronous, for an initial-state seed.
 * Returns null when nothing fresh is held; never throws.
 */
export function peekWarmSeats(tableId: string | null | undefined): WarmSeat[] | null {
  if (!tableId) return null;
  const entry = entries.get(tableId);
  if (!entry || !entry.seats) return null;
  if (Date.now() - entry.seatsAt > SEATS_FRESH_MS) return null;
  return entry.seats;
}

/**
 * The in-flight (or settled) roster read for a warmed table, so TablePage's
 * prefetch can await the read already in progress instead of starting another.
 * Null when the table was not warmed, the read failed, or the warm-up is stale.
 */
export function warmSeatsPromise(tableId: string | null | undefined): Promise<WarmSeat[]> | null {
  if (!tableId) return null;
  const entry = entries.get(tableId);
  if (!entry || entry.seatsFailed) return null;
  if (Date.now() - entry.startedAt > SEATS_FRESH_MS) return null;
  return entry.promise;
}

/** Test hook: forget every warm-up without touching sockets. */
export function __resetTableWarmupForTests(): void {
  for (const [id, entry] of entries) dropEntry(id, entry, false);
  entries.clear();
}

/** Prepare the shared transport and visible table IDs as a lobby renders. */
export function observeLobbyTableWarmups(roots: HTMLElement[]): () => void {
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const visible = new Set<Element>();
  const recent = new Map<string, number>();
  preloadRoute('/table/lobby-preview');
  void withWarmDeadline(getFreshAccessToken(), 15_000)
    .then((token) => {
      if (!disposed && token && isMuxEnabled()) engineSocketMux.prewarm(engineBaseUrl(), token);
    })
    .catch(() => undefined);

  function warmVisible() {
    if (disposed || document.visibilityState === 'hidden') return;
    const ids = [
      ...new Set([...visible].map((node) => node.getAttribute('data-warm-table')).filter(Boolean)),
    ] as string[];
    // The server allows four table subscriptions. Warm a small visible set;
    // acquireWarm uses spare slots and every actual table has priority.
    for (const id of ids.slice(0, 3)) {
      if (Date.now() - (recent.get(id) ?? -Infinity) < SEATS_FRESH_MS) continue;
      recent.set(id, Date.now());
      warmTable(id);
    }
  }
  const observer =
    typeof IntersectionObserver === 'undefined'
      ? null
      : new IntersectionObserver((changes) => {
          for (const change of changes) {
            if (change.isIntersecting) visible.add(change.target);
            else visible.delete(change.target);
          }
          if (timer === null)
            timer = setTimeout(() => {
              timer = null;
              warmVisible();
            }, 100);
        });
  for (const root of roots) {
    for (const node of root.querySelectorAll('[data-warm-table]')) observer?.observe(node);
  }
  // Safari can resume without another intersection or online event. The
  // visible rows are still known, but their speculative sockets may have
  // expired while hidden. Retry immediately, including slots previously
  // unavailable; warmTable itself preserves fresh rows and healthy owners.
  const resume = () => {
    if (disposed || document.visibilityState === 'hidden') return;
    recent.clear();
    warmVisible();
  };
  document.addEventListener('visibilitychange', resume);
  window.addEventListener('pageshow', resume);
  window.addEventListener('online', resume);
  const refresh = setInterval(warmVisible, SEATS_FRESH_MS);
  return () => {
    disposed = true;
    observer?.disconnect();
    document.removeEventListener('visibilitychange', resume);
    window.removeEventListener('pageshow', resume);
    window.removeEventListener('online', resume);
    if (timer !== null) clearTimeout(timer);
    clearInterval(refresh);
  };
}
