/**
 * Admin handlers — Bible V8 §6.17: pause / resume table dealing.
 *
 * Extracted Phase U3.3 (2026-04-23). Byte-identical.
 *
 * `POST /admin/pause`  — Body: `{ tableId, reason? }`
 * `POST /admin/resume` — Body: `{ tableId }`
 * `POST /admin/kick`   — Body: `{ tableId, userId, reason? }` (Round 68)
 */

import type { IncomingMessage, ServerResponse } from 'http';
import { sendJSON } from '../http/respond.js';
import { authenticateRequest } from '../http/auth.js';
import { readBody } from '../http/body.js';
import { reportError } from '../services/errorReporter.js';
import { supabase } from '../services/supabase.js';

export interface AdminDeps {
  gameServer: {
    getTableEngine(tableId: string):
      | {
          adminPause(reason?: string): unknown;
          adminResume(): unknown;
          leaveTable(userId: string): { success: boolean; [k: string]: unknown };
        }
      | null
      | undefined;
  };
}

export async function handleAdminPause(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AdminDeps
): Promise<void> {
  try {
    const auth = await authenticateRequest(req);
    if (!auth) return sendJSON(res, 401, { success: false, error: 'Authentication required' });
    const body = JSON.parse(await readBody(req));
    const engine = deps.gameServer.getTableEngine(body.tableId);
    if (!engine) return sendJSON(res, 404, { success: false, error: 'Table engine not found' });
    return sendJSON(res, 200, engine.adminPause(body.reason));
  } catch (err: unknown) {
    reportError(err, 'HTTP.admin_pause_error');
    return sendJSON(res, 500, { success: false, error: 'Invalid request body' });
  }
}

export async function handleAdminResume(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AdminDeps
): Promise<void> {
  try {
    const auth = await authenticateRequest(req);
    if (!auth) return sendJSON(res, 401, { success: false, error: 'Authentication required' });
    const body = JSON.parse(await readBody(req));
    const engine = deps.gameServer.getTableEngine(body.tableId);
    if (!engine) return sendJSON(res, 404, { success: false, error: 'Table engine not found' });
    return sendJSON(res, 200, engine.adminResume());
  } catch (err: unknown) {
    reportError(err, 'HTTP.admin_resume_error');
    return sendJSON(res, 500, { success: false, error: 'Invalid request body' });
  }
}

/**
 * Round 68: POST /admin/kick — Admin removes a player from a table.
 * Body: { tableId, userId, reason? }
 *
 * Auth flow:
 *  1. Caller's JWT is valid
 *  2. Caller is an owner / admin / manager in the club that owns the table
 *
 * Side effect: calls engine.leaveTable(targetUserId) which mid-hand auto-folds
 * + cashout-pending, between-hand atomic-cashouts, and writes the seat_left
 * event so all clients re-render.
 *
 * Audit: caller, target, table, reason go into anti_cheat_events via the
 * dashboard's existing logging path AFTER this returns success.
 */
export async function handleAdminKick(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AdminDeps
): Promise<void> {
  try {
    const auth = await authenticateRequest(req);
    if (!auth) {
      return sendJSON(res, 401, { success: false, error: 'Authentication required' });
    }
    const body = JSON.parse(await readBody(req));
    const { tableId, userId: targetUserId } = body as {
      tableId?: string;
      userId?: string;
      reason?: string;
    };
    if (!tableId || !targetUserId) {
      return sendJSON(res, 400, { success: false, error: 'Missing tableId or userId' });
    }

    // Resolve the table's club_id, then check caller's role in club_members
    const { data: tableRow, error: tErr } = await supabase
      .from('tables')
      .select('club_id')
      .eq('id', tableId)
      .maybeSingle();
    if (tErr || !tableRow?.club_id) {
      return sendJSON(res, 404, { success: false, error: 'Table or club not found' });
    }

    const { data: membership, error: mErr } = await supabase
      .from('club_members')
      .select('role')
      .eq('club_id', tableRow.club_id)
      .eq('user_id', auth.userId)
      .maybeSingle();
    if (mErr || !membership) {
      return sendJSON(res, 403, { success: false, error: 'Not a club member' });
    }
    // Round 72: production roles are owner / admin / super_agent / agent /
    // member / player. 'manager' is in the enum but unused in production —
    // dropped from this check. Admin tier = owner OR admin OR super_agent
    // (matches waitlist / club-analytics / lobby-ordering / etc).
    if (!['owner', 'admin', 'super_agent'].includes(String(membership.role))) {
      return sendJSON(res, 403, { success: false, error: 'Admin role required' });
    }

    const engine = deps.gameServer.getTableEngine(tableId);
    if (!engine) {
      return sendJSON(res, 404, { success: false, error: 'Table engine not found' });
    }

    const result = engine.leaveTable(targetUserId);

    // Round 71: write audit ledger row so forensic review sees who kicked
    // whom, when, why. Fire-and-forget — engine admin actions log to
    // anti_cheat_events (the moderation-specific stream) and audit_trail
    // (the universal immutable ledger) when available. Failures don't
    // block the response — the kick already happened.
    const reasonText = (body as { reason?: string }).reason ?? 'admin kick';
    void supabase
      .from('anti_cheat_events')
      .insert({
        event_type: 'player_kicked',
        player_id: targetUserId,
        club_id: tableRow.club_id,
        table_id: tableId,
        details: {
          reason: reasonText,
          kicked_by: auth.userId,
          source: 'engine_admin_kick',
          immediate: result.immediate ?? false,
        },
        triggered_by: auth.userId,
      })
      .then(({ error }) => {
        if (error) {
          console.warn('[admin.kick] anti_cheat_events insert failed:', error.message);
        }
      });

    return sendJSON(res, result.success ? 200 : 400, {
      ...result,
      kicked_by: auth.userId,
      target_user_id: targetUserId,
    });
  } catch (err: unknown) {
    reportError(err, 'HTTP.admin_kick_error');
    return sendJSON(res, 500, { success: false, error: 'Failed to kick player' });
  }
}
