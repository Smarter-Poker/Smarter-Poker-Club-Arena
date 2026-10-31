import type { PrivateRecordMessage } from './EngineStateClient';
interface RecordTransport {
  onPrivateRecord(topic: string, callback: (message: PrivateRecordMessage) => void): () => void;
}
/** Keep an acknowledged transport until it fails; a recovering peer cannot evict it. */
export class PrivateRecordFailover {
  constructor(
    private primary: RecordTransport,
    private standby: RecordTransport
  ) {}
  onPrivateRecord(topic: string, callback: (message: PrivateRecordMessage) => void): () => void {
    let alive = true;
    let primaryReady = false;
    let primaryStatus: PrivateRecordMessage | null = null;
    let standbyStatus: PrivateRecordMessage | null = null;
    let standbyGeneration = 0;
    let stopStandby: (() => void) | null = null;
    const retireStandby = () => {
      standbyGeneration++;
      standbyStatus = null;
      const stop = stopStandby;
      stopStandby = null;
      stop?.();
    };
    const startStandby = () => {
      if (!alive || primaryReady || stopStandby) return;
      const generation = ++standbyGeneration;
      const stop = this.standby.onPrivateRecord(topic, (message) => {
        if (!alive || generation !== standbyGeneration || message.topic !== topic) return;
        if (message.type === 'PRIVATE_RECORD_STATUS') {
          standbyStatus = message;
          if (!message.ready && primaryReady && primaryStatus) {
            retireStandby();
            callback(primaryStatus);
          } else callback(message);
        } else if (standbyStatus?.ready === true) callback(message);
      });
      if (alive && !primaryReady && generation === standbyGeneration) stopStandby = stop;
      else stop();
    };
    const stopPrimary = this.primary.onPrivateRecord(topic, (message) => {
      if (!alive || message.topic !== topic) return;
      if (message.type === 'PRIVATE_RECORD_STATUS') {
        primaryStatus = message;
        primaryReady = message.ready === true;
        // The serving legacy engine can acknowledge and then evict this socket
        // at its per-user cap. Never discard a healthy independent listener
        // for that transient recovery, or every cycle creates another outage.
        if (standbyStatus?.ready === true) return;
        if (primaryReady) retireStandby();
        callback(message);
        if (!primaryReady) startStandby();
      } else if (primaryReady && standbyStatus?.ready !== true) callback(message);
    });
    if (!primaryReady) startStandby();
    return () => {
      alive = false;
      retireStandby();
      stopPrimary();
    };
  }
}
