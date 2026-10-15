/**
 * Keep fabricated test sessions off live Supabase Realtime.
 *
 * Several browser specs plant a made-up session in `smarter-poker-auth` and
 * mock REST and Auth so a page renders signed in. The Realtime WebSocket is
 * not REST, so it was never mocked: the page opened a socket to production
 * Realtime and joined channels with the made-up token. Realtime rejected it
 * (JwtSignerError, JwtSignatureError, MalformedJWT), and those rejections
 * filled the production Realtime logs. Supabase support (ticket SU-505102,
 * October 2026) read them as a signer fault on the project; every sampled
 * rejection carried one of these fixture subjects instead.
 *
 * A session Supabase Auth issues for this project is an asymmetric JWT that
 * names its signing key (ES256 with a `kid`). Anything else in an
 * `access_token` field is fabricated, and its join is never forwarded. The
 * publishable key (`sb_publishable_...`) and real sessions pass through
 * unchanged, so a spec that signs in for real still exercises live Realtime.
 */
import type { BrowserContext, WebSocketRoute } from '@playwright/test';

const REALTIME_SOCKET = /\/realtime\/v1\/websocket/;
const ACCESS_TOKEN_FIELD = /"access_token"\s*:\s*"([^"]*)"/g;

export function isIssuedAccessToken(token: string): boolean {
  if (token.startsWith('sb_publishable_')) return true;
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) return false;
  try {
    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    return (
      typeof header?.kid === 'string' &&
      header.kid.length > 0 &&
      typeof header?.alg === 'string' &&
      header.alg !== 'none' &&
      !header.alg.startsWith('HS')
    );
  } catch {
    return false;
  }
}

export function fabricatedTokenIn(message: string): string | null {
  for (const match of message.matchAll(ACCESS_TOKEN_FIELD)) {
    if (!isIssuedAccessToken(match[1])) return match[1];
  }
  return null;
}

/**
 * Route this context's Realtime sockets through a check. The server socket is
 * opened only once a message proves it carries no fabricated token, so a
 * fabricated join never reaches Supabase at all.
 */
const guarded = new WeakSet<BrowserContext>();

export async function installRealtimeSessionGuard(context: BrowserContext): Promise<void> {
  if (guarded.has(context)) return;
  guarded.add(context);
  await context.routeWebSocket(REALTIME_SOCKET, (ws: WebSocketRoute) => {
    let server: WebSocketRoute | null = null;
    let refused = false;
    const pending: Array<string | Buffer> = [];
    ws.onMessage((message) => {
      if (refused) return;
      if (typeof message === 'string') {
        if (fabricatedTokenIn(message) !== null) {
          refused = true;
          pending.length = 0;
          void server?.close();
          void ws.close({ code: 4403, reason: 'fabricated test session kept off live Realtime' });
          return;
        }
        // A heartbeat can precede the first join. Hold it until a message
        // carrying a token has been checked, so nothing reaches the server
        // ahead of that decision.
        if (!server && !message.includes('"access_token"')) {
          pending.push(message);
          return;
        }
      }
      if (!server) {
        server = ws.connectToServer();
        for (const held of pending.splice(0)) server.send(held);
      }
      server.send(message);
    });
  });
}
