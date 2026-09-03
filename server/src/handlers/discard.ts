/**
 * `POST /discard` — FIX 120: Crazy Pineapple discard.
 *
 * Extracted Phase U3.3 (2026-04-23). Byte-identical.
 * Body: `{ tableId, cardIndex }`.
 */

import type { IncomingMessage, ServerResponse } from 'http';
import { sendJSON } from '../http/respond.js';
import { authenticateRequest } from '../http/auth.js';
import { readBody } from '../http/body.js';
import { reportError } from '../services/errorReporter.js';

export interface DiscardDeps {
  gameServer: {
    getTableEngine(tableId: string):
      | {
          submitDiscard(
            userId: string,
            cardIndex: number
          ): { success: boolean; [k: string]: unknown };
        }
      | null
      | undefined;
  };
}

export async function handleDiscard(
  req: IncomingMessage,
  res: ServerResponse,
  deps: DiscardDeps
): Promise<void> {
  try {
    const auth = await authenticateRequest(req);
    if (!auth) {
      return sendJSON(res, 401, { success: false, error: 'Authentication required' });
    }

    const body = JSON.parse(await readBody(req));
    const { tableId, cardIndex } = body;
    const userId = auth.userId;

    if (!tableId || cardIndex === undefined) {
      return sendJSON(res, 400, { success: false, error: 'Missing tableId or cardIndex' });
    }

    const engine = deps.gameServer.getTableEngine(tableId);
    if (!engine) {
      return sendJSON(res, 404, { success: false, error: 'Table engine not found' });
    }

    const result = engine.submitDiscard(userId, cardIndex);
    return sendJSON(res, result.success ? 200 : 400, result);
  } catch (err: unknown) {
    reportError(err, 'HTTP.discard_error');
    return sendJSON(res, 500, { success: false, error: 'Invalid request body' });
  }
}
