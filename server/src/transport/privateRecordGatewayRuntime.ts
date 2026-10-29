/** Exact first-party web/iOS/Android origins; no wildcard or originless admission. */
export const PRIVATE_RECORD_GATEWAY_ORIGINS: ReadonlySet<string> = new Set([
  'https://smarter.poker',
  'capacitor://localhost',
  'https://localhost',
]);

/** A hosted gateway never opens a public TCP listener or shares an engine port. */
export function gatewayListenTarget(
  env: Record<string, string | undefined>
): { socket: string } | { port: number; host: '127.0.0.1' } {
  const socket = env.PRIVATE_RECORD_GATEWAY_SOCKET;
  const portText = env.PRIVATE_RECORD_GATEWAY_PORT;
  if (socket && portText) throw new Error('gateway socket and port are mutually exclusive');
  if (socket) {
    const revision = env.PRIVATE_RECORD_GATEWAY_REVISION;
    if (
      !/^[0-9a-f]{40}$/.test(revision ?? '') ||
      socket !== `/run/ca-private-record-gateway/${revision}/listener.sock`
    )
      throw new Error('gateway socket must belong to its exact immutable revision');
    return { socket };
  }
  const port = Number(portText);
  if (!portText || !Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error('gateway requires an explicit private socket or loopback port');
  return { port, host: '127.0.0.1' };
}
