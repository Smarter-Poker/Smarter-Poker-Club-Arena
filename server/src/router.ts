/**
 * HTTP request router for the Hetzner game server.
 *
 * Extracted from `server/src/index.ts` in Phase U3.4 (2026-04-23). Returns
 * a request listener compatible with `http.createServer(listener)`.
 * Every route dispatches to a handler in `./handlers/*` — this module owns
 * URL/method matching only, never business logic.
 *
 * The router is a factory (`createRouter(deps) -> requestListener`) rather
 * than a plain function so that the `gameServer`, `tableStateHub`, and
 * `engineWs` singletons can be injected from `index.ts` at bootstrap.
 * Handlers each declare the bits of those singletons they actually touch;
 * this router accepts the union shape and trusts the handler-level checks.
 */

import type { IncomingMessage, ServerResponse } from 'http';
import { sendJSON, CORS_HEADERS } from './http/respond.js';
import { handleHealth, handleWsMetrics, handleMetrics } from './handlers/health.js';
import { handleAction } from './handlers/action.js';
import { handleTimebank } from './handlers/timebank.js';
import { handleHeartbeat } from './handlers/heartbeat.js';
import { handlePreaction } from './handlers/preaction.js';
import { handleAddchips } from './handlers/addchips.js';
import { handleLeave } from './handlers/leave.js';
import { handleSitout } from './handlers/sitout.js';
import { handleStraddle } from './handlers/straddle.js';
import { handleRit } from './handlers/rit.js';
import { handleInsurance, handleInsurancePreview } from './handlers/insurance.js';
import { handleShowhand } from './handlers/showhand.js';
import { handleDiscard } from './handlers/discard.js';
import { handleAdminPause, handleAdminResume } from './handlers/admin.js';
import { handlePostBB } from './handlers/postbb.js';
import { handleGetActions, handleGetState } from './handlers/state.js';

/**
 * Structural shape the router needs.
 *
 * `gameServer` is typed as the union of every per-handler `gameServer` shape
 * so that a concrete `GameServer` instance from `index.ts` (which satisfies
 * all of them) plugs in directly. Each handler re-checks the specific methods
 * it uses at the call site via its own structural `*Deps` interface.
 */
type AnyGameServer = Parameters<typeof handleAction>[2]['gameServer'] &
  Parameters<typeof handleTimebank>[2]['gameServer'] &
  Parameters<typeof handleHeartbeat>[2]['gameServer'] &
  Parameters<typeof handlePreaction>[2]['gameServer'] &
  Parameters<typeof handleAddchips>[2]['gameServer'] &
  Parameters<typeof handleLeave>[2]['gameServer'] &
  Parameters<typeof handleSitout>[2]['gameServer'] &
  Parameters<typeof handleStraddle>[2]['gameServer'] &
  Parameters<typeof handleRit>[2]['gameServer'] &
  Parameters<typeof handleInsurance>[2]['gameServer'] &
  Parameters<typeof handleShowhand>[2]['gameServer'] &
  Parameters<typeof handleDiscard>[2]['gameServer'] &
  Parameters<typeof handleAdminPause>[2]['gameServer'] &
  Parameters<typeof handlePostBB>[2]['gameServer'] &
  Parameters<typeof handleGetActions>[3]['gameServer'] &
  Parameters<typeof handleGetState>[3]['gameServer'] &
  Parameters<typeof handleHealth>[1]['gameServer'] &
  Parameters<typeof handleMetrics>[1]['gameServer'];

export interface RouterDeps {
  gameServer: AnyGameServer;
  tableStateHub: { totalSubscribers(): number };
  engineWs: { connectionCount(): number };
}

/**
 * Build the request listener. Deps are captured by closure so each request
 * sees the same singletons without module-level global state.
 */
export function createRouter(
  deps: RouterDeps
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const { gameServer, tableStateHub, engineWs } = deps;

  return async (req, res) => {
    const method = req.method || 'GET';
    const url = req.url || '/';

    // Handle CORS preflight
    if (method === 'OPTIONS') {
      res.writeHead(204, CORS_HEADERS);
      res.end();
      return;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Telemetry routes — handlers/health.ts (Phase U3.1).
    // ─────────────────────────────────────────────────────────────────────────
    if (url === '/health' || url === '/') return handleHealth(res, { gameServer });
    if (url === '/ws-metrics' && method === 'GET')
      return handleWsMetrics(res, { tableStateHub, engineWs });
    if (url === '/metrics' && method === 'GET') return handleMetrics(res, { gameServer });

    // ─────────────────────────────────────────────────────────────────────────
    // State-mutating routes — handlers/*.ts (Phase U3.2 + U3.3).
    // ─────────────────────────────────────────────────────────────────────────
    if (method === 'POST' && url === '/action') return handleAction(req, res, { gameServer });
    if (method === 'POST' && url === '/timebank') return handleTimebank(req, res, { gameServer });
    if (method === 'POST' && url === '/heartbeat') return handleHeartbeat(req, res, { gameServer });
    if (method === 'POST' && url === '/preaction') return handlePreaction(req, res, { gameServer });
    if (method === 'POST' && url === '/addchips') return handleAddchips(req, res, { gameServer });
    if (method === 'POST' && url === '/leave') return handleLeave(req, res, { gameServer });
    if (method === 'POST' && url === '/sitout') return handleSitout(req, res, { gameServer });
    if (method === 'POST' && url === '/straddle') return handleStraddle(req, res, { gameServer });
    if (method === 'POST' && url === '/rit') return handleRit(req, res, { gameServer });
    if (method === 'POST' && url === '/insurance') return handleInsurance(req, res, { gameServer });
    if (method === 'POST' && url === '/showhand') return handleShowhand(req, res, { gameServer });
    if (method === 'POST' && url === '/discard') return handleDiscard(req, res, { gameServer });
    if (method === 'POST' && url === '/admin/pause')
      return handleAdminPause(req, res, { gameServer });
    if (method === 'POST' && url === '/admin/resume')
      return handleAdminResume(req, res, { gameServer });
    if (method === 'POST' && url === '/post-bb') return handlePostBB(req, res, { gameServer });

    if (method === 'GET' && url?.startsWith('/insurance-preview')) {
      return handleInsurancePreview(req, res, { gameServer });
    }

    // Regex-matched GETs (path parameters).
    const actionsMatch = url.match(/^\/actions\/([^/]+)\/([^/]+)$/);
    if (method === 'GET' && actionsMatch) {
      return handleGetActions(req, res, actionsMatch[1], { gameServer });
    }

    const stateMatch = url.match(/^\/state\/([^/]+)$/);
    if (method === 'GET' && stateMatch) {
      return handleGetState(req, res, stateMatch[1], { gameServer });
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 404 — Not Found
    // ─────────────────────────────────────────────────────────────────────────
    sendJSON(res, 404, { error: 'Not Found' });
  };
}
