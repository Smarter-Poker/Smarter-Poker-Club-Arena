/**
 * `POST /reject_rebuy` — player explicitly rejects a rebuy so the engine
 * can fast-forward the 5s rebuy pause.
 */

import type { IncomingMessage, ServerResponse } from 'http';
import { sendJSON } from '../http/respond.js';
import { authenticateRequest } from '../http/auth.js';
import { readBody } from '../http/body.js';
import { reportError } from '../services/errorReporter.js';

export interface RejectRebuyDeps {
  gameServer: {
    getTableEngine(tableId: string): { rejectRebuy(userId: string): void } | undefined;
  };
}

export async function handleRejectRebuy(
  req: IncomingMessage,
  res: ServerResponse,
  deps: RejectRebuyDeps
): Promise<void> {
  try {
    const user = await authenticateRequest(req);
    if (!user) {
      sendJSON(res, 401, { error: 'Unauthorized' });
      return;
    }

    const body = await readBody(req);
    const parsed = JSON.parse(body);
    const tableId = parsed.tableId;

    if (!tableId || typeof tableId !== 'string') {
      sendJSON(res, 400, { error: 'Invalid tableId' });
      return;
    }

    const engine = deps.gameServer.getTableEngine(tableId);
    if (engine && typeof engine.rejectRebuy === 'function') {
      engine.rejectRebuy(user.userId);
    }

    sendJSON(res, 200, { success: true });
  } catch (err: any) {
    reportError(err, 'API.reject_rebuy');
    sendJSON(res, 500, { error: 'Internal server error' });
  }
}
