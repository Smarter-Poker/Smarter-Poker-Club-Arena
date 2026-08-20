/**
 * `POST /tipdealer` — player tipped the dealer out of their table stack.
 *
 * Mirror of `POST /withdrawchips`: the chips leave the seat and go to the club
 * treasury instead of the player's wallet. Body: `{ tableId, amount }`.
 *
 * This route exists because the browser used to call the `deduct_table_chip_lock`
 * RPC directly, which wrote `table_seats.stack` while the authoritative engine
 * held a different number in memory — settlement then overwrote the DB from
 * memory and the player got their tip back while the club kept a copy. Routing
 * through the engine keeps both numbers in agreement.
 */

import type { IncomingMessage, ServerResponse } from 'http';
import { sendJSON } from '../http/respond.js';
import { authenticateRequest } from '../http/auth.js';
import { readBody } from '../http/body.js';
import { reportError } from '../services/errorReporter.js';

export interface TipdealerDeps {
  gameServer: {
    getTableEngine(tableId: string):
      | {
          tipDealer(
            userId: string,
            amount: number
          ):
            | { success: boolean; [k: string]: unknown }
            | Promise<{ success: boolean; [k: string]: unknown }>;
        }
      | null
      | undefined;
  };
}

export async function handleTipdealer(
  req: IncomingMessage,
  res: ServerResponse,
  deps: TipdealerDeps
): Promise<void> {
  try {
    const auth = await authenticateRequest(req);
    if (!auth) {
      return sendJSON(res, 401, { success: false, error: 'Authentication required' });
    }

    const body = JSON.parse(await readBody(req));
    const { tableId, amount } = body;
    const userId = auth.userId;

    if (!tableId || !amount || amount <= 0) {
      return sendJSON(res, 400, { success: false, error: 'Missing tableId or invalid amount' });
    }

    const engine = deps.gameServer.getTableEngine(tableId);
    if (!engine) {
      return sendJSON(res, 404, { success: false, error: 'Table engine not found' });
    }

    const result = await engine.tipDealer(userId, amount);
    return sendJSON(res, result.success ? 200 : 400, result);
  } catch (err: unknown) {
    reportError(err, 'HTTP.tipdealer_error');
    return sendJSON(res, 500, { success: false, error: 'Failed to tip dealer' });
  }
}
