/**
 * `POST /away` — Dan 2026-08-23: the client is leaving the page or the app.
 *
 * Sent from the client's `pagehide` handler as a `keepalive` fetch, so it
 * survives the tab being torn down when a normal request would be cancelled.
 * This is the explicit counterpart to the websocket close, which only tells
 * us a transport died — ambiguous enough that it opens an 8s grace window
 * before concluding anything. "I am leaving" needs no grace.
 *
 * Best-effort: if the beacon never lands, the websocket close still marks
 * them away 8s later. Nothing is lost by a failure here.
 *
 * The player is NOT removed here — that is what `/leave` is for. They keep
 * their seat and are simply marked AWAY, which arms the one-SB-one-BB cap:
 * the dealing loop stands them up and cashes them out once both blinds have
 * been taken. Any heartbeat before then clears the flag at no cost, so an
 * accidental refresh is free.
 *
 * Body: `{ tableId }`.
 */

import type { IncomingMessage, ServerResponse } from 'http';
import { sendJSON } from '../http/respond.js';
import { authenticateRequest } from '../http/auth.js';
import { readBody } from '../http/body.js';
import { reportError } from '../services/errorReporter.js';

export interface AwayDeps {
  gameServer: {
    getTableEngine(tableId: string): { notifyPageLeft(userId: string): void } | null | undefined;
  };
}

export async function handleAway(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AwayDeps
): Promise<void> {
  try {
    const auth = await authenticateRequest(req);
    if (!auth) {
      return sendJSON(res, 401, { success: false, error: 'Authentication required' });
    }

    const body = JSON.parse(await readBody(req));
    const { tableId } = body;
    if (!tableId) {
      return sendJSON(res, 400, { success: false, error: 'Missing tableId' });
    }

    const engine = deps.gameServer.getTableEngine(tableId);
    // A table that is not running is not an error for this endpoint — the
    // beacon fires on the way out and the client will never read the reply.
    // Say OK rather than logging a 404 for every closed tab.
    if (!engine) return sendJSON(res, 200, { success: true, tracked: false });

    engine.notifyPageLeft(auth.userId);
    return sendJSON(res, 200, { success: true, tracked: true });
  } catch (err: unknown) {
    reportError(err, 'HTTP.away_error');
    return sendJSON(res, 500, { success: false, error: 'Invalid request body' });
  }
}
