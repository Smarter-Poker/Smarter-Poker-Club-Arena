/**
 * Retired POST /leave contract. A table id cannot identify which occupancy
 * a delayed request intended to cash out. Clients must reload and use the
 * authenticated /leave-occupancy route; there is no browser cleanup handoff.
 */

import type { IncomingMessage, ServerResponse } from 'http';
import { sendJSON } from '../http/respond.js';
import { authenticateRequest } from '../http/auth.js';
import { readBody } from '../http/body.js';
import { reportError } from '../services/errorReporter.js';

export interface LeaveDeps {
  gameServer: {
    getTableEngine(tableId: string):
      | {
          leaveTable(
            userId: string
          ):
            | { success: boolean; [k: string]: unknown }
            | Promise<{ success: boolean; [k: string]: unknown }>;
        }
      | null
      | undefined;
  };
}

export async function handleLeave(
  req: IncomingMessage,
  res: ServerResponse,
  _deps: LeaveDeps
): Promise<void> {
  try {
    const auth = await authenticateRequest(req);
    if (!auth) {
      return sendJSON(res, 401, { success: false, error: 'Authentication required' });
    }

    const body = JSON.parse(await readBody(req));
    const { tableId } = body;

    if (!tableId) {
      return sendJSON(res, 400, { success: false, error: 'Missing tableId' });
    }

    // HTTP 200 keeps older clients on their structured success:false path.
    // Never acknowledge a cashout or authorize direct database cleanup.
    return sendJSON(res, 200, {
      success: false,
      code: 'SEAT_OCCUPANCY_REQUIRED',
      error: 'Reload the table before leaving.',
      reloadRequired: true,
    });
  } catch (err: unknown) {
    reportError(err, 'HTTP.leave_error');
    return sendJSON(res, 500, { success: false, error: 'Failed to leave table' });
  }
}
