/**
 * `POST /rit` — Bible V8 §4.20: respond to Run It Twice offer.
 *
 * Extracted Phase U3.3 (2026-04-23). Byte-identical.
 * Body: `{ tableId, response: 'accept' | 'decline' }`.
 */

import type { IncomingMessage, ServerResponse } from 'http';
import { sendJSON } from '../http/respond.js';
import { authenticateRequest } from '../http/auth.js';
import { readBody } from '../http/body.js';
import { reportError } from '../services/errorReporter.js';

export interface RitDeps {
  gameServer: {
    getTableEngine(tableId: string):
      | {
          // Matches ServerTableEngine.respondToRIT's actual signature.
          respondToRIT(
            userId: string,
            response?: 'accept' | 'decline',
            runs?: 1 | 2 | 3
          ): { success: boolean; [k: string]: unknown };
        }
      | null
      | undefined;
  };
}

export async function handleRit(
  req: IncomingMessage,
  res: ServerResponse,
  deps: RitDeps
): Promise<void> {
  try {
    const auth = await authenticateRequest(req);
    if (!auth) {
      return sendJSON(res, 401, { success: false, error: 'Authentication required' });
    }

    const body = JSON.parse(await readBody(req));
    const { tableId, response } = body;
    const userId = auth.userId;

    if (!tableId || !response || !['accept', 'decline'].includes(response)) {
      return sendJSON(res, 400, {
        success: false,
        error: 'Missing tableId or invalid response (must be accept or decline)',
      });
    }

    const engine = deps.gameServer.getTableEngine(tableId);
    if (!engine) {
      return sendJSON(res, 404, { success: false, error: 'Table engine not found' });
    }

    // response validated to be 'accept' | 'decline' above — narrow via cast for the typed signature.
    const result = engine.respondToRIT(userId, response as 'accept' | 'decline');
    return sendJSON(res, result.success ? 200 : 400, result);
  } catch (err: unknown) {
    reportError(err, 'HTTP.rit_error');
    return sendJSON(res, 500, { success: false, error: 'Invalid request body' });
  }
}
