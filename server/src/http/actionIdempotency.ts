/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  AN ACTION APPLIES ONCE (Realtime programme, Phase 3 - 2026-09-05)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * THE HOLE THIS CLOSES, and it is not theoretical arithmetic - it is written
 * into the two files that meet at `POST /action`:
 *
 *   - `GameServerAPI.submitAction` retries a 429 three times, at 300ms, 450ms
 *     and 700ms. Those delays were chosen to sit OUTSIDE the engine's 250ms
 *     per-user-per-table window (`http/rateLimit.ts`) so the retry would not
 *     be refused again. That is correct for the case it was written for, and
 *     it is exactly what makes a duplicate possible: the one mechanism that
 *     would have collapsed two identical posts into one is deliberately
 *     stepped over.
 *   - `engineFetch` retries once more on a 401, after refreshing the session.
 *
 * Both retries are safe ONLY while the first attempt provably did not run. A
 * 429 and a 401 are refusals, so the reasoning holds today - but it is
 * reasoning about someone else's status code, re-derived by every future
 * reader, protecting a raise that moves real chips. A proxy that answers 429
 * after passing the request through, a load balancer retrying a POST, an
 * engine that starts returning 401 from inside the handler: any of those turns
 * a retry into a second raise. `handlePlayerAction` has no idea it is looking
 * at the same intent twice, because nothing in the request says so.
 *
 * WHAT THIS DOES. The client stamps one key on one INTENT - generated once per
 * `submitAction` call and reused by every retry inside it - and the engine
 * remembers what it answered. A repeat of a key that already ran does not
 * reach the engine at all; it gets the first answer back, verbatim.
 *
 * FIVE DECISIONS WORTH THE WORDS:
 *
 * 1. THE KEY TRAVELS IN THE BODY, NOT A HEADER. `Idempotency-Key` is the
 *    conventional spelling and it is wrong here: the engine is a different
 *    origin from the SPA, and `CORS_HEADERS` allows exactly `Content-Type,
 *    Authorization`. A custom request header would fail preflight in every
 *    browser, and "fix" it by widening a shared CORS constant and adding an
 *    OPTIONS round trip to the hot path of a poker action. The body is already
 *    ours and already JSON.
 *
 * 2. A KEY IS REMEMBERED ONLY IF THE ACTION REACHED THE ENGINE. Not on 401,
 *    404 (no engine for the table yet - the normal state for ~2 minutes after
 *    a restart), 429 or 500. Those mean "not processed", so the next attempt
 *    must be free to run for real. Caching a 404 would turn a table that was
 *    still rehydrating into a table that refuses that player's action for a
 *    minute.
 *
 * 3. A REJECTION IS AN ANSWER AND IS REMEMBERED. If the engine said "not your
 *    turn", the retry gets "not your turn" - it does not get a second chance
 *    to land a raise a beat later, into a pot that has moved on.
 *
 * 4. THE SAME KEY WITH A DIFFERENT ACTION IS REFUSED, NEVER REPLAYED. A key
 *    names one intent. If the payload differs, one of the two is not the
 *    intent that ran, and handing back the other one's result would report a
 *    fold as a call. 409, counted, engine untouched.
 *
 * 5. IT IS OPTIONAL, AND SILENCE IS THE OLD BEHAVIOUR. Old bundles stay
 *    served from the origin's additive asset pool (CLAUDE.md 1.1), so a tab
 *    that has been open since before this shipped is posting actions right
 *    now with no key. Those must keep working exactly as they did.
 *
 * MEMORY IS BOUNDED THE SAME WAY `ClientConnectionEvents` is: a TTL, a hard
 * ceiling, and eviction of the oldest rather than growth. This runs on the one
 * core the engine has.
 *
 * ONE ACCEPTED BOUND, WRITTEN DOWN SO IT IS A DECISION AND NOT AN OVERSIGHT:
 * this map is in memory and an engine restart loses it. A restart happens
 * inside the announced :55 break with every table parked and the platform
 * frozen (CLAUDE.md 13), and a key lives sixty seconds - so the exposure is a
 * retry that crosses a restart at a moment when actions are refused anyway.
 * The alternative, persisting keys to Postgres, puts a database write on the
 * hot path of every action on a one-core engine. Not worth it.
 */

import { actionIdempotencyTotal } from '../observability/engineInstruments.js';

/**
 * How long one key is remembered.
 *
 * It has to outlive every retry of a single intent - the client's own ladder
 * is at most 300+450+700ms plus one 401 refresh - with enough margin that a
 * stalled request coming back late is still recognised. It must NOT outlive
 * the hand by much: a key is dead weight the moment its turn has passed.
 * Sixty seconds is two orders of magnitude above the ladder and below any
 * turn timer plus time bank.
 */
export const ACTION_KEY_TTL_MS = 60_000;

/**
 * Hard ceiling on remembered keys. Humans acting over HTTP are the only
 * source (a horse's action never crosses this route - it is its input device,
 * CLAUDE.md 10.5, not an exclusion), so this is far above any real load; it
 * exists so a client bug cannot grow the map without bound.
 */
export const MAX_ACTION_KEYS = 20_000;

/**
 * What a key may look like. The client sends a UUID; this accepts anything
 * UUID-shaped or shorter and refuses the rest LOUDLY (400) rather than
 * ignoring it. Silently dropping a malformed key would leave a client
 * believing it had exactly-once protection that it did not have, which is the
 * worst of the three possible outcomes.
 */
const KEY_PATTERN = /^[A-Za-z0-9_.:-]{8,100}$/;

export function isValidActionKey(raw: unknown): raw is string {
  return typeof raw === 'string' && KEY_PATTERN.test(raw);
}

/** What the engine answered, kept verbatim so a replay is byte-identical. */
interface RememberedAction {
  /** `${action}|${amount}` - the intent this key names. */
  fingerprint: string;
  status: number;
  body: unknown;
  at: number;
  /**
   * Whether this key has already been counted as a replay / as a conflict.
   *
   * A METRIC A PLAYER CAN MOVE ON DEMAND IS THE PHASE 2 DEFECT AGAIN (audit
   * fix, 2026-09-05). The lookup deliberately sits above the rate limiter, so
   * an authenticated player could post one known key in a loop and drive
   * either counter as high as they liked - and `conflict` is documented as
   * "should be flat zero forever", which makes it exactly the series a false
   * signal ruins. Counting once per KEY bounds both by the size of a map that
   * is itself bounded, and it is the more meaningful number anyway: it counts
   * INTENTS that were duplicated, not requests.
   */
  countedReplay: boolean;
  countedConflict: boolean;
}

export type ActionKeyVerdict =
  | { kind: 'fresh' }
  | { kind: 'replay'; status: number; body: unknown }
  | { kind: 'conflict' };

const remembered = new Map<string, RememberedAction>();

/**
 * Writes since the last sweep. Sweeping on EVERY write would walk the whole
 * map on the hot path of a poker action - up to MAX_ACTION_KEYS iterations
 * while a player waits, on the one core the engine has. Expiry is not
 * urgent (a stale key is answered correctly by the TTL check in `lookupAction`
 * whether or not it has been swept), so hygiene runs in batches and the hard
 * ceiling is the only thing checked every time.
 */
let writesSinceSweep = 0;
const WRITES_BETWEEN_SWEEPS = 500;

/** Test seam. */
export function _resetActionIdempotencyForTests(): void {
  remembered.clear();
  writesSinceSweep = 0;
}

/**
 * The key is scoped to the player AND the table. A key is generated by one
 * client and could in principle repeat across two players; scoping means one
 * player can never be handed another player's answer, whatever they send.
 */
function storageKey(userId: string, tableId: string, key: string): string {
  return `${userId}|${tableId}|${key}`;
}

/**
 * The intent a key names: the action and its amount.
 *
 * EVERY amount is stringified, not only a number (audit fix, 2026-09-05). The
 * first version of this kept `typeof amount === 'number'` and folded anything
 * else to the empty string, which meant a client that sent `"50"` and one that
 * sent `"500"` produced the SAME fingerprint - so a retry carrying a different
 * raise would have been answered with the first one's result. `submitAction`
 * types the parameter as a number and would not do that, but the whole point
 * of this file is to stop depending on a caller behaving; a coercion that
 * silently discards the amount is precisely the wrong failure mode for the one
 * field that decides how many chips move.
 */
export function actionFingerprint(action: string, amount: unknown): string {
  const amt = amount === undefined || amount === null ? '' : String(amount);
  return `${String(action).toLowerCase()}|${amt}`;
}

function prune(now: number): void {
  const overCeiling = remembered.size > MAX_ACTION_KEYS;
  if (++writesSinceSweep >= WRITES_BETWEEN_SWEEPS || overCeiling) {
    writesSinceSweep = 0;
    for (const [k, v] of remembered) {
      if (now - v.at > ACTION_KEY_TTL_MS) remembered.delete(k);
    }
  }
  if (remembered.size <= MAX_ACTION_KEYS) return;
  // Still over the ceiling after the TTL sweep: drop the oldest half. Losing
  // an old key costs at most one duplicate-suppression; growing without bound
  // costs the engine's only core.
  const byAge = [...remembered.entries()].sort((a, b) => a[1].at - b[1].at);
  for (let i = 0; i < byAge.length / 2; i++) remembered.delete(byAge[i][0]);
}

/**
 * Has this exact intent already been answered?
 *
 * Called BEFORE the rate limiter on purpose: a replay is not a new action and
 * must never be told to slow down. A 429 on a replay would send the client
 * round its retry ladder again and finally report "The table is busy" for an
 * action that had already been accepted - the precise lie this file exists to
 * prevent. A replay costs one Map lookup and never touches the engine.
 */
export function lookupAction(
  userId: string,
  tableId: string,
  key: string,
  fingerprint: string,
  now: number = Date.now()
): ActionKeyVerdict {
  const hit = remembered.get(storageKey(userId, tableId, key));
  if (!hit) return { kind: 'fresh' };
  if (now - hit.at > ACTION_KEY_TTL_MS) {
    remembered.delete(storageKey(userId, tableId, key));
    return { kind: 'fresh' };
  }
  // Counted once per key, never once per request: see `countedReplay` above.
  // Whatever a client does with a key it already spent, it cannot move either
  // series by more than one.
  if (hit.fingerprint !== fingerprint) {
    if (!hit.countedConflict) {
      hit.countedConflict = true;
      actionIdempotencyTotal.inc(1, { outcome: 'conflict' });
    }
    return { kind: 'conflict' };
  }
  if (!hit.countedReplay) {
    hit.countedReplay = true;
    actionIdempotencyTotal.inc(1, { outcome: 'replay' });
  }
  return { kind: 'replay', status: hit.status, body: hit.body };
}

/**
 * Remember what the engine answered for this intent.
 *
 * There is no "in flight" state and none is needed: between the lookup and
 * this call the handler does not await, and Node runs one turn of the event
 * loop at a time, so two simultaneous posts of the same key cannot both find
 * `fresh`. If an await is ever introduced between the two, that reasoning
 * dies and this needs a reservation - `theSameActionAppliesOnce.law.test.ts`
 * pins the absence of an await in that window for exactly this reason.
 */
export function rememberAction(
  userId: string,
  tableId: string,
  key: string,
  fingerprint: string,
  status: number,
  body: unknown,
  now: number = Date.now()
): void {
  remembered.set(storageKey(userId, tableId, key), {
    fingerprint,
    status,
    body,
    at: now,
    countedReplay: false,
    countedConflict: false,
  });
  actionIdempotencyTotal.inc(1, { outcome: 'stored' });
  prune(now);
}

/** Test/observability seam: how many keys are currently held. */
export function actionKeysHeld(): number {
  return remembered.size;
}
