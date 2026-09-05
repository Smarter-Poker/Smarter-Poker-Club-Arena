/**
 * POST /client-event — what the player's browser saw.
 *
 * Realtime programme Phase 2 (2026-09-05). The client reports its own
 * connection failures here: a socket closed, a watchdog teardown, an auth
 * refusal, the twenty-second auto-reload failsafe firing. Before this, all of
 * that lived and died inside the browser, which is why a 22-hour outage was
 * invisible to every dashboard the platform has.
 *
 * DESIGN RULES, all of them because this sits next to a live table:
 *
 *   - AUTHENTICATED, like every other player route. The user id comes from
 *     the verified token, never from the body: a client cannot report events
 *     "as" somebody else and cannot poison another player's reconnect count.
 *   - CHEAP AND SYNCHRONOUS. In-memory bookkeeping only, no database write
 *     and no await. A reconnect storm must not become a write storm on the
 *     one core the engine runs on.
 *   - 204, ALWAYS, for anything it accepts. The browser is told nothing it
 *     could act on, so a slow or failing telemetry path can never change what
 *     a player sees at the table.
 *   - UNAUTHENTICATED IS 401 AND NOTHING IS RECORDED, so this cannot be used
 *     as an anonymous write amplifier.
 */
import type { IncomingMessage, ServerResponse } from 'http';
import { authenticateRequest } from '../http/auth.js';
import {
  recordClientConnectionEvent,
  normalizeReason,
} from '../observability/ClientConnectionEvents.js';

export interface ClientEventDeps {
  authenticate?: (req: IncomingMessage) => Promise<{ userId: string } | null>;
  record?: typeof recordClientConnectionEvent;
}

export async function handleClientEvent(
  req: IncomingMessage,
  res: ServerResponse,
  body: Record<string, unknown> | null,
  deps: ClientEventDeps = {}
): Promise<void> {
  const authenticate = deps.authenticate ?? authenticateRequest;
  const record = deps.record ?? recordClientConnectionEvent;

  const auth = await authenticate(req);
  if (!auth) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: 'Authentication required' }));
    return;
  }

  record(auth.userId, normalizeReason(body?.reason));

  // No body: there is nothing the client should do differently either way.
  res.writeHead(204);
  res.end();
}
