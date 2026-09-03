/**
 * `POST /post-bb` — Bible V8 §4.2: post BB to enter immediately (no wait-for-BB).
 *
 * Extracted Phase U3.3 (2026-04-23). Byte-identical.
 * Body: `{ tableId }`.
 */

import type { IncomingMessage, ServerResponse } from 'http';
import { sendJSON } from '../http/respond.js';
import { authenticateRequest } from '../http/auth.js';
import { readBody } from '../http/body.js';
import { reportError } from '../services/errorReporter.js';

export interface PostBBDeps {
  gameServer: {
    getTableEngine(tableId: string):
      | {
          postBBToEnter(userId: string): unknown;
        }
      | null
      | undefined;
  };
}

export async function handlePostBB(
  req: IncomingMessage,
  res: ServerResponse,
  deps: PostBBDeps
): Promise<void> {
  try {
    const auth = await authenticateRequest(req);
    if (!auth) return sendJSON(res, 401, { success: false, error: 'Authentication required' });
    const body = JSON.parse(await readBody(req));
    const engine = deps.gameServer.getTableEngine(body.tableId);
    if (!engine) return sendJSON(res, 404, { success: false, error: 'Table engine not found' });
    return sendJSON(res, 200, engine.postBBToEnter(auth.userId));
  } catch (err: unknown) {
    reportError(err, 'HTTP.post_bb_error');
    return sendJSON(res, 500, { success: false, error: 'Invalid request body' });
  }
}
