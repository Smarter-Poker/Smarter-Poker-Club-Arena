/**
 * `POST /rabbit-hunt` — buy a look at the cards that would have come.
 *
 * Dan 2026-08-25. Body: `{ tableId, handNumber? }` (userId from the JWT).
 *
 * THIS ENDPOINT IS THE PAYWALL. It exists because there wasn't one.
 *
 * Rabbit hunt used to work like this: when a hand ended early the engine put
 * the five remaining cards into a room-wide `rabbit_hunt_available` broadcast,
 * and every socket at the table received them in cleartext before anyone had
 * paid. The client then decided for itself whether to bill. So the cards were
 * free to anyone reading the websocket, visible to opponents who had not asked
 * for them, and the "5 diamonds" price was a suggestion.
 *
 * Now the broadcast carries availability only, and the cards live on the engine
 * until a player asks for them through here — authenticated, charged, and
 * returned in the response body to that one caller. No other client sees them.
 *
 * The engine does the deciding (`revealRabbitHunt`); this file only carries the
 * request to it, exactly like `timebank.ts`, so the eligibility and billing
 * rules stay in one place instead of being half-enforced at the edge.
 */

import type { IncomingMessage, ServerResponse } from 'http';
import { sendJSON } from '../http/respond.js';
import { authenticateRequest } from '../http/auth.js';
import { readBody } from '../http/body.js';
import { reportError } from '../services/errorReporter.js';

export interface RabbitHuntDeps {
  gameServer: {
    getTableEngine(tableId: string):
      | {
          revealRabbitHunt(
            userId: string,
            handNumber?: number
          ): Promise<{ success: boolean; [k: string]: unknown }>;
        }
      | null
      | undefined;
  };
}

export async function handleRabbitHunt(
  req: IncomingMessage,
  res: ServerResponse,
  deps: RabbitHuntDeps
): Promise<void> {
  try {
    const auth = await authenticateRequest(req);
    if (!auth) {
      return sendJSON(res, 401, { success: false, error: 'Authentication required' });
    }

    const body = JSON.parse(await readBody(req));
    const { tableId, handNumber } = body;
    const userId = auth.userId;

    if (!tableId) {
      return sendJSON(res, 400, { success: false, error: 'Missing tableId' });
    }

    const engine = deps.gameServer.getTableEngine(tableId);
    if (!engine) {
      return sendJSON(res, 404, { success: false, error: 'Table Not Ready' });
    }

    // handNumber is advisory: a player who clicks as the next hand begins still
    // gets the hand they were looking at. The engine keeps the last two and
    // refuses anything older, so this cannot be walked backwards to buy a
    // history of run-outs.
    const hand = Number.isFinite(Number(handNumber)) ? Number(handNumber) : undefined;

    // The engine call gets its OWN try. Folding it into the outer one meant a
    // server-side fault — a Supabase client blowing up, a null tableInfo — was
    // answered with "Invalid request body", and the client toasts that verbatim,
    // so the player was told their own request was malformed when the fault was
    // entirely ours.
    try {
      const result = await engine.revealRabbitHunt(userId, hand);
      return sendJSON(res, result.success ? 200 : 400, result);
    } catch (err: unknown) {
      reportError(err, 'HTTP.rabbithunt_reveal_error');
      return sendJSON(res, 500, { success: false, error: 'Rabbit Hunt Is Unavailable Right Now' });
    }
  } catch (err: unknown) {
    reportError(err, 'HTTP.rabbithunt_error');
    return sendJSON(res, 400, { success: false, error: 'Invalid request body' });
  }
}
