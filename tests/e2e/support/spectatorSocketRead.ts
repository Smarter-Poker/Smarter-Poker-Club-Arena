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

/** Exercise the real client foreground handler through its routed application socket. */
export function requestObserverForegroundProbe(): void {
  document.dispatchEvent(new Event('visibilitychange'));
}
