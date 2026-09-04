/**
 * `POST /leave` — player leaves the table (auto-fold if mid-hand, cashout).
 *
 * Extracted Phase U3.3 (2026-04-23). Byte-identical.
 * Body: `{ tableId }`. When the engine is not running, returns a 200 with
 * `immediate: true` so the client can do direct DB cleanup.
 */

import type { IncomingMessage, ServerResponse } from 'http';
import { sendJSON } from '../http/respond.js';
import { authenticateRequest } from '../http/auth.js';
import { readBody } from '../http/body.js';
import { reportError } from '../services/errorReporter.js';

export interface LeaveDeps {
  gameServer: {
    getTableEngine(tableId: string):
      | {
          leaveTable(
            userId: string
          ):
            | { success: boolean; [k: string]: unknown }
            | Promise<{ success: boolean; [k: string]: unknown }>;
        }
      | null
      | undefined;
  };
}

export async function handleLeave(
  req: IncomingMessage,
  res: ServerResponse,
  deps: LeaveDeps
): Promise<void> {
  try {
    const auth = await authenticateRequest(req);
    if (!auth) {
      return sendJSON(res, 401, { success: false, error: 'Authentication required' });
    }

    const body = JSON.parse(await readBody(req));
    const { tableId } = body;
    const userId = auth.userId;

    if (!tableId) {
      return sendJSON(res, 400, { success: false, error: 'Missing tableId' });
    }

    const engine = deps.gameServer.getTableEngine(tableId);
    if (!engine) {
      // Engine not running — do direct DB cleanup.
      //
      // This is the one door the all-in refusal in leaveTable() cannot cover:
      // `is_all_in` lives in engine memory, and there is no engine. With no
      // engine there is also no dealing loop, so no hand can be in progress and
      // nobody can be all-in in one — the seat is stale state, not a live pot.
      // Said out loud because it IS a bypass, and if all-in ever needs to
      // survive an engine restart it has to become a table_seats column first.
      console.warn(`[HTTP /leave] No engine for table ${tableId} - direct DB cleanup`);
      return sendJSON(res, 200, {
        success: true,
        immediate: true,
        // CHIP STANDARD C1 (2026-09-02): the explicit hand-over. The browser
        // cashes out ONLY when this is set (or `note` is, for older builds);
        // on every other acknowledged leave the engine owns the cash-out.
        clientCashout: true,
        note: 'No engine running, client handles DB cleanup',
      });
    }

    const result = await engine.leaveTable(userId);
    // CHIP CONTINUITY: a leave refused by the stay clock is the house rule
    // working, not a server failure. 200 with success:false and the code, so
    // the client shows the label without filing an error for it.
    const status = result.success || result.code === 'LEAVE_LOCKED' ? 200 : 400;
    return sendJSON(res, status, result);
  } catch (err: unknown) {
    reportError(err, 'HTTP.leave_error');
    return sendJSON(res, 500, { success: false, error: 'Failed to leave table' });
  }
}
