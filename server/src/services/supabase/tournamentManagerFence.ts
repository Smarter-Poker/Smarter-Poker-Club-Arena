import {
  currentTournamentDataAuthority,
  type TournamentDataAuthority,
} from './dataActorContext.js';

/**
 * A fenced manager stands down; it does not retry.
 *
 * The PostgREST pre-request hook (fn_smarter_data_api_pre_request) rejects any
 * request carrying a tournament lease generation that is no longer current
 * with ERRCODE 42501 'TOURNAMENT_MANAGER_FENCED'. Until 2026-09-10 the engine
 * had no reader for that answer: a manager whose in-process lease proof was
 * still being renewed treated the refusal like any other failed statement and
 * re-armed its five-second retry. Measured 05:15-05:56 UTC: 243 fenced
 * requests a minute for forty minutes (about twenty managers, each every five
 * seconds) until the process was restarted.
 *
 * This registry lets the one shared fetch boundary hand the refusal back to
 * the exact manager generation that made the request. The manager fences its
 * own async work synchronously and tears itself down; GameServer retires it on
 * its next lease pass because the manager no longer reports current authority.
 */
export const TOURNAMENT_MANAGER_FENCED_MARKER = 'TOURNAMENT_MANAGER_FENCED';

type FenceHandler = () => void;

const handlers = new Map<string, FenceHandler>();

function key(authority: TournamentDataAuthority): string {
  return `${authority.tournamentId.toLowerCase()}:${authority.leaseGeneration.toLowerCase()}`;
}

/** Register the stand-down for one exact manager generation. Returns the unregister. */
export function registerTournamentManagerFenceHandler(
  authority: TournamentDataAuthority,
  handler: FenceHandler
): () => void {
  const id = key(authority);
  handlers.set(id, handler);
  return () => {
    if (handlers.get(id) === handler) handlers.delete(id);
  };
}

/** True for the database's own fence refusal, whatever object carried it. */
export function isTournamentManagerFencedError(error: unknown): boolean {
  if (!error) return false;
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'object' && 'message' in error
        ? String((error as { message?: unknown }).message ?? '')
        : String(error);
  return message.includes(TOURNAMENT_MANAGER_FENCED_MARKER);
}

/**
 * Deliver one fence to the generation that made the request. Returns whether a
 * live handler existed; a request made outside any manager context, or by a
 * generation that already stood down, is nobody's to act on.
 */
export function notifyTournamentManagerFenced(
  authority: TournamentDataAuthority | null = currentTournamentDataAuthority()
): boolean {
  if (!authority) return false;
  const handler = handlers.get(key(authority));
  if (!handler) return false;
  handlers.delete(key(authority));
  try {
    handler();
  } catch {
    // The handler is a stand-down; a failure inside it must not surface
    // through the data path that observed the fence.
  }
  return true;
}

/**
 * Inspect one final PostgREST response at the shared fetch boundary. Only a 403
 * carrying the fence marker, observed inside a manager context, is a fence.
 * Everything else, including a body that cannot be parsed, is left alone.
 */
export async function observeFenceInResponse(response: Response): Promise<void> {
  if (response.status !== 403) return;
  const authority = currentTournamentDataAuthority();
  if (!authority) return;
  let body: unknown;
  try {
    body = await response.clone().json();
  } catch {
    return;
  }
  const message =
    body && typeof body === 'object' && 'message' in body
      ? String((body as { message?: unknown }).message ?? '')
      : '';
  if (!message.includes(TOURNAMENT_MANAGER_FENCED_MARKER)) return;
  notifyTournamentManagerFenced(authority);
}

/** Test/diagnostic only. */
export function registeredTournamentManagerFenceHandlerCount(): number {
  return handlers.size;
}
