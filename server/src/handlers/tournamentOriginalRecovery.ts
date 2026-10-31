import type { IncomingMessage, ServerResponse } from 'node:http';
import { readBody } from '../http/body.js';
import { sendJSON } from '../http/respond.js';
import { hasTournamentAbortServiceAuthority } from './tournamentAbortBoundary.js';

export const ORIGINAL_RECOVERY_OPERATION = 'd44c4440-2911-430c-8ee7-376611ef3f38';
export const ORIGINAL_RECOVERY_TWENTY = new Set([
  '095d7449-3282-46c5-8a39-768fe14dce5a',
  '0cb8e80f-4031-4b72-bbd6-f076605f1575',
  '0ef3dbfb-c092-4008-b7bd-bde65a474e83',
  '135b187e-c096-483a-b347-10be69df956b',
  '19cf1192-d926-4042-a13c-67eca5ebf9a3',
  '2305ddd2-58af-43fb-9089-567108e4ca77',
  '46ba2e7c-c9f8-42b6-b416-d7342a676531',
  '64599cc4-03bb-4f1d-8df7-ef610abe10af',
  '6c6724e5-1ee4-40c0-ad21-44e9f9b6d800',
  '7932d2bb-7cfb-4b0e-ae99-75fcbae82d52',
  '7ab02286-fa29-44a2-a64f-0cb3d60ca572',
  '8229a0af-3c5a-4672-b9df-3d8523613086',
  '85bec2f4-0aa8-42b8-8799-d9d3acff2275',
  '8855c50e-c4ed-4235-91c1-323627023b15',
  'c685ebb7-954d-4a38-a26d-9c23c23600a4',
  'd110fd05-846e-46c1-adca-a2e515e95144',
  'dbaca4cd-8959-427d-8b91-2d97310e6fd6',
  'deaa61a7-0553-4c81-a178-e9ba822a1ba2',
  'debf5e04-6f4d-4858-88a0-84b6fe1ba598',
  'fdfcadfd-4044-4696-874d-5ec50cf93a48',
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Prepare fences abort only. The root/host must still independently prove
 * actual sealed/current identity, own v3 thaw and original native custody before
 * the canonical database disposition RPC. No JSON certificate activates it.
 */
export async function handleTournamentOriginalRecoveryPrepare(
  req: IncomingMessage,
  res: ServerResponse,
  deps: {
    gameServer: {
      prepareTournamentOriginalRecovery?: (
        operation: string,
        tournament: string,
        nonce: string
      ) => unknown;
      readTournamentOriginalRecoveryPreparation?: (
        operation: string,
        tournament: string,
        nonce: string
      ) => unknown;
    };
  }
) {
  res.setHeader('Cache-Control', 'no-store');
  if (!hasTournamentAbortServiceAuthority(req.headers['authorization']))
    return sendJSON(res, 401, { success: false, error: 'Service Authority Required' });
  if (req.method !== 'POST')
    return sendJSON(res, 405, { success: false, error: 'Method Not Allowed' });
  try {
    const body = JSON.parse(await readBody(req));
    if (
      !body ||
      typeof body !== 'object' ||
      Array.isArray(body) ||
      body.operationId !== ORIGINAL_RECOVERY_OPERATION ||
      !ORIGINAL_RECOVERY_TWENTY.has(body.tournamentId) ||
      !UUID.test(body.nonce || '') ||
      !['prepare', 'read'].includes(body.action ?? 'prepare') ||
      Object.keys(body).some((k) => !['operationId', 'tournamentId', 'nonce', 'action'].includes(k))
    )
      return sendJSON(res, 400, {
        success: false,
        error: 'Exact Original Operation Event And Nonce Required',
      });
    const invoke =
      body.action === 'read'
        ? deps.gameServer.readTournamentOriginalRecoveryPreparation
        : deps.gameServer.prepareTournamentOriginalRecovery;
    if (!invoke) throw new Error('original_recovery_owner_unavailable');
    const runtime = invoke.call(deps.gameServer, body.operationId, body.tournamentId, body.nonce);
    return sendJSON(res, 200, { success: true, runtime });
  } catch {
    // Retry only the SAME nonce on the SAME current owner after readback.
    return sendJSON(res, 503, {
      success: false,
      error: 'Preparation Unknown. Read Same Operation Before Retrying',
    });
  }
}
