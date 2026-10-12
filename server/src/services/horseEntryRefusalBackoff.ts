/**
 * A REFUSED HORSE ENTRY IS ASKED AGAIN ON A GROWING, JITTERED INTERVAL, AND A
 * DATABASE THAT DID NOT ANSWER ENDS THE PASS (2026-10-12).
 *
 * On 2026-10-11 from 17:50 to 18:53 UTC the database ran out of connections.
 * The ticket door (fn_ca_register_for_tournament_with_ticket_for) refused
 * every late ticket entry into a RUNNING event, with SQLSTATE 40001, which
 * PostgREST 14.5 re-runs inside the request without end. The horse
 * late-registration pass offered Sunday 200 Deep Stack to its satellite
 * ticket holders every five minutes. Each call it sent outlived its own
 * timeout as a request PostgREST kept re-running, each re-run took the
 * event's exclusive settlement lane, and every hand write on the event's
 * tables was refused and re-run in turn: 22,401 ticket refusals from ten
 * backends drove about 6,000 lane refusals a minute and 40 to 60 spinning
 * connections, until the :53 freeze made the door answer platform_frozen.
 *
 * The door is fixed (20261012031813) and both codes are no longer re-run by
 * the API (20261011185301). This is the caller's half, so the next refusal
 * nobody has found yet cannot do the same thing:
 *
 *   1. A horse whose entry into an event came back as an ERROR is not offered
 *      that event again on the next pass. It waits 10 minutes, doubling to an
 *      hour, each wait with equal jitter so horses refused together are not
 *      re-asked together. A database decision (ok:false with a reason) is an
 *      answer, not an error, and is not deferred. A successful entry clears
 *      the deferral.
 *   2. An error that says the database did not answer at all (a timeout, an
 *      exhausted pool, a dropped connection) stops the pass. Every further
 *      call would be one more request queued on a pool that is not serving;
 *      the next pass asks again.
 *
 * The database stays the only judge of an entry. This only decides when it is
 * worth asking again.
 */

export const HORSE_ENTRY_FIRST_RECHECK_MS = 10 * 60 * 1000;
export const HORSE_ENTRY_MAX_RECHECK_MS = 60 * 60 * 1000;
/** A deferral nobody has looked at for this long belongs to an event that is gone. */
const FORGET_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * Bounded exponential backoff with equal jitter: the wait for `attempt`
 * (1-based) lies in [ceiling/2, ceiling], ceiling = min(cap, base * 2^(attempt-1)).
 * Half is fixed so a retry is never immediate; half is random so callers that
 * failed together do not come back together.
 */
export function jitteredBackoffMs(
  attempt: number,
  baseMs: number,
  capMs: number,
  random: () => number = Math.random
): number {
  const n = Number.isFinite(attempt) && attempt > 1 ? Math.floor(attempt) : 1;
  const ceiling = Math.min(capMs, baseMs * 2 ** Math.min(n - 1, 30));
  const r = Math.min(Math.max(random(), 0), 1);
  return Math.round(ceiling / 2 + r * (ceiling / 2));
}

/**
 * True when an RPC error says the database never answered the question:
 * the client timed out, the API could not get a pool connection, or the
 * transport dropped. A refusal the database decided is not this.
 */
export function databaseDidNotAnswer(
  error: { message?: string | null; code?: string | null } | null | undefined
): boolean {
  if (!error) return false;
  const code = String(error.code ?? '');
  if (/^PGRST00[0-3]$/.test(code) || code === '57014' || /^08/.test(code)) return true;
  const msg = String(error.message ?? '');
  return /supabase_timeout|PGRST00[0-3]|Timed out acquiring connection|Thread killed by timeout|statement timeout|fetch failed|Failed to fetch|ECONNRESET|ETIMEDOUT|ECONNREFUSED|socket hang up|operation was aborted|\b50[234]\b/i.test(
    msg
  );
}

interface Deferral {
  refusals: number;
  recheckAtMs: number;
  touchedAtMs: number;
}

export class HorseEntryRefusalBackoff {
  private readonly deferrals = new Map<string, Deferral>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly random: () => number = Math.random
  ) {}

  /** How many horse entries are currently waiting. */
  get size(): number {
    return this.deferrals.size;
  }

  /** True when this horse should be offered this event on this pass. */
  shouldAttempt(tournamentId: string, horseId: string): boolean {
    const key = tournamentId + ':' + horseId;
    const d = this.deferrals.get(key);
    if (!d) return true;
    const nowMs = this.now();
    d.touchedAtMs = nowMs;
    return nowMs >= d.recheckAtMs;
  }

  /** The entry came back as an error; the next offer waits. Returns the wait. */
  refused(tournamentId: string, horseId: string): number {
    const nowMs = this.now();
    this.forgetStale(nowMs);
    const key = tournamentId + ':' + horseId;
    const refusals = (this.deferrals.get(key)?.refusals ?? 0) + 1;
    const waitMs = jitteredBackoffMs(
      refusals,
      HORSE_ENTRY_FIRST_RECHECK_MS,
      HORSE_ENTRY_MAX_RECHECK_MS,
      this.random
    );
    this.deferrals.set(key, { refusals, recheckAtMs: nowMs + waitMs, touchedAtMs: nowMs });
    return waitMs;
  }

  /** The entry was answered (admitted or decided); nothing is deferred. */
  settled(tournamentId: string, horseId: string): void {
    this.deferrals.delete(tournamentId + ':' + horseId);
  }

  private forgetStale(nowMs: number): void {
    for (const [key, d] of this.deferrals) {
      if (nowMs - d.touchedAtMs > FORGET_AFTER_MS) this.deferrals.delete(key);
    }
  }
}
