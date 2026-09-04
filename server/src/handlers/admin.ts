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
          leaveTable(
            userId: string,
            opts?: { forced?: boolean }
          ):
            | { success: boolean; [k: string]: unknown }
            | Promise<{ success: boolean; [k: string]: unknown }>;
        }
      | null
      | undefined;
  };
}

/**
 * SECURITY (Audit 2026-08-04, finding S1): shared authorization gate for all
 * table-admin actions. Previously pause/resume only checked that the caller
 * held a valid JWT — ANY authenticated user could freeze/unfreeze dealing on
 * ANY table by id. This resolves the caller's club role the same way kick does
 * (owner / admin / super_agent in the club that owns the table).
 *
 * Returns the verified caller + club on success, or a ready-to-send error.
 */
async function authorizeTableAdmin(
  req: IncomingMessage,
  tableId: string | undefined
): Promise<
  { ok: true; userId: string; clubId: string } | { ok: false; status: number; error: string }
> {
  const auth = await authenticateRequest(req);
  if (!auth) return { ok: false, status: 401, error: 'Authentication required' };
  if (!tableId) return { ok: false, status: 400, error: 'Missing tableId' };

  const { data: tableRow, error: tErr } = await supabase
    .from('tables')
    .select('club_id, union_id')
    .eq('id', tableId)
    .maybeSingle();
  if (tErr || !tableRow?.club_id) {
    return { ok: false, status: 404, error: 'Table or club not found' };
  }

  // P2-4 (2026-08-20): union-owned tables carry the union's container club as
  // club_id (UNION LAW), so a member club's admin has no club_members row for
  // that club and every admin action returned 403. For union tables,
  // authorize the union owner, union admins, and admin-tier members of ANY
  // member club of that union.
  if (tableRow.union_id) {
    const { data: unionRow } = await supabase
      .from('unions')
      .select('owner_id')
      .eq('id', tableRow.union_id)
      .maybeSingle();
    if (unionRow?.owner_id === auth.userId) {
      return { ok: true, userId: auth.userId, clubId: tableRow.club_id };
    }
    const { data: unionAdmin } = await supabase
      .from('union_admins')
      .select('user_id')
      .eq('union_id', tableRow.union_id)
      .eq('user_id', auth.userId)
      .maybeSingle();
    if (unionAdmin) {
      return { ok: true, userId: auth.userId, clubId: tableRow.club_id };
    }
    /* THIS IS AN AUTHORIZATION READ, AND IT WAS CAPPED (fixed 2026-08-27).
       It lists the clubs in a union so the caller's role in one of them can
       grant access. At `.limit(100)` a union with 101 clubs would silently
       drop the last one, and a legitimate admin of that club would be DENIED
       - a permission failure that looks like a bug in their account rather
       than a truncated query, and one that only appears once a union grows.
       Unions hold 2 clubs today, so this was latent; an auth path is the last
       place to leave a "big enough for now" number. Ordered because paging an
       unordered read can skip a row, and skipping a row here is the denial
       this is fixing. */
    const memberClubs: Array<{ club_id?: string }> = [];
    for (let page = 0; ; page++) {
      if (page > 1000) {
        reportError(
          new Error('[admin] union club paging did not terminate'),
          'admin.union_clubs_paging_runaway'
        );
        break;
      }
      const { data: chunk } = await supabase
        .from('union_clubs')
        .select('club_id')
        .eq('union_id', tableRow.union_id)
        .order('club_id', { ascending: true })
        .range(page * 1000, page * 1000 + 999);
      if (!chunk || chunk.length === 0) break;
      memberClubs.push(...chunk);
      if (chunk.length < 1000) break;
    }
    const clubIds = memberClubs.map((r) => r.club_id).filter(Boolean);
    if (clubIds.length > 0) {
      const { data: roles } = await supabase
        .from('club_members')
        .select('club_id, role')
        .eq('user_id', auth.userId)
        .in('club_id', clubIds);
      const adminRow = (roles ?? []).find((r) =>
        ['owner', 'co_owner', 'admin', 'super_agent'].includes(String(r.role))
      );
      if (adminRow) {
        return { ok: true, userId: auth.userId, clubId: tableRow.club_id };
      }
    }
    return { ok: false, status: 403, error: 'Union admin role required' };
  }

  const { data: membership, error: mErr } = await supabase
    .from('club_members')
    .select('role')
    .eq('club_id', tableRow.club_id)
    .eq('user_id', auth.userId)
    .maybeSingle();
  if (mErr || !membership) {
    return { ok: false, status: 403, error: 'Not a club member' };
  }
  // Admin tier = owner OR co_owner OR admin OR super_agent (matches kick /
  // waitlist / lobby). co_owner was missing from both lists in this file, which
  // made it the only role in the seven that a promotion could grant and the
  // engine would then refuse - a co-owner could not pause, resume or kick.
  if (!['owner', 'co_owner', 'admin', 'super_agent'].includes(String(membership.role))) {
    return { ok: false, status: 403, error: 'Admin role required' };
  }
  return { ok: true, userId: auth.userId, clubId: tableRow.club_id };
}

export async function handleAdminPause(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AdminDeps
): Promise<void> {
  try {
    const body = JSON.parse(await readBody(req));
    const authz = await authorizeTableAdmin(req, body.tableId);
    if (!authz.ok) return sendJSON(res, authz.status, { success: false, error: authz.error });
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
    const body = JSON.parse(await readBody(req));
    const authz = await authorizeTableAdmin(req, body.tableId);
    if (!authz.ok) return sendJSON(res, authz.status, { success: false, error: authz.error });
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
    const body = JSON.parse(await readBody(req));
    const { tableId, userId: targetUserId } = body as {
      tableId?: string;
      userId?: string;
      reason?: string;
    };
    if (!tableId || !targetUserId) {
      return sendJSON(res, 400, { success: false, error: 'Missing tableId or userId' });
    }

    // Resolve caller + verify club-admin role (owner / admin / super_agent).
    const authz = await authorizeTableAdmin(req, tableId);
    if (!authz.ok) return sendJSON(res, authz.status, { success: false, error: authz.error });
    const callerUserId = authz.userId;
    const clubId = authz.clubId;

    const engine = deps.gameServer.getTableEngine(tableId);
    if (!engine) {
      return sendJSON(res, 404, { success: false, error: 'Table engine not found' });
    }

    // CHIP CONTINUITY: a kick is a system exit. The stay clock never blocks it;
    // the session still closes and the rejoin floor is still written.
    const result = await engine.leaveTable(targetUserId, { forced: true });

    // Round 71: write audit ledger row so forensic review sees who kicked
    // whom, when, why. Fire-and-forget — engine admin actions log to
    // anti_cheat_events (the moderation-specific stream) and audit_trail
    // (the universal immutable ledger) when available. Failures don't
    // block the response — the kick already happened.
    const reasonText = (body as { reason?: string }).reason ?? 'admin kick';
    void Promise.resolve(
      supabase.from('anti_cheat_events').insert({
        event_type: 'player_kicked',
        player_id: targetUserId,
        club_id: clubId,
        table_id: tableId,
        details: {
          reason: reasonText,
          kicked_by: callerUserId,
          source: 'engine_admin_kick',
          immediate: result.immediate ?? false,
        },
        triggered_by: callerUserId,
      })
    )
      .then(({ error }) => {
        if (error) {
          console.warn('[admin.kick] anti_cheat_events insert failed:', error.message);
        }
      })
      // .then() alone covers only the resolved-with-error case; a transport
      // failure rejects, and an unhandled rejection here would take down an
      // otherwise successful kick response.
      .catch((err: unknown) => {
        console.warn(
          '[admin.kick] anti_cheat_events insert threw:',
          (err as Error)?.message ?? err
        );
      });

    return sendJSON(res, result.success ? 200 : 400, {
      ...result,
      kicked_by: callerUserId,
      target_user_id: targetUserId,
    });
  } catch (err: unknown) {
    reportError(err, 'HTTP.admin_kick_error');
    return sendJSON(res, 500, { success: false, error: 'Failed to kick player' });
  }
}
