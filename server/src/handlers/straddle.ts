/**
 * `POST /straddle` — Bible V8 §4.4: toggle auto-straddle enrollment.
 *
 * Extracted Phase U3.3 (2026-04-23). Byte-identical.
 * Body: `{ tableId, enabled: boolean }`.
 */

import type { IncomingMessage, ServerResponse } from 'http';
import { sendJSON } from '../http/respond.js';
import { authenticateRequest } from '../http/auth.js';
import { readBody } from '../http/body.js';
import { reportError } from '../services/errorReporter.js';

export interface StraddleDeps {
  gameServer: {
    getTableEngine(tableId: string):
      | {
          toggleStraddle(
            userId: string,
            enabled: boolean
          ): { success: boolean; [k: string]: unknown };
        }
      | null
      | undefined;
  };
}

export async function handleStraddle(
  req: IncomingMessage,
  res: ServerResponse,
  deps: StraddleDeps
): Promise<void> {
  try {
    const auth = await authenticateRequest(req);
    if (!auth) {
      return sendJSON(res, 401, { success: false, error: 'Authentication required' });
    }

    const body = JSON.parse(await readBody(req));
    const { tableId, enabled } = body;
    const userId = auth.userId;

    if (!tableId || typeof enabled !== 'boolean') {
      return sendJSON(res, 400, {
        success: false,
        error: 'Missing tableId or enabled must be a boolean',
      });
    }

    const engine = deps.gameServer.getTableEngine(tableId);
    if (!engine) {
      return sendJSON(res, 404, { success: false, error: 'Table engine not found' });
    }

    const result = engine.toggleStraddle(userId, enabled);
    return sendJSON(res, result.success ? 200 : 400, result);
  } catch (err: unknown) {
    reportError(err, 'HTTP.straddle_error');
    return sendJSON(res, 500, { success: false, error: 'Invalid request body' });
  }
}
