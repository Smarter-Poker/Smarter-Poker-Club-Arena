/**
 * Classifying database errors the Lightning code paths must tolerate rather
 * than treat as faults.
 *
 * Two families:
 *
 *  1. A FUNCTION THAT DOES NOT EXIST YET. The engine and the SQL ship on
 *     separate tracks, so for a while the engine may call an RPC whose
 *     migration has not been applied. PostgREST answers that with PGRST202
 *     ("Could not find the function ... in the schema cache"); Postgres itself
 *     answers an unknown function with SQLSTATE 42883. Either is "not
 *     available yet", never "the table is broken".
 *
 *  2. LIGHTNING_HAND_IN_PROGRESS. The database refuses any change to a seat's
 *     stack or `left_at` while that player is in a live Lightning hand, with a
 *     message carrying this token. It is a "not now", not a failure: nothing
 *     moved (the refusing trigger rolls the whole transaction back), and the
 *     same request succeeds once the hand has finished.
 */

export interface RpcErrorLike {
  code?: unknown;
  message?: unknown;
  details?: unknown;
  hint?: unknown;
}

function asRpcError(err: unknown): RpcErrorLike | null {
  if (err === null || err === undefined) return null;
  if (typeof err === 'string') return { message: err };
  if (typeof err === 'object') return err as RpcErrorLike;
  return null;
}

/** PostgREST's "no such function" and Postgres's undefined_function. */
export function isMissingFunctionError(err: unknown): boolean {
  const e = asRpcError(err);
  if (!e) return false;
  const code = typeof e.code === 'string' ? e.code : '';
  if (code === 'PGRST202' || code === '42883') return true;
  const message = typeof e.message === 'string' ? e.message : '';
  return /could not find the function/i.test(message);
}

/** The token the table_seats trigger raises for a player in a live Lightning hand. */
export const LIGHTNING_HAND_IN_PROGRESS = 'LIGHTNING_HAND_IN_PROGRESS';

const LIGHTNING_HAND_IN_PROGRESS_RE = /\bLIGHTNING_HAND_IN_PROGRESS\b/;

/**
 * True when the database refused a seat change because the player is in a
 * live Lightning hand. Matched anywhere in the message (the trigger's message
 * starts with the token, but a calling function may prefix its own context)
 * and in `details`, where some wrappers move the original text.
 */
export function isLightningHandInProgress(err: unknown): boolean {
  const e = asRpcError(err);
  if (!e) return false;
  for (const field of [e.message, e.details, e.code]) {
    if (typeof field === 'string' && LIGHTNING_HAND_IN_PROGRESS_RE.test(field)) return true;
  }
  return false;
}

/**
 * What a player is told when an add-on or top-up is refused because their
 * chips are in a Lightning hand. Title Case, no em dashes (CLAUDE.md 5.7).
 */
export const LIGHTNING_ADD_ON_REFUSED_MESSAGE =
  'Your Chips Are In A Lightning Hand. Add Chips When It Finishes.';
