import type { IncomingMessage, ServerResponse } from 'node:http';
import { authenticateRequest } from '../http/auth.js';
import { readBody } from '../http/body.js';
import { sendJSON } from '../http/respond.js';
import {
  operatorCapabilities,
  operatorCommand,
  operatorCommandStatus,
} from '../maintenance/OperatorCommands.js';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export async function handlePlatformControl(
  req: IncomingMessage,
  res: ServerResponse,
  deps: {
    gameServer: {
      applyOperatorFloorCommand?: (command: any) => Promise<unknown>;
      endOperatorMaintenance?: (command: any) => Promise<unknown>;
    };
  }
) {
  res.setHeader('Cache-Control', 'no-store');
  const auth = await authenticateRequest(req);
  if (!auth) return sendJSON(res, 401, { success: false, error: 'Authentication Required' });
  try {
    if (req.method === 'GET') {
      const params = new URL(req.url || '/', 'http://engine.local').searchParams;
      if (params.get('capabilities') === '1')
        return sendJSON(res, 200, {
          success: true,
          capabilities: await operatorCapabilities(auth.userId),
        });
      const id = params.get('operationId') || '';
      if (!UUID.test(id))
        return sendJSON(res, 400, { success: false, error: 'Operation Identity Required' });
      const command = await operatorCommandStatus(auth.userId, id);
      return sendJSON(res, command ? 200 : 404, { success: Boolean(command), command });
    }
    if (req.method !== 'POST')
      return sendJSON(res, 405, { success: false, error: 'Method Not Allowed' });
    const body = JSON.parse(await readBody(req));
    if (
      !body ||
      typeof body !== 'object' ||
      Array.isArray(body) ||
      !UUID.test(body.operationId || '') ||
      !['floor', 'maintenance'].includes(body.domain) ||
      !(
        body.domain === 'floor'
          ? ['pause', 'resume', 'park', 'close_cash']
          : ['start', 'cancel', 'end']
      ).includes(body.action) ||
      typeof body.reason !== 'string' ||
      body.reason.trim().length < 10 ||
      body.reason.length > 500 ||
      Object.keys(body).some((key) => !['operationId', 'domain', 'action', 'reason'].includes(key))
    )
      return sendJSON(res, 400, {
        success: false,
        error: 'A Valid Command And Audit Reason Are Required',
      });
    if (
      (body.domain === 'floor' && !deps.gameServer.applyOperatorFloorCommand) ||
      (body.action === 'end' && !deps.gameServer.endOperatorMaintenance)
    )
      throw new Error('operator_owner_unavailable');
    const command = await operatorCommand(auth.userId, body);
    let runtime: unknown = null;
    if (command.domain === 'floor')
      runtime = await deps.gameServer.applyOperatorFloorCommand?.(command);
    if (command.domain === 'maintenance' && body.action === 'end')
      runtime = await deps.gameServer.endOperatorMaintenance?.(command);
    return sendJSON(res, 200, {
      success: true,
      command: await operatorCommandStatus(auth.userId, command.id),
      runtime,
    });
  } catch (error) {
    // A lost receipt remains unknown. The caller keeps the UUID and reads it before another write.
    const refused = String(error).includes('engine_operator_refused:');
    if (refused)
      return sendJSON(res, 409, {
        success: false,
        error: String(error).split('engine_operator_refused:')[1],
      });
    const forbidden = String(error).includes('forbidden');
    return sendJSON(res, forbidden ? 403 : 503, {
      success: false,
      error: forbidden
        ? 'Operator Permission Required'
        : 'Command Outcome Unknown. Read The Same Operation Before Retrying',
    });
  }
}
