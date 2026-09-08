/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  A WRITE THE DATABASE COULD NOT TAKE IS NOT A WRITE THAT IS LOST
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * 2026-09-08. Written after an agent's own migration lost eighteen hands.
 *
 * THE FAILURE, MEASURED. Every DDL statement fires Supabase's `pgrst_ddl_watch`
 * event trigger, which makes PostgREST reload its whole schema cache; on this
 * database (~970 relations, ~2,700 functions) that reload takes about
 * TWENTY-EIGHT SECONDS, and CLAUDE.md section 2 has said so since the 2026-08-31
 * PGRST002 outage. During it, every PostgREST call answers 503 PGRST002 -
 * "Could not query the database for the schema cache" - BEFORE the statement
 * runs.
 *
 * Two callers retried that, and both ladders were built to survive exactly this
 * event:
 *
 *   syncStacks           5 attempts, 200ms doubling  -> ~11.5s wall clock
 *   queueUnbankedFee     4 attempts, 300ms tripling  -> ~10.7s wall clock
 *
 * Each is less than HALF the reload it was written for, and the fee ladder's own
 * comment states the intent ("buys the reload time to finish") beside a number
 * that never could. On 2026-09-08 at 02:17 and 03:08, two migrations three
 * minutes apart exhausted both: eighteen hands' stack writes were dropped with
 * 155,335 chips of movement in them, and twenty-three rake alarms fired.
 *
 * THE INLINE LADDER CANNOT SIMPLY BE LENGTHENED. `syncStacks` is awaited by the
 * dealing loop before the next hand (ServerTableEngineDealing waits on
 * `postHandTasksPromise`), under a 20-second `DEAL_STEP_BUDGET_MS`. A budget
 * long enough to span a schema reload would park the table for the length of the
 * reload - trading lost chips for frozen felt, which is not a trade.
 *
 * SO THE PATIENCE MOVES OFF THE DEALING PATH. When a ladder is exhausted, the
 * caller hands the write here instead of declaring the chips unrecoverable. This
 * module retries it on its own timer, with a budget derived from the reload it
 * has to outlast, and alarms ONLY if that budget is exhausted too. The dealing
 * loop never waits on any of it.
 *
 * WHY THIS IS SAFE TO REPLAY. Every write registered here must be idempotent by
 * construction, and both callers are: `fn_ca_settle_hand_stacks_absolute` claims
 * `settlement_idempotency_keys` on (table, hand) and replays its stored result,
 * and the fee queue's partial unique index on (hand_id, kind) makes a duplicate
 * insert a no-op. A retry that arrives after the first attempt secretly
 * committed writes nothing. That property is what licenses the long budget -
 * do not register a write here that lacks it.
 *
 * WHY IT IS NOT A CRON. Dan, binding: monitors and sweeps are band-aids; fixes
 * belong in the code. This is not a sweep looking for damage after the fact - it
 * is the original write, still being attempted by the process that holds it,
 * with the payload it already has in hand.
 */

import { reportError } from '../errorReporter.js';

/**
 * How long a PostgREST schema-cache reload takes on THIS database, measured.
 *
 * CLAUDE.md section 2, from the 2026-08-31 PGRST002 outage: ~970 relations,
 * ~2,700 functions, one reload ~28 seconds. This is the number every budget
 * below is derived from. If the database grows, the reload grows with it - so
 * derive from this constant, never re-type a literal somewhere else.
 */
export const SCHEMA_RELOAD_MEASURED_MS = 28_000;

/**
 * Six reloads' worth of patience.
 *
 * One migration is one reload. But CLAUDE.md section 2 warns that ten DDL
 * statements outside a transaction cost up to ten consecutive reloads, and the
 * 2026-09-08 incident was two migrations three minutes apart. A budget of one
 * reload plus a margin would have covered that day and not the next one.
 *
 * Off the dealing path this patience is free: the cost of waiting is a few
 * kilobytes held in a map, and the cost of giving up early is chips.
 */
export const PENDING_WRITE_BUDGET_MS = SCHEMA_RELOAD_MEASURED_MS * 6;

/** Retry spacing: quick at first, then capped so the budget buys many attempts. */
export const PENDING_WRITE_MIN_DELAY_MS = 1_000;
export const PENDING_WRITE_MAX_DELAY_MS = 5_000;

/**
 * Bounded, because an unbounded queue in a process that deals 500 hands a minute
 * is a memory leak waiting for its outage. At the cap the OLDEST entry is given
 * up (and alarmed) to make room: it is the one whose budget is closest to spent
 * and whose payload is most stale.
 */
export const MAX_PENDING_WRITES = 500;

export type PendingWriteOutcome = { done: true } | { done: false; error: string };

export interface PendingWrite {
  /**
   * Identifies the logical target, not the attempt. A second enqueue for the
   * same key is dropped: the queued one is already trying to write it.
   * Convention: `<kind>:<tableId>:<discriminator>`, so a table's pending writes
   * can be drained by prefix.
   */
  key: string;
  /** What this write is, in words, for the alarm if it never lands. */
  describedAs: string;
  /** One attempt. Must be idempotent - see the header. */
  attempt: () => Promise<PendingWriteOutcome>;
  /** Called once, when the budget is spent and the write has still not landed. */
  onGiveUp: (lastError: string, elapsedMs: number, attempts: number) => Promise<void>;
}

interface Entry extends PendingWrite {
  enqueuedAt: number;
  nextAttemptAt: number;
  attempts: number;
  lastError: string;
  inFlight: boolean;
}

const pending = new Map<string, Entry>();
let timer: ReturnType<typeof setInterval> | null = null;

/** Drain tick. Short enough that MIN_DELAY is honoured, cheap enough to ignore. */
const TICK_MS = 500;

function now(): number {
  return Date.now();
}

function backoffFor(attempts: number): number {
  const grown = PENDING_WRITE_MIN_DELAY_MS * 2 ** Math.max(0, attempts - 1);
  return Math.min(PENDING_WRITE_MAX_DELAY_MS, grown);
}

async function giveUp(entry: Entry): Promise<void> {
  pending.delete(entry.key);
  try {
    await entry.onGiveUp(entry.lastError, now() - entry.enqueuedAt, entry.attempts);
  } catch (err) {
    reportError(err, 'PendingWrites.give_up_handler_failed');
  }
}

async function runOne(entry: Entry): Promise<void> {
  entry.inFlight = true;
  try {
    const outcome = await entry.attempt();
    entry.attempts += 1;
    if (outcome.done) {
      pending.delete(entry.key);
      console.log(
        `[pending-writes] ${entry.describedAs} landed after ${entry.attempts} off-path attempt(s), ` +
          `${Math.round((now() - entry.enqueuedAt) / 1000)}s after the dealing path gave up`
      );
      return;
    }
    entry.lastError = outcome.error;
  } catch (err) {
    entry.attempts += 1;
    entry.lastError = err instanceof Error ? err.message : String(err);
  } finally {
    entry.inFlight = false;
  }

  if (now() - entry.enqueuedAt >= PENDING_WRITE_BUDGET_MS) {
    await giveUp(entry);
    return;
  }
  entry.nextAttemptAt = now() + backoffFor(entry.attempts);
}

function ensureTimer(): void {
  if (timer || pending.size === 0) return;
  timer = setInterval(() => {
    void drainDue();
  }, TICK_MS);
  // Never hold the process open for a retry queue.
  (timer as { unref?: () => void }).unref?.();
}

async function drainDue(): Promise<void> {
  if (pending.size === 0) {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    return;
  }
  const due = [...pending.values()].filter((e) => !e.inFlight && e.nextAttemptAt <= now());
  await Promise.all(due.map((e) => runOne(e)));
}

/**
 * Hand a write that the dealing path could not land to the off-path retry.
 *
 * Returns false when the same key is already queued (nothing to do) - the caller
 * should not alarm in that case either.
 */
export function enqueuePendingWrite(write: PendingWrite): boolean {
  if (pending.has(write.key)) return false;

  if (pending.size >= MAX_PENDING_WRITES) {
    const oldest = [...pending.values()].sort((a, b) => a.enqueuedAt - b.enqueuedAt)[0];
    if (oldest) {
      reportError(
        new Error(
          `[pending-writes] queue full at ${MAX_PENDING_WRITES}; giving up on the oldest entry ` +
            `(${oldest.describedAs}) to make room for ${write.describedAs}`
        ),
        'PendingWrites.queue_full'
      );
      void giveUp(oldest);
    }
  }

  pending.set(write.key, {
    ...write,
    enqueuedAt: now(),
    nextAttemptAt: now() + PENDING_WRITE_MIN_DELAY_MS,
    attempts: 0,
    lastError: '',
    inFlight: false,
  });
  ensureTimer();
  return true;
}

/**
 * Try every pending write whose key starts with `prefix`, right now, regardless
 * of its backoff.
 *
 * The natural moment to retry a table's lost hand is the next time that table
 * writes: the database has just proved it is reachable. Awaited by the caller,
 * so it runs before the new write and the deltas land in the order they happened
 * - which is cosmetic, since the RPC applies differences and they commute, but
 * it keeps the register readable.
 */
export async function drainPendingWrites(prefix: string): Promise<void> {
  const due = [...pending.values()].filter((e) => !e.inFlight && e.key.startsWith(prefix));
  await Promise.all(due.map((e) => runOne(e)));
}

/** How many writes are still owed. Exposed for /health and for tests. */
export function pendingWriteCount(): number {
  return pending.size;
}

/** Test seam only. */
export function resetPendingWrites(): void {
  pending.clear();
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
