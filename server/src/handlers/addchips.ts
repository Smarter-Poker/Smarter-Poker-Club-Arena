/**
 * `POST /addchips` — player bought chips (top-up stack).
 *
 * Extracted Phase U3.3 (2026-04-23). Byte-identical.
 * Body: `{ tableId, amount }`.
 */

import type { IncomingMessage, ServerResponse } from 'http';
import { sendJSON } from '../http/respond.js';
import { authenticateRequest } from '../http/auth.js';
import { readBody } from '../http/body.js';
import { reportError } from '../services/errorReporter.js';

export interface AddchipsDeps {
  gameServer: {
    getTableEngine(tableId: string):
      | {
          addChips(
            userId: string,
            amount: number,
            opId?: string
          ):
            | { success: boolean; [k: string]: unknown }
            | Promise<{ success: boolean; [k: string]: unknown }>;
        }
      | null
      | undefined;
  };
}

export async function handleAddchips(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AddchipsDeps
): Promise<void> {
  try {
    const auth = await authenticateRequest(req);
    if (!auth) {
      return sendJSON(res, 401, { success: false, error: 'Authentication required' });
    }

    const body = JSON.parse(await readBody(req));
    const { tableId, amount } = body;
    const userId = auth.userId;
    /* Cashier audit 2026-08-27 (P0-1): the client's per-attempt id, held
       across its retries, so a re-sent request after a lost response lands
       on the SAME idempotency key instead of a fresh debit. Optional (the
       horse rotator has no HTTP retry problem) and strictly validated — it
       becomes part of a DB idempotency key. */
    const rawOpId = body.opId;
    if (
      Object.prototype.hasOwnProperty.call(body, 'opId') &&
      (typeof rawOpId !== 'string' || !/^[A-Za-z0-9-]{8,64}$/.test(rawOpId))
    ) {
      return sendJSON(res, 400, { success: false, error: 'Invalid opId' });
    }
    const opId: string | undefined = rawOpId;

    // 2026-08-27: `!amount || amount <= 0` alone lets a non-numeric string
    // through - `!"abc"` is false and `"abc" <= 0` is false - so a garbage body
    // reached the engine with a non-number. showhand.ts already validates this
    // way; the two chip endpoints did not.
    if (!tableId || typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
      return sendJSON(res, 400, { success: false, error: 'Missing tableId or invalid amount' });
    }
    /* AND IT IS A CHIP AMOUNT, TO THE CENT (2026-09-09). The client computes
       this as `Math.min(maxBuyIn - stack, balance)` in three places, which is
       a float subtraction (200 - 133.33 = 66.66999999999999). It reached
       `atomic_table_addon`, which stores it verbatim in
       `table_pending_addons.amount`, and `resolve_pending_addon` can then
       never produce a receipt where applied + refunded equals it - which the
       post-commit obligation refuses, deterministically, so the table stops
       dealing. The engine rounds too; this is the boundary, where a bad
       amount is a 400 the caller can see rather than a silent correction. */
    if (Math.round(amount * 100) / 100 !== amount) {
      return sendJSON(res, 400, {
        success: false,
        error: 'Chip amounts are limited to two decimal places',
      });
    }

    const engine = deps.gameServer.getTableEngine(tableId);
    if (!engine) {
      return sendJSON(res, 404, { success: false, error: 'Table engine not found' });
    }

    const result = await engine.addChips(userId, amount, opId);
    return sendJSON(res, result.success ? 200 : 400, result);
  } catch (err: unknown) {
    reportError(err, 'HTTP.addchips_error');
    return sendJSON(res, 500, { success: false, error: 'Failed to add chips' });
  }
}
