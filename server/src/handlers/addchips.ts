/**
 * `POST /addchips` — player bought chips (top-up stack).
 *
 * Extracted Phase U3.3 (2026-04-23). Byte-identical.
 * Body: `{ tableId, amount }`.
 */

import type { IncomingMessage, ServerResponse } from 'http';
import { sendJSON } from '../http/respond.js';
import { authenticateRequest } from '../http/auth.js';
import { readBody } from '../http/body.js';
import { reportError } from '../services/errorReporter.js';

export interface AddchipsDeps {
  gameServer: {
    getTableEngine(tableId: string):
      | {
          addChips(
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

export async function handleAddchips(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AddchipsDeps
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

    const result = await engine.addChips(userId, amount);
    return sendJSON(res, result.success ? 200 : 400, result);
  } catch (err: unknown) {
    reportError(err, 'HTTP.addchips_error');
    return sendJSON(res, 500, { success: false, error: 'Failed to add chips' });
  }
}
