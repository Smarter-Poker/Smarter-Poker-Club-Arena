/**
 * GET handlers — regex-matched table/actions/state routes.
 *
 * `GET /actions/:tableId/:userId` — available actions for a player.
 * `GET /state/:tableId`           — Bible V8 §2.4: current scrubbed state.
 *
 * Extracted Phase U3.3 (2026-04-23). Byte-identical. These are the non-POST
 * handlers that use path-parameter matching in the router — dispatch passes
 * in the already-matched tableId so handlers stay free of URL parsing.
 */

import type { IncomingMessage, ServerResponse } from 'http';
import { sendJSON } from '../http/respond.js';
import { authenticateRequest } from '../http/auth.js';

export interface StateDeps {
  gameServer: {
    getTableEngine(tableId: string):
      | {
          getPlayerActions(userId: string): unknown;
          getTableState(userId: string): unknown;
        }
      | null
      | undefined;
  };
}

export async function handleGetActions(
  req: IncomingMessage,
  res: ServerResponse,
  tableId: string,
  deps: StateDeps
): Promise<void> {
  const auth = await authenticateRequest(req);
  if (!auth) {
    return sendJSON(res, 401, { canAct: false, error: 'Authentication required' });
  }

  // Use authenticated userId, ignore URL param to prevent info leakage
  const userId = auth.userId;

  const engine = deps.gameServer.getTableEngine(tableId);
  if (!engine) {
    return sendJSON(res, 404, { canAct: false, error: 'Table engine not found' });
  }

  const actions = engine.getPlayerActions(userId);
  return sendJSON(res, 200, actions);
}

export async function handleGetState(
  req: IncomingMessage,
  res: ServerResponse,
  tableId: string,
  deps: StateDeps
): Promise<void> {
  const auth = await authenticateRequest(req);
  if (!auth) {
    return sendJSON(res, 401, { success: false, error: 'Authentication required' });
  }

  const engine = deps.gameServer.getTableEngine(tableId);
  if (!engine) {
    return sendJSON(res, 404, { success: false, error: 'Table engine not found' });
  }

  const state = engine.getTableState(auth.userId);
  if (!state) {
    return sendJSON(res, 200, { table_id: tableId, stage: 'idle', players: [] });
  }

  return sendJSON(res, 200, state);
}
