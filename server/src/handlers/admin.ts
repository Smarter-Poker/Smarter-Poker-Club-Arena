/**
 * Admin handlers — Bible V8 §6.17: pause / resume table dealing.
 *
 * Extracted Phase U3.3 (2026-04-23). Byte-identical.
 *
 * `POST /admin/pause`  — Body: `{ tableId, reason? }`
 * `POST /admin/resume` — Body: `{ tableId }`
 */

import type { IncomingMessage, ServerResponse } from 'http';
import { sendJSON } from '../http/respond.js';
import { authenticateRequest } from '../http/auth.js';
import { readBody } from '../http/body.js';
import { reportError } from '../services/errorReporter.js';

export interface AdminDeps {
  gameServer: {
    getTableEngine(tableId: string):
      | {
          adminPause(reason?: string): unknown;
          adminResume(): unknown;
        }
      | null
      | undefined;
  };
}

export async function handleAdminPause(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AdminDeps
): Promise<void> {
  try {
    const auth = await authenticateRequest(req);
    if (!auth) return sendJSON(res, 401, { success: false, error: 'Authentication required' });
    const body = JSON.parse(await readBody(req));
    const engine = deps.gameServer.getTableEngine(body.tableId);
    if (!engine) return sendJSON(res, 404, { success: false, error: 'Table engine not found' });
    return sendJSON(res, 200, engine.adminPause(body.reason));
  } catch (err: unknown) {
    reportError(err, 'HTTP.admin_pause_error');
    return sendJSON(res, 500, { success: false, error: 'Invalid request body' });
  }
}

export async function handleAdminResume(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AdminDeps
): Promise<void> {
  try {
    const auth = await authenticateRequest(req);
    if (!auth) return sendJSON(res, 401, { success: false, error: 'Authentication required' });
    const body = JSON.parse(await readBody(req));
    const engine = deps.gameServer.getTableEngine(body.tableId);
    if (!engine) return sendJSON(res, 404, { success: false, error: 'Table engine not found' });
    return sendJSON(res, 200, engine.adminResume());
  } catch (err: unknown) {
    reportError(err, 'HTTP.admin_resume_error');
    return sendJSON(res, 500, { success: false, error: 'Invalid request body' });
  }
}
