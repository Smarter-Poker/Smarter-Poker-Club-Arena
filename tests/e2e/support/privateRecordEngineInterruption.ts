import type { BrowserContext, WebSocketRoute } from '@playwright/test';

const endpoints = {
  engine: 'wss://engine.smarter.poker/ws/channel',
  gateway: 'wss://ca-static.smarter.poker/private-record/ws/channel',
} as const;

/** Only exact private-record endpoints in this reserved context can be interrupted. */
export async function installPrivateRecordEngineInterruption(
  context: BrowserContext,
  endpoint: 'engine' | 'gateway' = 'engine'
) {
  let blocked = false;
  const servers: WebSocketRoute[] = [];
  await context.routeWebSocket(
    (url) => {
      const allowed = new URL(endpoints[endpoint]);
      return (
        url.protocol === allowed.protocol &&
        url.host === allowed.host &&
        url.pathname === allowed.pathname &&
        !url.username &&
        !url.password
      );
    },
    (socket) => {
      if (blocked) {
        void socket.close({ code: 4000, reason: 'Reserved Client Record Channel Qualification' });
        return;
      }
      // No fabricated messages: default routing forwards the real server bytes.
      servers.push(socket.connectToServer());
    }
  );
  return {
    async block() {
      if (blocked || !servers.length)
        throw new Error('No live reserved engine channel was observed');
      blocked = true;
      await Promise.all(
        servers
          .splice(0)
          .map((server) =>
            server.close({ code: 4000, reason: 'Reserved Client Record Channel Qualification' })
          )
      );
    },
    restore() {
      blocked = false;
    },
  };
}
