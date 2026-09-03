/**
 * `POST /timebank` — request a Time Bank for the current decision.
 *
 * Extracted Phase U3.3 (2026-04-23).
 * Body: `{ tableId }` (userId from JWT).
 *
 * TWO KINDS OF SUCCESS (Dan 2026-08-23). A bank may not be spent until the 15s
 * action clock is genuinely exhausted, so a press made while the clock is still
 * running returns `{ success: true, armed: true, message }` — nothing charged,
 * nothing added, the bank redeemed automatically the moment the clock expires.
 * A press at expiry returns `{ success: true }` with the clock reset to a full
 * 20 seconds.
 *
 * The client MUST branch on `armed`: showing a running time-bank countdown for
 * an armed-but-unspent request is exactly the "clock that lies to the player"
 * failure this endpoint has been bitten by twice already.
 */

import type { IncomingMessage, ServerResponse } from 'http';
import { sendJSON } from '../http/respond.js';
import { authenticateRequest } from '../http/auth.js';
import { readBody } from '../http/body.js';
import { reportError } from '../services/errorReporter.js';

export interface TimebankDeps {
  gameServer: {
    getTableEngine(tableId: string):
      | {
          activateTimeBank(userId: string): Promise<{ success: boolean; [k: string]: unknown }>;
        }
      | null
      | undefined;
  };
}

export async function handleTimebank(
  req: IncomingMessage,
  res: ServerResponse,
  deps: TimebankDeps
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
      return sendJSON(res, 404, { success: false, error: 'Table Not Ready' });
    }

    const result = await engine.activateTimeBank(userId);
    return sendJSON(res, result.success ? 200 : 400, result);
  } catch (err: unknown) {
    reportError(err, 'HTTP.timebank_error');
    return sendJSON(res, 500, { success: false, error: 'Invalid request body' });
  }
}
