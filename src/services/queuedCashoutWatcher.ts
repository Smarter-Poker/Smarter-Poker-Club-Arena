import { supabase } from '../lib/supabase';
import { masterBus } from '../core/MasterBus';
import { reportError } from '../utils/errorReporter';

/**
 * A LEAVE THAT WAITS FOR THE HAND IS FOLLOWED TO THE WALLET (Dan 2026-10-25:
 * "WHEN A PLAYER LEAVES THE TABLE WITH CHIPS, THOSE CHIPS SHOULD BE IN THERE
 * WALLET, AS SOON AS THE HAND THEY WERE DEALT IN FINISHES").
 *
 * A player who leaves while dealt into a live hand gets a queued answer from
 * the engine: the seat is cashed out by the engine's own settlement once that
 * hand is over (measured on production: a median of under 3 seconds after the
 * hand ends). Nothing on the client used to notice that moment. The leave
 * skipped the balance refresh because nothing had been credited yet, every
 * "already seated" list was re-read once, at the leave, while the seat was
 * still open, and the wallet only caught up when something unrelated happened
 * to refresh it. That gap was the couple of minutes players saw.
 *
 * This follows each queued leave by its own seat occupancy until the seat has
 * really left (the database exits the seat and credits the wallet in one
 * transaction, so `left_at` being set IS the money having landed), then tells
 * every balance and seat reader at once. It carries no money and decides
 * nothing: it only reads the player's own seat row.
 *
 * Buy-in doors call `awaitQueuedCashouts()` first, so a player who taps into a
 * new game in the seconds the old hand is finishing is admitted with the
 * returned chips instead of being told they are still seated or short.
 */

const FAST_POLL_MS = 1_000;
const FAST_WINDOW_MS = 90_000;
const SLOW_POLL_MS = 3_000;
/** Longer than the stay clock (10 minutes) so a held leave is still followed home. */
const GIVE_UP_MS = 12 * 60_000;
/** The longest a buy-in waits for a finishing hand before asking the server anyway. */
export const BUY_IN_WAIT_MS = 15_000;

type Watch = {
  tableId: string;
  userId: string;
  occupancyId: string;
  startedAt: number;
  done: Promise<boolean>;
  resolve: (landed: boolean) => void;
  timer: ReturnType<typeof setTimeout> | null;
};

const watches = new Map<string, Watch>();

/* A FULL PAGE LOAD DOES NOT LOSE THE LEAVE (2026-10-25). Leaving a table for
   a World Hub page, a refresh, or the app being reopened restarts this module.
   The watches are kept in the browser so the returning app resumes following
   a leave whose hand is still finishing, instead of reading the seat once as
   still open and never again. Storage can be absent or throw; following the
   leave in memory still works without it. */
const STORAGE_KEY = 'ca.queuedCashouts.v1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Saved = { tableId: string; userId: string; occupancyId: string; startedAt: number };

/** Accounts whose saved leaves this page load has taken over. */
const ownedUsers = new Set<string>();

function persist(): void {
  try {
    const now = Date.now();
    // Another account's leaves in this browser are kept untouched.
    const others = readSaved().filter(
      (v) => !ownedUsers.has(v.userId) && now - v.startedAt < GIVE_UP_MS
    );
    const saved: Saved[] = [
      ...others,
      ...[...watches.values()].map(({ tableId, userId, occupancyId, startedAt }) => ({
        tableId,
        userId,
        occupancyId,
        startedAt,
      })),
    ];
    if (saved.length === 0) globalThis.localStorage?.removeItem(STORAGE_KEY);
    else globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(saved));
  } catch {
    /* Following in memory is unaffected. */
  }
}

function readSaved(): Saved[] {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (v): v is Saved =>
        !!v &&
        typeof v === 'object' &&
        typeof v.tableId === 'string' &&
        typeof v.userId === 'string' &&
        UUID.test(v.userId) &&
        typeof v.occupancyId === 'string' &&
        UUID.test(v.occupancyId) &&
        typeof v.startedAt === 'number' &&
        Number.isFinite(v.startedAt)
    );
  } catch {
    return [];
  }
}

export type SeatExitReader = (
  occupancyId: string,
  userId: string
) => Promise<{ left: boolean } | null>;

const readSeatExit: SeatExitReader = async (occupancyId, userId) => {
  const { data, error } = await supabase
    .from('table_seats')
    .select('left_at')
    .eq('occupancy_id', occupancyId)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) return null;
  // No row for the player's own occupancy means it is no longer an open seat.
  if (!data) return { left: true };
  return { left: data.left_at !== null };
};

let reader: SeatExitReader = readSeatExit;

/** Tests only. */
export function __setSeatExitReaderForTests(next: SeatExitReader | null): void {
  reader = next ?? readSeatExit;
}

/** Tests only. */
export function __resetQueuedCashoutsForTests(): void {
  for (const w of watches.values()) {
    if (w.timer) clearTimeout(w.timer);
    w.resolve(false);
  }
  watches.clear();
  ownedUsers.clear();
  try {
    globalThis.localStorage?.removeItem(STORAGE_KEY);
  } catch {
    /* none */
  }
}

function finish(watch: Watch, landed: boolean): void {
  if (watch.timer) clearTimeout(watch.timer);
  watch.timer = null;
  watches.delete(watch.occupancyId);
  persist();
  watch.resolve(landed);
  if (!landed) return;
  masterBus.emit('BALANCE_UPDATED', {
    source: 'queued_leave_cashout',
    userId: watch.userId,
    tableId: watch.tableId,
  });
  masterBus.emit('SEAT_CASHED_OUT', {
    tableId: watch.tableId,
    occupancyId: watch.occupancyId,
  });
}

function schedule(watch: Watch): void {
  const elapsed = Date.now() - watch.startedAt;
  if (elapsed >= GIVE_UP_MS) {
    finish(watch, false);
    return;
  }
  const delay = elapsed < FAST_WINDOW_MS ? FAST_POLL_MS : SLOW_POLL_MS;
  watch.timer = setTimeout(() => void check(watch), delay);
}

async function check(watch: Watch): Promise<void> {
  watch.timer = null;
  if (watches.get(watch.occupancyId) !== watch) return;
  let answer: { left: boolean } | null = null;
  try {
    answer = await reader(watch.occupancyId, watch.userId);
  } catch (error) {
    reportError(error, 'queuedCashoutWatcher.read_failed');
  }
  if (watches.get(watch.occupancyId) !== watch) return;
  if (answer?.left) {
    finish(watch, true);
    return;
  }
  schedule(watch);
}

function start(tableId: string, userId: string, occupancyId: string, startedAt: number): void {
  let resolve!: (landed: boolean) => void;
  const done = new Promise<boolean>((r) => {
    resolve = r;
  });
  const watch: Watch = { tableId, userId, occupancyId, startedAt, done, resolve, timer: null };
  ownedUsers.add(userId);
  watches.set(occupancyId, watch);
  persist();
  schedule(watch);
}

/** Follow a queued (end-of-hand) leave until its cash-out lands. Idempotent per occupancy. */
export function watchQueuedCashout(tableId: string, userId: string, occupancyId: string): void {
  if (!tableId || !userId || !occupancyId || watches.has(occupancyId)) return;
  start(tableId, userId, occupancyId, Date.now());
}

/**
 * Resume this account's leaves saved by an earlier page load. Each keeps its
 * original start, so the 12-minute bound still counts from the leave itself.
 * The first check runs at once: the hand has usually finished by now.
 */
export function resumeQueuedCashouts(userId: string): void {
  if (!userId) return;
  const now = Date.now();
  const saved0 = readSaved();
  ownedUsers.add(userId);
  for (const saved of saved0) {
    if (saved.userId !== userId || watches.has(saved.occupancyId)) continue;
    if (saved.startedAt > now || now - saved.startedAt >= GIVE_UP_MS) continue;
    start(saved.tableId, saved.userId, saved.occupancyId, saved.startedAt);
    const w = watches.get(saved.occupancyId);
    if (w?.timer) {
      clearTimeout(w.timer);
      void check(w);
    }
  }
  // Drop anything expired or malformed so the saved list cannot grow.
  persist();
}

/** True while any queued leave of this player has not yet reached the wallet. */
export function hasQueuedCashout(userId?: string): boolean {
  for (const w of watches.values()) if (!userId || w.userId === userId) return true;
  return false;
}

/**
 * Resolves as soon as every queued leave being followed has landed, or after
 * `maxWaitMs`, whichever is first. Resolves at once when nothing is queued, so
 * a buy-in with no leave behind it pays nothing for this.
 */
export async function awaitQueuedCashouts(maxWaitMs: number = BUY_IN_WAIT_MS): Promise<void> {
  if (watches.size === 0) return;
  const pending = [...watches.values()].map((w) => {
    // Check now rather than at the next tick: the hand may already be over.
    if (w.timer) {
      clearTimeout(w.timer);
      void check(w);
    }
    return w.done;
  });
  let timer: ReturnType<typeof setTimeout> | null = null;
  await Promise.race([
    Promise.all(pending),
    new Promise<void>((r) => {
      timer = setTimeout(r, maxWaitMs);
    }),
  ]);
  if (timer) clearTimeout(timer);
}
