/**
 * `POST /preaction` — Bible V8 §4.15: set or clear pre-action.
 *
 * Extracted Phase U3.3 (2026-04-23). Byte-identical.
 * Body: `{ tableId, action, maxCallAmount? }`.
 */

import type { IncomingMessage, ServerResponse } from 'http';
import { sendJSON } from '../http/respond.js';
import { authenticateRequest } from '../http/auth.js';
import { readBody } from '../http/body.js';
import { reportError } from '../services/errorReporter.js';

export interface PreactionDeps {
  gameServer: {
    getTableEngine(tableId: string):
      | {
          setPreAction(
            userId: string,
            action: string,
            maxCallAmount?: number
          ): { success: boolean; [k: string]: unknown };
        }
      | null
      | undefined;
  };
}

export async function handlePreaction(
  req: IncomingMessage,
  res: ServerResponse,
  deps: PreactionDeps
): Promise<void> {
  try {
    const auth = await authenticateRequest(req);
    if (!auth) {
      return sendJSON(res, 401, { success: false, error: 'Authentication required' });
    }

    const body = JSON.parse(await readBody(req));
    const { tableId, action, maxCallAmount } = body;
    const userId = auth.userId;

    if (!tableId || !action) {
      return sendJSON(res, 400, { success: false, error: 'Missing tableId or action' });
    }

    const engine = deps.gameServer.getTableEngine(tableId);
    if (!engine) {
      return sendJSON(res, 404, { success: false, error: 'Table engine not found' });
    }

    const result = engine.setPreAction(userId, action, maxCallAmount);
    return sendJSON(res, result.success ? 200 : 400, result);
  } catch (err: unknown) {
    reportError(err, 'HTTP.preaction_error');
    return sendJSON(res, 500, { success: false, error: 'Invalid request body' });
  }
}
