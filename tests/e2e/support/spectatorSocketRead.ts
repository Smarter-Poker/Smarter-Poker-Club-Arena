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
  ].includes(type);
}
