/**
 * `POST /rit` — Bible V8 §4.20: respond to Run It Twice offer.
 *
 * Extracted Phase U3.3 (2026-04-23). Byte-identical.
 * Body: `{ tableId, runs: 1|2|3 }` (chooser phase) or
 *       `{ tableId, response: 'accept' | 'decline' }` (responder phase).
 */

import type { IncomingMessage, ServerResponse } from 'http';
import { sendJSON } from '../http/respond.js';
import { authenticateRequest } from '../http/auth.js';
import { readBody } from '../http/body.js';
import { reportError } from '../services/errorReporter.js';

export interface RitDeps {
  gameServer: {
    getTableEngine(tableId: string):
      | {
          // Matches ServerTableEngine.respondToRIT's actual signature.
          respondToRIT(
            userId: string,
            response?: 'accept' | 'decline',
            runs?: 1 | 2 | 3
          ): { success: boolean; [k: string]: unknown };
        }
      | null
      | undefined;
  };
}

export async function handleRit(
  req: IncomingMessage,
  res: ServerResponse,
  deps: RitDeps
): Promise<void> {
  try {
    const auth = await authenticateRequest(req);
    if (!auth) {
      return sendJSON(res, 401, { success: false, error: 'Authentication required' });
    }

    const body = JSON.parse(await readBody(req));
    const { tableId, response, runs } = body;
    const userId = auth.userId;

    // WIRING FIX 2026-08-18: this handler REQUIRED `response`, but the
    // chooser phase of the client (GameServerAPI.respondToRIT) sends only
    // `{ tableId, runs }` - so a human chooser's 1/2/3 pick was 400'd at
    // the HTTP layer and no human could ever start a run-it-twice. Horse
    // responses bypass HTTP (in-engine), which masked it in live traffic.
    const runsNum = runs !== undefined ? Number(runs) : undefined;
    const validRuns = runsNum === 1 || runsNum === 2 || runsNum === 3;
    const validResponse = response === 'accept' || response === 'decline';

    if (!tableId || (!validRuns && !validResponse)) {
      return sendJSON(res, 400, {
        success: false,
        error: 'Missing tableId, and either runs (1|2|3) or response (accept|decline)',
      });
    }

    const engine = deps.gameServer.getTableEngine(tableId);
    if (!engine) {
      return sendJSON(res, 404, { success: false, error: 'Table engine not found' });
    }

    const result = engine.respondToRIT(
      userId,
      validResponse ? (response as 'accept' | 'decline') : undefined,
      validRuns ? (runsNum as 1 | 2 | 3) : undefined
    );
    return sendJSON(res, result.success ? 200 : 400, result);
  } catch (err: unknown) {
    reportError(err, 'HTTP.rit_error');
    return sendJSON(res, 500, { success: false, error: 'Invalid request body' });
  }
}
