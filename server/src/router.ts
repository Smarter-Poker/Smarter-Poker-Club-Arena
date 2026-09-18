import { handleAdminKickOccupancy } from './handlers/admin.js';
/**
 * HTTP request router for the Hetzner game server.
 *
 * Extracted from `server/src/index.ts` in Phase U3.4 (2026-04-23). Returns
 * a request listener compatible with `http.createServer(listener)`.\
 * Every route dispatches to a handler in `./handlers/*` — this module owns
 * URL/method matching only, never business logic.
 *
 * The router is a factory (`createRouter(deps) -> requestListener`) rather
 * than a plain function so that the `gameServer`, `tableStateHub`,
 * `engineWs`, and `channelHub` singletons can be injected from `index.ts`
 * at bootstrap. Handlers each declare the bits of those singletons they
 * actually touch; this router accepts the union shape and trusts the
 * handler-level checks.
 *
 * Phase U4 (2026-05-18): added three server-side broadcast routes:
 *   POST /channels/club/:clubId/event
 *   POST /channels/tournament/:tournamentId/event
 *   POST /channels/lobby/update
 * These are called from the World Hub / admin to push events to connected
 * clients. They require `Authorization: Bearer <INTERNAL_API_KEY>`.
 */

import type { IncomingMessage, ServerResponse } from 'http';
import type { GameServer } from './GameServer.js';
import { sendJSON, CORS_HEADERS } from './http/respond.js';
import { handleHealth, handleWsMetrics, handleMetrics } from './handlers/health.js';
import { handleStableHand } from './handlers/stableHand.js';
import { handleAction } from './handlers/action.js';
import { handleTimebank } from './handlers/timebank.js';
import { handleRabbitHunt } from './handlers/rabbithunt.js';
import { handleHeartbeat } from './handlers/heartbeat.js';
import { handleClientEvent } from './handlers/clientEvent.js';
import { handleAway } from './handlers/away.js';
import { handlePreaction } from './handlers/preaction.js';
import { handleAddchips } from './handlers/addchips.js';
import { handleLeave } from './handlers/leave.js';
import { handleLeaveOccupancy } from './handlers/leaveOccupancy.js';
import { handleRejectRebuy } from './handlers/reject_rebuy.js';
import { handleSitout } from './handlers/sitout.js';
import { handleStraddle } from './handlers/straddle.js';
import { handleRit } from './handlers/rit.js';
import { handleInsurance, handleInsurancePreview } from './handlers/insurance.js';
import { handleShowhand } from './handlers/showhand.js';
import { handleDiscard } from './handlers/discard.js';
import { handleAdminPause, handleAdminResume, handleAdminKick } from './handlers/admin.js';
import { handlePostBB } from './handlers/postbb.js';
import { handleInjectFault } from './handlers/faultInjection.js';
import { handleGetActions, handleGetState } from './handlers/state.js';
import { handleVoiceIce } from './handlers/voice.js';
import type { ChannelHub } from './hub/ChannelHub.js';

// ─── Internal API key (set in Hetzner env, same secret used by World Hub) ─────

const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || '';

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
  Parameters<typeof handleRejectRebuy>[2]['gameServer'] &
  Parameters<typeof handleRabbitHunt>[2]['gameServer'] &
  Parameters<typeof handleHeartbeat>[2]['gameServer'] &
  Parameters<typeof handleAway>[2]['gameServer'] &
  Parameters<typeof handlePreaction>[2]['gameServer'] &
  Parameters<typeof handleAddchips>[2]['gameServer'] &
  Parameters<typeof handleLeave>[2]['gameServer'] &
  Parameters<typeof handleLeaveOccupancy>[2]['gameServer'] &
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
  Parameters<typeof handleMetrics>[1]['gameServer'] & {
    getTournamentLifecycleDiagnostic?: GameServer['getTournamentLifecycleDiagnostic'];
    requestMaintenanceRecoveryWindow?: GameServer['requestMaintenanceRecoveryWindow'];
  };

export interface RouterDeps {
  gameServer: AnyGameServer;
  tableStateHub: { totalSubscribers(): number };
  engineWs: { connectionCount(): number };
  channelHub: ChannelHub;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Read and JSON-parse the request body. Returns null on parse failure or if
 * the body exceeds MAX_BODY_BYTES.
 */
const MAX_BODY_BYTES = 64 * 1024;

async function readBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;

    req.on('data', (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > MAX_BODY_BYTES) {
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(JSON.parse(raw) as Record<string, unknown>);
      } catch {
        resolve(null);
      }
    });

    req.on('error', () => resolve(null));
  });
}

/**
 * Verify the Authorization: Bearer <token> header against INTERNAL_API_KEY.
 * Returns true if valid, false otherwise.
 */
function verifyInternalKey(req: IncomingMessage): boolean {
  if (!INTERNAL_API_KEY) {
    // If the key is not configured, reject all requests to these routes.
    console.warn('[Router] INTERNAL_API_KEY is not set - rejecting channel broadcast request');
    return false;
  }
  const auth = req.headers['authorization'];
  if (typeof auth !== 'string') return false;
  const parts = auth.split(' ');
  if (parts.length !== 2 || parts[0]?.toLowerCase() !== 'bearer') return false;
  return parts[1] === INTERNAL_API_KEY;
}

const DIAGNOSTIC_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DIAGNOSTIC_MAX_BYTES = 64 * 1024;
// Fixed wire fields: never enumerate arbitrary objects or invoke toJSON/accessors.
const DIAGNOSTIC_WIRE_KEYS = [
  'custody',
  'coverage',
  'active',
  'archivedCount',
  'archivedScanned',
  'archivedTruncated',
  'packets',
  'originGeneration',
  'role',
  'originalsUnavailable',
  'schema',
  'diagnosticOnly',
  'tournamentId',
  'observedAtMs',
  'observedMonotonicMs',
  'pid',
  'gameServerInitializedAtMs',
  'hostIdentityCoverage',
  'currentManagerPresent',
  'expectedIdentityMatch',
  'releaseBarrierPresent',
  'pendingLeaseGeneration',
  'retirementIndexCoverage',
  'retirementOperationsCount',
  'retirementEntriesScanned',
  'retirementScanTruncated',
  'ownersObservedCountLowerBound',
  'ownersOmitted',
  'unavailableOwners',
  'diagnosticIndexFailures',
  'releaseDiagnosticFailures',
  'owners',
  'roles',
  'snapshot',
  'scheduler',
  'missingMeans',
  'activeEntriesCount',
  'activeEntriesScanned',
  'activeScanTruncated',
  'matchingEntriesCountLowerBound',
  'entries',
  'registrationId',
  'managerInstanceId',
  'leaseGeneration',
  'operationId',
  'operationCorrelation',
  'currentRegistration',
  'registered',
  'running',
  'warned',
  'queuedAs',
  'dirtyAs',
  'queueTicket',
  'enqueuedAt',
  'pendingWakeAt',
  'pendingWakeAs',
  'abortRequested',
  'ownerAvailability',
  'instanceId',
  'lastSequence',
  'droppedRecords',
  'records',
  'diagnosticWriteFailures',
  'proofDeadlineMonotonicMs',
  'authorityExpired',
  'stopPending',
  'schedulerPendingCount',
  'lifecyclePendingCount',
  'schedulerRecent',
  'schedulerListTruncated',
  'originals',
  'originalSelection',
  'originalsCount',
  'retainedOriginalCount',
  'originalsReturned',
  'originalsOmitted',
  'selectionMissingCount',
  'originalsTruncated',
  'leaseRelease',
  'tableId',
  'availability',
  'engine',
  'session',
  'sessionCoverage',
  'leaseAuthorityExpired',
  'terminal',
  'stopInitiated',
  'retainedWork',
  'dealingLoop',
  'settlements',
  'postHandTasks',
  'tournamentMoves',
  'readContinuations',
  'readContinuationCoverage',
  'leaseReleaseAck',
  'sequence',
  'event',
  'attempt',
  'writerKind',
  'outcome',
  'leaseStatus',
  'releasedCount',
  'reason',
  'status',
  'attempts',
] as const;

function serializeTournamentDiagnostic(
  value: ReturnType<GameServer['getTournamentLifecycleDiagnostic']>
): string {
  const chunks: string[] = [];
  const ancestors = new Set<object>();
  let bytes = 0;
  let nodes = 0;
  const emit = (text: string): void => {
    bytes += Buffer.byteLength(text, 'utf8');
    if (bytes > DIAGNOSTIC_MAX_BYTES) throw new Error('diagnostic_evidence_limit');
    chunks.push(text);
  };
  const visit = (item: unknown, depth: number): void => {
    if (++nodes > 8192 || depth > 12) throw new Error('diagnostic_evidence_limit');
    if (item === null) {
      emit('null');
      return;
    }
    if (typeof item === 'boolean') {
      emit(item ? 'true' : 'false');
      return;
    }
    if (typeof item === 'number' && Number.isFinite(item)) {
      emit(String(item));
      return;
    }
    if (typeof item === 'string' && item.length <= 256) {
      emit(JSON.stringify(item));
      return;
    }
    if (!item || typeof item !== 'object' || ancestors.has(item))
      throw new Error('invalid_diagnostic_evidence');
    const array = Array.isArray(item);
    const prototype = Object.getPrototypeOf(item);
    if (prototype !== (array ? Array.prototype : Object.prototype) && prototype !== null) {
      throw new Error('invalid_diagnostic_evidence');
    }
    ancestors.add(item);
    if (array) {
      const length = Object.getOwnPropertyDescriptor(item, 'length');
      if (
        !length ||
        !('value' in length) ||
        !Number.isSafeInteger(length.value) ||
        length.value < 0 ||
        length.value > 64
      )
        throw new Error('diagnostic_evidence_limit');
      emit('[');
      for (let i = 0; i < length.value; i++) {
        const field = Object.getOwnPropertyDescriptor(item, String(i));
        if (!field || !('value' in field)) throw new Error('invalid_diagnostic_evidence');
        if (i) emit(',');
        visit(field.value, depth + 1);
      }
      emit(']');
    } else {
      emit('{');
      let fields = 0;
      for (const key of DIAGNOSTIC_WIRE_KEYS) {
        const field = Object.getOwnPropertyDescriptor(item, key);
        if (!field) continue;
        if (!('value' in field)) throw new Error('invalid_diagnostic_evidence');
        // Existing lifecycle records intentionally have absent optional fields.
        if (field.value === undefined) continue;
        if (fields++) emit(',');
        emit(JSON.stringify(key) + ':');
        visit(field.value, depth + 1);
      }
      emit('}');
    }
    ancestors.delete(item);
  };
  visit(value, 0);
  return chunks.join('');
}

/**
 * Build the request listener. Deps are captured by closure so each request
 * sees the same singletons without module-level global state.
 */
export function createRouter(
  deps: RouterDeps
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const { gameServer, tableStateHub, engineWs, channelHub } = deps;

  return async (req, res) => {
    const method = req.method || 'GET';
    // PATH ONLY (2026-09-03). Every route below is matched on the whole
    // request target, so `/health?cb=1788402501855` fell through to the 404
    // at the bottom while `/health` answered 200. Every caller that follows
    // the estate's own advice to cache-bust the health endpoint - spin-sweep
    // (`lease_diagnostics_missing` on all 96 runs a day), the publish and
    // engine watchdogs, an agent's curl - had been reading a 404 and
    // concluding the engine was unreachable. The insurance-preview handler
    // parses req.url itself, so the query is not lost to it.
    const url = (req.url || '/').split('?')[0] || '/';

    // Handle CORS preflight
    if (method === 'OPTIONS') {
      res.writeHead(204, CORS_HEADERS);
      res.end();
      return;
    }

    if (url === '/internal/maintenance-recovery-window') {
      res.setHeader('Cache-Control', 'no-store');
      // Only the host-owned release transaction calls this inside the serving
      // container. A public reverse-proxy request is never a local request.
      const peer = req.socket.remoteAddress;
      if (
        !verifyInternalKey(req) ||
        !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(peer || '') ||
        req.headers['x-forwarded-for'] !== undefined ||
        req.headers.forwarded !== undefined
      )
        return sendJSON(res, 401, { error: 'Unauthorized' });
      if (method !== 'POST') return sendJSON(res, 405, { error: 'Method not allowed' });
      const body = await readBody(req);
      if (
        !body ||
        typeof body !== 'object' ||
        Array.isArray(body) ||
        Object.keys(body).length !== 1 ||
        typeof body.announcedAt !== 'number' ||
        !Number.isSafeInteger(body.announcedAt)
      )
        return sendJSON(res, 400, { error: 'Invalid recovery request' });
      if (!gameServer.requestMaintenanceRecoveryWindow) {
        return sendJSON(res, 503, { error: 'Recovery window unavailable' });
      }
      try {
        const result = await gameServer.requestMaintenanceRecoveryWindow(body.announcedAt);
        return sendJSON(res, 200, result);
      } catch {
        // A lost database acknowledgment is UNKNOWN. The host retains and
        // reuses its original timestamp; it must never create another pause.
        return sendJSON(res, 503, { error: 'Recovery window outcome unknown' });
      }
    }

    if (/^\/internal\/tournament-diagnostics(?:\/|$)/.test(url)) {
      res.setHeader('Cache-Control', 'no-store');
      if (!verifyInternalKey(req)) return sendJSON(res, 401, { error: 'Unauthorized' });
      if (method !== 'GET') return sendJSON(res, 405, { error: 'Method not allowed' });
      if (Buffer.byteLength(req.url || '', 'utf8') > 2048) {
        return sendJSON(res, 400, { error: 'Invalid diagnostic scope' });
      }
      const match = url.match(/^\/internal\/tournament-diagnostics\/([^/]+)$/);
      if (!match || !DIAGNOSTIC_UUID.test(match[1])) {
        return sendJSON(res, 400, { error: 'Invalid diagnostic scope' });
      }
      const requestTarget = req.url || '';
      const queryStart = requestTarget.indexOf('?');
      const query = new URLSearchParams(queryStart < 0 ? '' : requestTarget.slice(queryStart + 1));
      const known = new Set(['table_ids', 'manager_instance_id', 'lease_generation']);
      for (const key of query.keys()) {
        if (!known.has(key) || query.getAll(key).length !== 1) {
          return sendJSON(res, 400, { error: 'Invalid diagnostic scope' });
        }
      }
      const tableIds = query.has('table_ids') ? query.get('table_ids')!.split(',') : undefined;
      const managerInstanceId = query.get('manager_instance_id') ?? undefined;
      const leaseGeneration = query.get('lease_generation') ?? undefined;
      if (
        (tableIds &&
          (tableIds.length < 1 ||
            tableIds.length > 8 ||
            tableIds.some((id) => !DIAGNOSTIC_UUID.test(id)) ||
            new Set(tableIds.map((id) => id.toLowerCase())).size !== tableIds.length)) ||
        (managerInstanceId !== undefined && !DIAGNOSTIC_UUID.test(managerInstanceId)) ||
        (leaseGeneration !== undefined && !DIAGNOSTIC_UUID.test(leaseGeneration))
      ) {
        return sendJSON(res, 400, { error: 'Invalid diagnostic scope' });
      }
      if (typeof gameServer.getTournamentLifecycleDiagnostic !== 'function') {
        return sendJSON(res, 503, { error: 'Diagnostic observation unavailable' });
      }
      try {
        const tournamentId = match[1].toLowerCase();
        const snapshot = gameServer.getTournamentLifecycleDiagnostic(
          tournamentId,
          { tableIds: tableIds?.map((id) => id.toLowerCase()) },
          {
            managerInstanceId: managerInstanceId?.toLowerCase(),
            leaseGeneration: leaseGeneration?.toLowerCase(),
          }
        );
        const schema = Object.getOwnPropertyDescriptor(snapshot, 'schema');
        const identity = Object.getOwnPropertyDescriptor(snapshot, 'tournamentId');
        if (
          !schema ||
          !('value' in schema) ||
          schema.value !== 'tournament-lifecycle-diagnostic/v1' ||
          !identity ||
          !('value' in identity) ||
          identity.value !== tournamentId
        ) {
          throw new Error('invalid_diagnostic_evidence');
        }
        const body = serializeTournamentDiagnostic(snapshot);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(body);
        return;
      } catch {
        return sendJSON(res, 503, {
          error: 'Diagnostic observation unavailable or exceeds evidence limit',
        });
      }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Telemetry routes — handlers/health.ts (Phase U3.1).
    // ─────────────────────────────────────────────────────────────────────────
    if (url === '/health' || url === '/')
      return handleHealth(
        res,
        { gameServer },
        new URLSearchParams((req.url || '').split('?')[1] || '')
      );
    // Operation Stable Hand Section 15. Read-only: it plans and reports, and
    // deliberately never executes what it plans.
    if (url === '/stable-hand') return handleStableHand(res);
    if (url === '/ws-metrics' && method === 'GET')
      // 2026-08-24: channelHub added — the wallet/tournament/club/lobby
      // transport had zero metrics visibility before this.
      return handleWsMetrics(res, { tableStateHub, engineWs, channelHub });
    if (url === '/metrics' && method === 'GET') return handleMetrics(res, { gameServer });

    // ─────────────────────────────────────────────────────────────────────────
    // State-mutating routes — handlers/*.ts (Phase U3.2 + U3.3).
    // ─────────────────────────────────────────────────────────────────────────
    if (method === 'POST' && url === '/action') return handleAction(req, res, { gameServer });
    if (method === 'POST' && url === '/timebank') return handleTimebank(req, res, { gameServer });
    /**
     * ROUTED 2026-08-28. `handleRejectRebuy` was imported at the top of this
     * file and never given a branch, so every POST fell through to the 404 at
     * the bottom. Both client call sites fire-and-forget with a swallowing
     * catch, so nothing ever surfaced it — and `engine.rejectRebuy()` had no
     * reachable caller, which left `rejectedRebuys` the write-only set that
     * the 2026-08-27 SNAP-CONTINUE work (waitForRebuyDecisions) exists to
     * read. Effect on the felt: the table sat out the full 5-second rebuy
     * pause after every bust even when the player pressed No, so Dan's rule
     * ("...OR SNAP CONTINUES IF THEY CLICK NO TO THE REBUY") never worked.
     */
    if (method === 'POST' && url === '/reject_rebuy')
      return handleRejectRebuy(req, res, { gameServer });
    // The rabbit-hunt paywall. The cards are not in any broadcast; this is the
    // only way they leave the server, and it charges before it answers.
    if (method === 'POST' && url === '/rabbit-hunt')
      return handleRabbitHunt(req, res, { gameServer });
    if (method === 'POST' && url === '/heartbeat') return handleHeartbeat(req, res, { gameServer });

    // Realtime programme Phase 2 (2026-09-05): what the player's browser saw.
    // Authenticated, in-memory, 204. See handlers/clientEvent.ts.
    if (method === 'POST' && url === '/client-event') {
      const body = await readBody(req);
      return handleClientEvent(req, res, body);
    }
    // Dan 2026-08-23: pagehide/app-freeze beacon. Marks the player AWAY (blind
    // cap armed) without removing them — see handlers/away.ts.
    if (method === 'POST' && url === '/away') return handleAway(req, res, { gameServer });
    if (method === 'POST' && url === '/preaction') return handlePreaction(req, res, { gameServer });
    if (method === 'POST' && url === '/addchips') return handleAddchips(req, res, { gameServer });
    if (method === 'POST' && url === '/leave-occupancy')
      return handleLeaveOccupancy(req, res, { gameServer });
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
    // Round 68: admin kick — moderation can remove a player from a table
    if (method === 'POST' && url === '/admin/kick-occupancy')
      return handleAdminKickOccupancy(req, res, deps);
    if (method === 'POST' && url === '/admin/kick')
      return handleAdminKick(req, res, { gameServer });
    if (method === 'POST' && url === '/post-bb') return handlePostBB(req, res, { gameServer });

    // The table voice mesh asks for its ICE servers here, once per join. It
    // MINTS a short-lived TURN credential, so it is authenticated like any other
    // player request — an open credential mint is an open relay. It answers the
    // STUN-only list (never a 500) while no relay is configured, which is the
    // state of every engine until one is deployed. See handlers/voice.ts.
    if (method === 'GET' && url === '/voice/ice') return handleVoiceIce(req, res);

    // Fault injection for freeze drills. 404s unless FAULT_INJECTION_TOKEN is
    // set, requires that token, and refuses any table with a human seated.
    if (method === 'POST' && url === '/admin/inject-fault')
      return handleInjectFault(req, res, { gameServer });

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
    // Channel broadcast routes (Phase U4 — Realtime migration)
    // Called by World Hub / admin to push events to connected clients.
    // Require Authorization: Bearer <INTERNAL_API_KEY>.
    // ─────────────────────────────────────────────────────────────────────────

    // POST /channels/club/:clubId/event
    const clubEventMatch = url.match(/^\/channels\/club\/([^/]+)\/event$/);
    if (method === 'POST' && clubEventMatch) {
      if (!verifyInternalKey(req)) {
        return sendJSON(res, 401, { error: 'Unauthorized' });
      }
      const clubId = clubEventMatch[1];
      const body = await readBody(req);
      if (!body) {
        return sendJSON(res, 400, { error: 'Invalid or missing JSON body' });
      }
      channelHub.broadcastToClub(clubId, {
        type: 'CLUB_EVENT',
        clubId,
        event: body,
      });
      return sendJSON(res, 200, { ok: true, clubId });
    }

    // POST /channels/tournament/:tournamentId/event
    const tournamentEventMatch = url.match(/^\/channels\/tournament\/([^/]+)\/event$/);
    if (method === 'POST' && tournamentEventMatch) {
      if (!verifyInternalKey(req)) {
        return sendJSON(res, 401, { error: 'Unauthorized' });
      }
      const tournamentId = tournamentEventMatch[1];
      const body = await readBody(req);
      if (!body) {
        return sendJSON(res, 400, { error: 'Invalid or missing JSON body' });
      }
      channelHub.broadcastToTournament(tournamentId, {
        type: 'TOURNAMENT_EVENT',
        tournamentId,
        event: body,
      });
      return sendJSON(res, 200, { ok: true, tournamentId });
    }

    // POST /channels/lobby/update
    if (method === 'POST' && url === '/channels/lobby/update') {
      if (!verifyInternalKey(req)) {
        return sendJSON(res, 401, { error: 'Unauthorized' });
      }
      const body = await readBody(req);
      if (!body) {
        return sendJSON(res, 400, { error: 'Invalid or missing JSON body' });
      }
      channelHub.broadcastToLobby({
        type: 'LOBBY_UPDATE',
        payload: body,
      });
      return sendJSON(res, 200, { ok: true });
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 404 — Not Found
    // ─────────────────────────────────────────────────────────────────────────
    sendJSON(res, 404, { error: 'Not Found' });
  };
}
