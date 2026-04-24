/**
 * `POST /showhand` — Bible V8 §4.21: voluntarily show hand at showdown.
 *
 * Extracted Phase U3.3 (2026-04-23). Byte-identical.
 * Body: `{ tableId }`.
 */

import type { IncomingMessage, ServerResponse } from 'http';
import { sendJSON } from '../http/respond.js';
import { authenticateRequest } from '../http/auth.js';
import { readBody } from '../http/body.js';
import { reportError } from '../services/errorReporter.js';

export interface ShowhandDeps {
  gameServer: {
    getTableEngine(tableId: string):
      | {
          showHand(userId: string): { success: boolean; [k: string]: unknown };
        }
      | null
      | undefined;
  };
}

export async function handleShowhand(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ShowhandDeps
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
      return sendJSON(res, 404, { success: false, error: 'Table engine not found' });
    }

    const result = engine.showHand(userId);
    return sendJSON(res, result.success ? 200 : 400, result);
  } catch (err: unknown) {
    reportError(err, 'HTTP.showhand_error');
    return sendJSON(res, 500, { success: false, error: 'Invalid request body' });
  }
}
