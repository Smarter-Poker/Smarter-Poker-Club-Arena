import type { BrowserContext, WebSocketRoute } from '@playwright/test';

/**
 * Interrupt only this reserved browser's real Realtime connection. Chromium's
 * offline emulation can leave an established WebSocket open. Pass-through
 * routing preserves every server frame; closing its server side supplies the
 * missing transport fault, and the application's SDK still owns recovery.
 */
export async function installAccountRealtimeInterruption(
  context: BrowserContext,
  supabaseUrl: string
) {
  const host = new URL(supabaseUrl).host;
  const servers: WebSocketRoute[] = [];
  await context.routeWebSocket(
    (url) => url.host === host && url.pathname === '/realtime/v1/websocket',
    (socket) => {
      servers.push(socket.connectToServer());
    }
  );
  return async () => {
    const current = servers.splice(0);
    if (!current.length) throw new Error('No reserved account Realtime transport was observed.');
    // Browser WebSocket.close accepts1000 or3000-4999. A reserved protocol code
    // such as1012 silently failed the maintained Daily Missions interruption.
    await Promise.all(
      current.map((server) =>
        server.close({ code: 4000, reason: 'Certification Realtime Interruption' })
      )
    );
  };
}
