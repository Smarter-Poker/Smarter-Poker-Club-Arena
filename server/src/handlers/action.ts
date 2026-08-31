/**
 * `POST /action` — player action submission.
 *
 * Extracted from `server/src/index.ts` in Phase U3.2 (2026-04-23) as the first
 * state-mutating route of the index-monolith split. Behavior preserved
 * byte-identically — same auth, same rate-limit, same validation, same
 * success/error status codes, same telemetry hooks.
 *
 * Body: `{ tableId, action, amount? }`
 *
 * Bible V8 §1.3 Step 3 — JWT verified before any state touch. User ID comes
 * from the JWT, never from the request body (prevents spoofing).
 * Bible V8 §9.1.1 — action processing time instrumented (target < 50ms).
 * Bible V8 §9.3 — rate limited to 1 action per 250ms per player.
 */

import type { IncomingMessage, ServerResponse } from 'http';
import { sendJSON } from '../http/respond.js';
import { authenticateRequest } from '../http/auth.js';
import { readBody } from '../http/body.js';
import { checkRateLimit } from '../http/rateLimit.js';
import { reportError } from '../services/errorReporter.js';

/** Structural shape of the game server this handler needs. */
export interface ActionDeps {
  gameServer: {
    // `undefined` matches GameServer.getTableEngine's actual return type when the
    // engine is not found (Map.get returns undefined). Treat either nullish
    // value as "missing" — the handler uses truthiness below.
    getTableEngine(tableId: string): ActionEngine | null | undefined;
  };
}

/**
 * Structural shape of the per-table engine this handler needs.
 *
 * Deliberately minimal — only the two methods the action path touches. If a
 * future change requires another method, extend the interface here rather
 * than importing `ServerTableEngine` directly (keeps handlers decoupled from
 * the engine's internals).
 */
export interface ActionEngine {
  handlePlayerAction(
    userId: string,
    action: string,
    amount?: number
  ): { success: boolean; [k: string]: unknown };
  recordActionPerformance(userId: string, action: string, processingMs: number): void;
}

export async function handleAction(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ActionDeps
): Promise<void> {
  try {
    // Bible V8 §1.3 Step 3: Verify JWT before processing action
    const auth = await authenticateRequest(req);
    if (!auth) {
      return sendJSON(res, 401, { success: false, error: 'Authentication required' });
    }

    const body = JSON.parse(await readBody(req));
    const { tableId, action, amount } = body;
    // Use authenticated userId from JWT, NOT from request body (prevents spoofing)
    const userId = auth.userId;

    if (!tableId || !action) {
      return sendJSON(res, 400, { success: false, error: 'Missing tableId or action' });
    }

    // Bible V8 §9.3: Rate limiting — reject rapid-fire action submissions.
    // Keyed per user AND table (2026-08-19): a multi-tabling player acting at
    // two tables inside the window is normal play, not abuse. Validation of
    // tableId moved above this so the key is always complete.
    if (!checkRateLimit(userId, tableId)) {
      return sendJSON(res, 429, {
        success: false,
        error: 'Rate limited - wait before submitting another action',
      });
    }

    const engine = deps.gameServer.getTableEngine(tableId);
    if (!engine) {
      return sendJSON(res, 404, { success: false, error: 'Table engine not found' });
    }

    // Bible V8 §9.1.1: Instrument action processing time (target < 50ms)
    const actionStartMs = Date.now();
    const result = engine.handlePlayerAction(userId, action, amount);
    const actionProcessingMs = Date.now() - actionStartMs;
    // Record to telemetry (broadcast timing tracked inside engine)
    engine.recordActionPerformance(userId, action, actionProcessingMs);

    return sendJSON(res, result.success ? 200 : 400, result);
  } catch (err: unknown) {
    reportError(err, 'HTTP.action_error');
    return sendJSON(res, 500, { success: false, error: 'Invalid request body' });
  }
}
