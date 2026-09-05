/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A BAD BEAT JACKPOT IS ANNOUNCED ONCE, WHEN IT HAPPENS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-08-26, verbatim: "the notification keeps resending anytime you
 * refresh or open a page... it should only display once, and at the actual
 * time it happens."
 *
 * WHY IT REPLAYED. The engine hub RETAINS transient events and re-delivers
 * them to a freshly connected socket. That is deliberate and load-bearing for
 * showdown reveals - a player who reconnects mid-hand must still receive the
 * reveal - and `EngineStateClient` says so where it resets its de-duplication
 * counter:
 *
 *     "Reset on every (re)connect: the hub's counter restarts with the engine,
 *      and a fresh socket legitimately re-receives retained reveal events."
 *
 * So the ONLY de-duplication the client had was `lastEventSeq`, which is
 * connection-scoped BY DESIGN. Refresh the page, open a second table, let the
 * socket drop on a train - new socket, seq resets, the retained jackpot event
 * arrives again, and the celebration fires as though someone had just won.
 * Nothing was broken in the transport; the client simply had no way to tell a
 * replay from a hit.
 *
 * TWO INDEPENDENT GATES, because each covers what the other cannot:
 *
 *   FRESHNESS  A hit is announced only if it happened within the last
 *              BBJ_FRESH_MS. This is what makes "at the actual time it
 *              happens" true for a player whose FIRST sight of the event is
 *              the replay - identity alone would happily show them an
 *              hour-old jackpot, once, as news.
 *
 *   IDENTITY   table_id + hand_number, remembered across reloads, so a hit
 *              already seen is never shown twice. This is what covers the
 *              case freshness cannot: a refresh WITHIN the freshness window,
 *              which is exactly what a player does when a jackpot lands and
 *              they want to look at the table again.
 *
 * The identity set is persisted in sessionStorage rather than localStorage on
 * purpose: it must survive a reload (the reported bug) but has no business
 * outliving the browser session, and a per-tab store cannot leak one tab's
 * celebration suppression into a window the player opens tomorrow.
 *
 * Every storage access is wrapped: Safari private mode throws on setItem, and
 * a jackpot celebration must never be what takes the table down. When storage
 * is unavailable the in-memory set still de-duplicates for the life of the
 * page, which is the same protection the module-level guards gave before.
 */

import { serverNow } from './serverClock';

/**
 * How recent an emission has to be to count as "now".
 *
 * 90 seconds is deliberately generous against the ~1-3s the payout event
 * actually takes to arrive after the hand completes (postHandTasks writes to
 * the DB first). The window has to absorb a slow reconnect and clock skew
 * between the engine and the player's device without ever being long enough
 * to make a stale replay read as live. Retained events are minutes-to-hours
 * old by the time they are replayed, so there is no near-miss band here.
 */
export const BBJ_FRESH_MS = 90_000;

/**
 * BBJ build plan phase 1 (2026-09-05): "now" is the ENGINE'S now. Every
 * emitter stamps `emittedAt` from the engine's clock (or the database's,
 * which the skew monitor keeps within seconds of it), so comparing it
 * against the device clock made the gate hostage to the phone's settings: a
 * clock two minutes fast refused every live jackpot as a replay, silently
 * and forever. lib/serverClock learns the engine's clock from every EVENT
 * and PING frame; until the engine has spoken it IS the device clock, so
 * nothing is worse than before.
 */

/** Only this many ids are remembered; a jackpot is rare, the cap is a seatbelt. */
const MAX_REMEMBERED = 50;

const STORAGE_KEY = 'sp-bbj-seen-hits';

/** Survives when sessionStorage does not (private mode, storage disabled). */
const memory = new Set<string>();

/**
 * The stable identity of one jackpot hit.
 *
 * Both fields come from the engine (`table_id`, `hand_number`). A hand number
 * is unique per table and never reused within a session, so the pair is
 * unique per hit without needing the engine to mint an id.
 */
export function bbjHitKey(tableId: string | undefined, handNumber: number | undefined): string {
  return `${tableId ?? 'unknown'}:${handNumber ?? 0}`;
}

function readSeen(): Set<string> {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return new Set(memory);
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set(memory);
    // Union with memory: a write may have failed while a read succeeds.
    return new Set([...memory, ...parsed.filter((v): v is string => typeof v === 'string')]);
  } catch {
    return new Set(memory);
  }
}

function writeSeen(seen: Set<string>): void {
  // Keep the newest ids; Set preserves insertion order.
  const trimmed = [...seen].slice(-MAX_REMEMBERED);
  memory.clear();
  for (const id of trimmed) memory.add(id);
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
  } catch {
    /* Storage unavailable — `memory` is still authoritative for this page. */
  }
}

export interface BbjAnnounceInput {
  tableId?: string;
  handNumber?: number;
  /** `emitted_at` from the engine event. Absent on a pre-2026-08-26 engine. */
  emittedAt?: number;
  /**
   * Dan 2026-08-28: "You shouldn't get a banner hours, minutes or days
   * later." When true, an event with NO timestamp is refused outright
   * instead of falling back to identity-only de-duplication. For the global
   * login-path banner, an unstamped event cannot be proven live, and a
   * banner that might be days old is worse than no banner — the celebration
   * on the table where it actually happened is unaffected (that path always
   * carries the engine's stamp, and does not set this flag).
   */
  requireStamp?: boolean;
  /** Injectable for tests. */
  now?: number;
}

/**
 * Should this jackpot event be announced to the player right now?
 *
 * Returns true AT MOST ONCE per (table, hand) per session, and only for an
 * event that is genuinely fresh. Calling it marks the hit as seen, so it is
 * safe to call from a React effect that may run twice (StrictMode) and from
 * more than one mounted table.
 *
 * COMPATIBILITY: an event with no `emittedAt` comes from an engine that has
 * not been redeployed yet. Those are allowed through the freshness gate and
 * caught by identity alone - the behaviour this repo shipped before today,
 * never worse. Once the engine carries the stamp, both gates apply.
 */
export function shouldAnnounceBbjHit(input: BbjAnnounceInput): boolean {
  const now = input.now ?? serverNow();

  if (typeof input.emittedAt === 'number' && input.emittedAt > 0) {
    const age = now - input.emittedAt;
    /* Future-stamped events are NOT rejected: a device clock running a little
       behind the engine's makes `age` negative for a perfectly live hit, and
       refusing those would suppress the real thing on exactly the devices
       least able to report why. Only genuine staleness is rejected. */
    if (age > BBJ_FRESH_MS) return false;
  } else if (input.requireStamp) {
    /* No timestamp and the caller demands one: cannot be proven live, so it
       is not announced (Dan 2026-08-28 — no banners minutes/hours/days
       late). Identity is deliberately NOT marked seen here: if a stamped
       copy of the same hit arrives moments later, it may still announce. */
    return false;
  }

  const key = bbjHitKey(input.tableId, input.handNumber);
  const seen = readSeen();
  if (seen.has(key)) return false;

  seen.add(key);
  writeSeen(seen);
  return true;
}

/** Test-only reset. Never called by the app. */
export function __resetBbjSeenForTests(): void {
  memory.clear();
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    /* nothing to clear */
  }
}
