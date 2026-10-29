import type { BrowserContext, WebSocketRoute } from '@playwright/test';

/** Only this reserved context's private-record engine channel can be interrupted. */
export async function installPrivateRecordEngineInterruption(context: BrowserContext) {
  let blocked = false;
  const servers: WebSocketRoute[] = [];
  await context.routeWebSocket(
    (url) =>
      url.protocol === 'wss:' &&
      url.hostname === 'engine.smarter.poker' &&
      url.pathname === '/ws/channel',
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
