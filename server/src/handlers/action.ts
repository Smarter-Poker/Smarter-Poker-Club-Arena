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
import {
  actionFingerprint,
  isValidActionKey,
  lookupAction,
  rememberAction,
} from '../http/actionIdempotency.js';
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
 * Deliberately minimal — only the engine action method this path touches. If a
 * future change requires another method, extend the interface here rather
 * than importing `ServerTableEngine` directly (keeps handlers decoupled from
 * the engine's internals).
 */
export interface ActionEngine {
  handlePlayerAction(
    userId: string,
    action: string,
    amount?: number,
    actionContext?: string | null
  ): { success: boolean; [k: string]: unknown };
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
    const { tableId, action, amount, idempotencyKey, actionContext } = body;
    // Use authenticated userId from JWT, NOT from request body (prevents spoofing)
    const userId = auth.userId;

    if (!tableId || !action) {
      return sendJSON(res, 400, { success: false, error: 'Missing tableId or action' });
    }

    /* ── AN ACTION APPLIES ONCE (Phase 3, 2026-09-05) ────────────────────────
       The client stamps one key per intent and reuses it for every retry
       inside that intent (`GameServerAPI.submitAction`). See
       `http/actionIdempotency.ts` for why the key is in the body rather than
       a header, and why a rejection is remembered while a refusal is not.

       THE IDEMPOTENCY KEY REMAINS OPTIONAL: bundles from before this
       shipped are still served from the origin's additive pool and are
       posting actions right now with no key. Decision context is checked
       separately by the engine; an unversioned browser is asked to reload.

       BEFORE THE RATE LIMITER, DELIBERATELY. A replay is not a new action; a
       429 on one would send the client back round its ladder and end in "The
       table is busy" for an action that had already been accepted. */
    const hasKey = idempotencyKey !== undefined && idempotencyKey !== null;
    if (hasKey && !isValidActionKey(idempotencyKey)) {
      // Loudly, not silently: a client that thinks it has exactly-once
      // protection and does not is worse off than one that knows it has none.
      return sendJSON(res, 400, { success: false, error: 'Invalid action key' });
    }
    if (
      actionContext != null &&
      (typeof actionContext !== 'string' || actionContext.length > 200)
    ) {
      return sendJSON(res, 400, { success: false, error: 'Invalid action context' });
    }
    const fingerprint = hasKey ? actionFingerprint(action, amount, actionContext) : '';
    if (hasKey) {
      const seen = lookupAction(userId, tableId, idempotencyKey as string, fingerprint);
      if (seen.kind === 'replay') {
        return sendJSON(res, seen.status, { ...(seen.body as object), replayed: true });
      }
      if (seen.kind === 'conflict') {
        return sendJSON(res, 409, {
          success: false,
          error: 'This action was already submitted with different details',
        });
      }
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

    // The shared accepted-action boundary in the engine records processing.
    // HTTP retries and rejected requests must not create additional samples.
    const result = engine.handlePlayerAction(userId, action, amount, actionContext ?? null);

    // Old bundles only read JSON on HTTP 200. Deliver the reload instruction
    // in their understood envelope, always with success:false and no mutation.
    const status = result.success || result.code === 'ACTION_CONTEXT_REQUIRED' ? 200 : 400;
    /* Remembered ONLY here, on the one path where the action actually reached
       the engine. Everything above this line - 401, 404, 429 - means "not
       processed", and a retry of those must be free to run for real. There is
       no await between the lookup above and this call, which is what makes
       two simultaneous posts of one key impossible to both see 'fresh'. */
    if (hasKey) {
      rememberAction(userId, tableId, idempotencyKey as string, fingerprint, status, result);
    }
    return sendJSON(res, status, result);
  } catch (err: unknown) {
    reportError(err, 'HTTP.action_error');
    return sendJSON(res, 500, { success: false, error: 'Invalid request body' });
  }
}
