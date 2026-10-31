/** Observer protocol only. The controlled synthetic phase refuses ALL upstream frames. */
export function isReadOnlySpectatorSocketType(type: string): boolean {
  return [
    'SUBSCRIBE',
    'UNSUBSCRIBE',
    'RESYNC',
    'PING',
    'PONG',
    'HEARTBEAT',
    'JOIN_LOBBY',
    'LEAVE_LOBBY',
    'CHANNEL_PING',
    'CHANNEL_PONG',
    'JOIN_PRIVATE_RECORD',
    'LEAVE_PRIVATE_RECORD',
    'JOIN_CLUB',
    'LEAVE_CLUB',
    'JOIN_TOURNAMENT',
    'LEAVE_TOURNAMENT',
  ].includes(type);
}

/** Install after navigation, once Playwright's socket routing factory is active.
 * An init script can instead patch the native upstream socket and bypass the
 * route being certified. Keep references only; never retain URLs or frames. */
export function installReadOnlySocketProbe(hostname: string): void {
  const send = WebSocket.prototype.send;
  const peers = new Set<WebSocket>();
  WebSocket.prototype.send = function (data) {
    if (new URL(this.url).hostname === hostname) peers.add(this);
    return send.call(this, data);
  };
  Object.defineProperty(window, '__a14ReadOnlySocketProbe', {
    value: () => {
      const open = [...peers].filter((socket) => socket.readyState === WebSocket.OPEN);
      if (!open.length) throw new Error('No Live Routed Engine Socket For Refusal Proof');
      for (const socket of open) socket.send(JSON.stringify({ type: 'PING' }));
      return open.length;
    },
  });
}
