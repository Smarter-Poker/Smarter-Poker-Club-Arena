import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readBody } from '../http/body.js';
import { sendJSON } from '../http/respond.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Verify the configured service identity, never unsigned JWT claims. */
export function hasTournamentAbortServiceAuthority(header: string | undefined): boolean {
  const expected = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!expected || !header?.startsWith('Bearer ')) return false;
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(header.slice(7)), digest(expected));
}

export async function handleTournamentAbortBoundary(
  req: IncomingMessage,
  res: ServerResponse,
  deps: {
    gameServer: {
      acknowledgeTournamentAbortBoundary?: (
        operationId: string,
        tournamentId: string
      ) => Promise<unknown>;
    };
  }
) {
  res.setHeader('Cache-Control', 'no-store');
  if (!hasTournamentAbortServiceAuthority(req.headers['authorization']))
    return sendJSON(res, 401, { success: false, error: 'Service Authority Required' });
  if (req.method !== 'POST')
    return sendJSON(res, 405, { success: false, error: 'Method Not Allowed' });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const body = JSON.parse(await readBody(req));
    if (
      !body ||
      typeof body !== 'object' ||
      Array.isArray(body) ||
      !UUID.test(body.operationId || '') ||
      !UUID.test(body.tournamentId || '') ||
      Object.keys(body).some((key) => !['operationId', 'tournamentId'].includes(key))
    )
      return sendJSON(res, 400, {
        success: false,
        error: 'Original Operation And Tournament Required',
      });
    if (!deps.gameServer.acknowledgeTournamentAbortBoundary)
      throw new Error('tournament_abort_owner_unavailable');
    // The manager retains the actual promise. A lost/aborted HTTP response
    // never cancels accepted work or releases any closeout fence.
    const runtime = await Promise.race([
      deps.gameServer.acknowledgeTournamentAbortBoundary(body.operationId, body.tournamentId),
      new Promise((resolve) => {
        timer = setTimeout(
          () =>
            resolve({
              state: 'pending',
              operation_id: body.operationId,
              reason: 'original_drain_in_flight',
            }),
          30_000
        );
        timer.unref?.();
      }),
    ]);
    return sendJSON(res, 200, { success: true, runtime });
  } catch {
    return sendJSON(res, 503, {
      success: false,
      error: 'Outcome Unknown. Read The Same Operation Before Retrying',
    });
  } finally {
    if (timer) clearTimeout(timer);
  }
}
