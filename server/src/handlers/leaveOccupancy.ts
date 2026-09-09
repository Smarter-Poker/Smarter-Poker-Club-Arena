import type { IncomingMessage, ServerResponse } from 'http';
import { sendJSON } from '../http/respond.js';
import { authenticateRequest } from '../http/auth.js';
import { readBody } from '../http/body.js';
import { reportError } from '../services/errorReporter.js';
import { getSeatCashoutReceipt } from '../services/supabase/seats.js';

export interface LeaveOccupancyDeps {
  gameServer: {
    getTableEngine(tableId: string):
      | {
          leaveTable(
            userId: string,
            opts: { occupancyId: string; seatNumber: number }
          ): Promise<{
            success: boolean;
            immediate: boolean;
            code?: string;
            tournament?: boolean;
            error?: string;
            stay_remaining_ms?: number;
          }>;
        }
      | null
      | undefined;
  };
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Separate URL: an older engine must not silently ignore the occupancy contract. */
export async function handleLeaveOccupancy(
  req: IncomingMessage,
  res: ServerResponse,
  deps: LeaveOccupancyDeps
): Promise<void> {
  try {
    const auth = await authenticateRequest(req);
    if (!auth) return sendJSON(res, 401, { success: false, error: 'Authentication required' });
    let body: unknown;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      return sendJSON(res, 400, { success: false, error: 'Invalid leave request' });
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return sendJSON(res, 400, { success: false, error: 'Invalid leave request' });
    }
    const { tableId, occupancyId, seatNumber } = body as Record<string, unknown>;
    if (
      typeof tableId !== 'string' ||
      !UUID.test(tableId) ||
      typeof occupancyId !== 'string' ||
      !UUID.test(occupancyId) ||
      typeof seatNumber !== 'number' ||
      !Number.isInteger(seatNumber) ||
      seatNumber < 0
    ) {
      return sendJSON(res, 400, { success: false, error: 'Original seat identity required' });
    }
    const envelope = { protocol: 'seat-occupancy-v1', occupancyId, seatNumber };
    const original = await getSeatCashoutReceipt(auth.userId, tableId, seatNumber, occupancyId);
    if (original)
      return sendJSON(res, 200, {
        ...envelope,
        success: true,
        immediate: true,
        cashout: original,
      });
    const engine = deps.gameServer.getTableEngine(tableId);
    if (!engine)
      return sendJSON(res, 503, {
        ...envelope,
        success: false,
        error: 'The Table Is Temporarily Unavailable. Please Try Again.',
      });
    const result = await engine.leaveTable(auth.userId, { occupancyId, seatNumber });
    if (!result.success)
      return sendJSON(
        res,
        result.code === 'LEAVE_LOCKED' ? 200 : result.code === 'STALE_OCCUPANCY' ? 409 : 400,
        { ...result, ...envelope }
      );
    if (!result.immediate || result.tournament)
      return sendJSON(res, 200, {
        ...result,
        ...envelope,
        cashout: null,
      });
    const receipt = await getSeatCashoutReceipt(auth.userId, tableId, seatNumber, occupancyId);
    if (!receipt)
      return sendJSON(res, 503, {
        ...envelope,
        success: false,
        error: 'The Cashout Was Not Confirmed. Please Try Again.',
      });
    return sendJSON(res, 200, { ...envelope, success: true, immediate: true, cashout: receipt });
  } catch (error) {
    reportError(error, 'HTTP.leave_occupancy');
    return sendJSON(res, 503, {
      success: false,
      error: 'The Cashout Was Not Confirmed. Please Try Again.',
    });
  }
}
