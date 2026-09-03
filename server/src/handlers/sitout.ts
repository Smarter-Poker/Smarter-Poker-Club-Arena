/**
 * `POST /sitout` — Bible V8 §7.12: sit out / sit back in.
 *
 * Extracted Phase U3.3 (2026-04-23). Byte-identical.
 * Body: `{ tableId, sitOut: boolean }`.
 */

import type { IncomingMessage, ServerResponse } from 'http';
import { sendJSON } from '../http/respond.js';
import { authenticateRequest } from '../http/auth.js';
import { readBody } from '../http/body.js';
import { reportError } from '../services/errorReporter.js';

export interface SitoutDeps {
  gameServer: {
    getTableEngine(tableId: string):
      | {
          sitOut(userId: string, sitOut: boolean): { success: boolean; [k: string]: unknown };
        }
      | null
      | undefined;
  };
}

export async function handleSitout(
  req: IncomingMessage,
  res: ServerResponse,
  deps: SitoutDeps
): Promise<void> {
  try {
    const auth = await authenticateRequest(req);
    if (!auth) {
      return sendJSON(res, 401, { success: false, error: 'Authentication required' });
    }

    const body = JSON.parse(await readBody(req));
    const { tableId, sitOut } = body;
    const userId = auth.userId;

    if (!tableId || typeof sitOut !== 'boolean') {
      return sendJSON(res, 400, {
        success: false,
        error: 'Missing tableId or sitOut must be a boolean',
      });
    }

    const engine = deps.gameServer.getTableEngine(tableId);
    if (!engine) {
      return sendJSON(res, 404, { success: false, error: 'Table engine not found' });
    }

    const result = engine.sitOut(userId, sitOut);
    return sendJSON(res, result.success ? 200 : 400, result);
  } catch (err: unknown) {
    reportError(err, 'HTTP.sitout_error');
    return sendJSON(res, 500, { success: false, error: 'Invalid request body' });
  }
}
