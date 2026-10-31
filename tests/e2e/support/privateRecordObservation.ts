export interface PrivateRecordObservation {
  endpoint: 'engine' | 'gateway';
  socket: number;
  topic: string;
  type: string;
  ready?: boolean;
}

/** A retained READY is valid only while its socket remains open and ready. */
export function hasLiveGatewayReady(
  frames: PrivateRecordObservation[],
  openSockets: Set<number>,
  topic: string
): boolean {
  const latest = new Map<number, boolean>();
  for (const frame of frames) {
    if (
      frame.endpoint === 'gateway' &&
      frame.topic === topic &&
      frame.type === 'PRIVATE_RECORD_STATUS'
    )
      latest.set(frame.socket, frame.ready === true);
  }
  return [...latest].some(([socket, ready]) => ready && openSockets.has(socket));
}
