/**
 * `POST /heartbeat` — Bible V8 §6.3: reset disconnect timer.
 *
 * Extracted Phase U3.3 (2026-04-23). Byte-identical.
 * Body: `{ tableId }`.
 */

import type { IncomingMessage, ServerResponse } from 'http';
import { sendJSON } from '../http/respond.js';
import { authenticateRequest } from '../http/auth.js';
import { readBody } from '../http/body.js';
import { reportError } from '../services/errorReporter.js';

export interface HeartbeatDeps {
  gameServer: {
    getTableEngine(tableId: string): { heartbeat(userId: string): unknown } | null | undefined;
  };
}

export async function handleHeartbeat(
  req: IncomingMessage,
  res: ServerResponse,
  deps: HeartbeatDeps
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

    const result = engine.heartbeat(userId);
    return sendJSON(res, 200, result);
  } catch (err: unknown) {
    reportError(err, 'HTTP.heartbeat_error');
    return sendJSON(res, 500, { success: false, error: 'Invalid request body' });
  }
}
