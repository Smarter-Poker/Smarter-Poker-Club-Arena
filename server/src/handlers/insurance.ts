/**
 * Insurance handlers.
 *
 * `POST /insurance`           — Bible V8 §4.19: respond to insurance offer.
 * `GET  /insurance-preview`   — preview insurance cost for a coverage percentage.
 *
 * Extracted Phase U3.3 (2026-04-23). Byte-identical.
 */

import type { IncomingMessage, ServerResponse } from 'http';
import { sendJSON } from '../http/respond.js';
import { authenticateRequest } from '../http/auth.js';
import { readBody } from '../http/body.js';
import { reportError } from '../services/errorReporter.js';

export interface InsuranceDeps {
  gameServer: {
    getTableEngine(tableId: string):
      | {
          respondToInsurance(
            userId: string,
            response: string,
            coverage: number,
            declineForHand: boolean
          ): { success: boolean; [k: string]: unknown };
          previewInsurance(
            userId: string,
            coveragePercent: number
          ): Record<string, unknown> | null | undefined;
        }
      | null
      | undefined;
  };
}

/**
 * `POST /insurance` — accept or decline an all-in insurance offer.
 * Body: `{ tableId, response: 'accept' | 'decline', coveragePercent?: number, declineForHand?: boolean }`.
 * `coveragePercent` defaults to 100 (full insurance) if omitted.
 * `declineForHand`: true = "Decline for Hand" (never re-offer), false/omitted = "Decline Now" (may re-offer).
 */
export async function handleInsurance(
  req: IncomingMessage,
  res: ServerResponse,
  deps: InsuranceDeps
): Promise<void> {
  try {
    const auth = await authenticateRequest(req);
    if (!auth) {
      return sendJSON(res, 401, { success: false, error: 'Authentication required' });
    }

    const body = JSON.parse(await readBody(req));
    const { tableId, response, coveragePercent, declineForHand } = body;
    const userId = auth.userId;

    // EV CASHOUT 2026-08-28: 'cashout' locks pot x equity (minus fee) now.
    if (!tableId || !response || !['accept', 'decline', 'cashout'].includes(response)) {
      return sendJSON(res, 400, {
        success: false,
        error: 'Missing tableId or invalid response (must be accept, decline, or cashout)',
      });
    }

    if (
      response === 'accept' &&
      Object.prototype.hasOwnProperty.call(body, 'coveragePercent') &&
      (typeof coveragePercent !== 'number' || !Number.isFinite(coveragePercent))
    ) {
      return sendJSON(res, 400, { success: false, error: 'Invalid coveragePercent' });
    }

    const engine = deps.gameServer.getTableEngine(tableId);
    if (!engine) {
      return sendJSON(res, 404, { success: false, error: 'Table engine not found' });
    }

    const coverage = typeof coveragePercent === 'number' ? coveragePercent : 100;
    const forHand = declineForHand === true;
    const result = engine.respondToInsurance(userId, response, coverage, forHand);
    return sendJSON(res, result.success ? 200 : 400, result);
  } catch (err: unknown) {
    reportError(err, 'HTTP.insurance_error');
    return sendJSON(res, 500, { success: false, error: 'Invalid request body' });
  }
}

/**
 * `GET /insurance-preview?tableId=...&coveragePercent=...` — preview cost.
 */
export async function handleInsurancePreview(
  req: IncomingMessage,
  res: ServerResponse,
  deps: InsuranceDeps
): Promise<void> {
  try {
    const auth = await authenticateRequest(req);
    if (!auth) {
      return sendJSON(res, 401, { success: false, error: 'Authentication required' });
    }

    const params = new URL(req.url || '', `http://${req.headers.host}`).searchParams;
    const tableId = params.get('tableId');
    const coveragePercent = Number(params.get('coveragePercent') || 100);

    if (!tableId) {
      return sendJSON(res, 400, { success: false, error: 'Missing tableId' });
    }

    if (!Number.isFinite(coveragePercent)) {
      return sendJSON(res, 400, { success: false, error: 'Invalid coveragePercent' });
    }

    const engine = deps.gameServer.getTableEngine(tableId);
    if (!engine) {
      return sendJSON(res, 404, { success: false, error: 'Table engine not found' });
    }

    const preview = engine.previewInsurance(auth.userId, coveragePercent);
    if (!preview) {
      return sendJSON(res, 404, { success: false, error: 'No pending insurance offer' });
    }

    return sendJSON(res, 200, { success: true, ...preview });
  } catch (err: unknown) {
    reportError(err, 'HTTP.insurancepreview_error');
    return sendJSON(res, 500, { success: false, error: 'Server error' });
  }
}
