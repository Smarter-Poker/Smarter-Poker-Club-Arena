/**
 * `POST /withdrawchips` — player cashed out chips from their table stack back
 * to their PLAYER wallet (partial cash-out). Mirror of `POST /addchips`.
 * Body: `{ tableId, amount }`.
 */

import type { IncomingMessage, ServerResponse } from 'http';
import { sendJSON } from '../http/respond.js';
import { authenticateRequest } from '../http/auth.js';
import { readBody } from '../http/body.js';
import { reportError } from '../services/errorReporter.js';

export interface WithdrawchipsDeps {
  gameServer: {
    getTableEngine(tableId: string):
      | {
          withdrawChips(
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

export async function handleWithdrawchips(
  req: IncomingMessage,
  res: ServerResponse,
  deps: WithdrawchipsDeps
): Promise<void> {
  try {
    const auth = await authenticateRequest(req);
    if (!auth) {
      return sendJSON(res, 401, { success: false, error: 'Authentication required' });
    }

    const body = JSON.parse(await readBody(req));
    const { tableId, amount } = body;
    const userId = auth.userId;

    // 2026-08-27: `!amount || amount <= 0` alone lets a non-numeric string
    // through - `!"abc"` is false and `"abc" <= 0` is false - so a garbage body
    // reached the engine with a non-number. showhand.ts already validates this
    // way; the two chip endpoints did not.
    if (!tableId || typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
      return sendJSON(res, 400, { success: false, error: 'Missing tableId or invalid amount' });
    }

    const engine = deps.gameServer.getTableEngine(tableId);
    if (!engine) {
      return sendJSON(res, 404, { success: false, error: 'Table engine not found' });
    }

    const result = await engine.withdrawChips(userId, amount);
    return sendJSON(res, result.success ? 200 : 400, result);
  } catch (err: unknown) {
    reportError(err, 'HTTP.withdrawchips_error');
    return sendJSON(res, 500, { success: false, error: 'Failed to withdraw chips' });
  }
}
