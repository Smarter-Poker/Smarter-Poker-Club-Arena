/**
 * `GET /voice/ice` — the ICE server list for the table voice mesh.
 *
 * WHAT IT ANSWERS
 * ───────────────
 *   {
 *     iceServers: [ { urls } , ... , { urls: [...], username, credential } ],
 *     iceTransportPolicy: 'relay' | 'all',
 *     turn: boolean,
 *     expiresAt: number | null,   // unix SECONDS
 *     ttlSeconds: number
 *   }
 *
 * The TURN entry (when present) carries a SHORT-LIVED credential derived from
 * the coturn `static-auth-secret` — see `../voice/turnCredentials.ts` for the
 * scheme and for why `relay` is the default transport policy.
 *
 * WHY IT IS AUTHENTICATED
 * ───────────────────────
 * This route MINTS a credential that allocates bandwidth on our relay. An
 * unauthenticated mint is an open relay with a public issuing endpoint: anyone
 * on the internet fetches a credential and proxies whatever they like at our
 * expense, and the traffic is indistinguishable from a player's. So it is gated
 * exactly the way every other player request on this engine is gated —
 * `authenticateRequest`, which verifies the Supabase JWT's SIGNATURE through
 * GoTrue (see `../http/auth.ts`; the unsigned local-decode path was removed as a
 * security fix on 2026-07-19) and answers 401 otherwise.
 *
 * The credential is bound to `auth.userId`, never to anything the caller sends.
 * That is what makes an abusive allocation attributable to an account.
 *
 * NOT RATE LIMITED, ON PURPOSE. `checkRateLimit` guards actions that CHANGE
 * something. This one is a pure function of (clock, userId, secret): a caller
 * who fetches it a thousand times gets a thousand near-identical credentials
 * that grant exactly what the first one did. A limiter would add no security and
 * would introduce a 429 on a join path. The relay's own `user-quota` /
 * `total-quota` are where allocation abuse is actually bounded, and the install
 * script sets both.
 *
 * DEGRADES, NEVER 500s
 * ────────────────────
 * `TURN_STATIC_AUTH_SECRET` is unset on every engine today and will stay unset
 * until a relay host is chosen and deployed. That is the NORMAL case, not an
 * error: the handler answers 200 with the STUN-only list and `turn: false`, and
 * voice behaves exactly as it does today. Anything unexpected also falls back to
 * the STUN-only list rather than failing the join, because a player on wifi
 * losing voice entirely because the relay config is malformed would be a
 * regression caused by the fix.
 */

import type { IncomingMessage, ServerResponse } from 'http';
import { sendJSON } from '../http/respond.js';
import { authenticateRequest } from '../http/auth.js';
import { reportError } from '../services/errorReporter.js';
import {
  buildVoiceIceResponse,
  readTurnEnv,
  DEFAULT_STUN_URLS,
  DEFAULT_TURN_TTL_SECONDS,
  type VoiceIceResponse,
} from '../voice/turnCredentials.js';

/** The answer when there is no relay, or when reading the config went wrong. */
function stunOnly(): VoiceIceResponse {
  return {
    iceServers: DEFAULT_STUN_URLS.map((urls) => ({ urls })),
    iceTransportPolicy: 'all',
    turn: false,
    expiresAt: null,
    ttlSeconds: DEFAULT_TURN_TTL_SECONDS,
  };
}

export interface VoiceIceDeps {
  /** Injectable so a test can drive the handler without a live GoTrue. */
  authenticate?: (req: IncomingMessage) => Promise<{ userId: string } | null>;
  /** Injectable so a test can vary the relay config without touching process.env. */
  env?: NodeJS.ProcessEnv;
}

export async function handleVoiceIce(
  req: IncomingMessage,
  res: ServerResponse,
  deps: VoiceIceDeps = {}
): Promise<void> {
  const authenticate = deps.authenticate ?? authenticateRequest;

  const auth = await authenticate(req);
  if (!auth) {
    return sendJSON(res, 401, { success: false, error: 'Authentication required' });
  }

  try {
    const config = readTurnEnv(deps.env ?? process.env);
    return sendJSON(res, 200, buildVoiceIceResponse(auth.userId, config));
  } catch (err: unknown) {
    // Never let a config problem take voice away from the players it works for.
    reportError(err, 'HTTP.voice_ice_error');
    return sendJSON(res, 200, stunOnly());
  }
}
