import type { PrivateRecordMessage } from './EngineStateClient';
interface RecordTransport {
  onPrivateRecord(topic: string, callback: (message: PrivateRecordMessage) => void): () => void;
}
/** Event-driven transport choice. Standby has no subscription while primary is READY. */
export class PrivateRecordFailover {
  constructor(
    private primary: RecordTransport,
    private standby: RecordTransport
  ) {}
  onPrivateRecord(topic: string, callback: (message: PrivateRecordMessage) => void): () => void {
    let alive = true;
    let primaryReady = false;
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
        if (!alive || primaryReady || generation !== standbyGeneration || message.topic !== topic)
          return;
        if (message.type === 'PRIVATE_RECORD_STATUS') {
          standbyStatus = message;
          callback(message);
        } else if (standbyStatus?.ready === true) callback(message);
      });
      if (alive && !primaryReady && generation === standbyGeneration) stopStandby = stop;
      else stop();
    };
    const stopPrimary = this.primary.onPrivateRecord(topic, (message) => {
      if (!alive || message.topic !== topic) return;
      if (message.type === 'PRIVATE_RECORD_STATUS') {
        primaryReady = message.ready === true;
        if (primaryReady) retireStandby();
        // A primary reconnect must not demote an independently healthy standby.
        callback(!primaryReady && standbyStatus?.ready === true ? standbyStatus : message);
        if (!primaryReady) startStandby();
      } else if (primaryReady) callback(message);
    });
    if (!primaryReady) startStandby();
    return () => {
      alive = false;
      retireStandby();
      stopPrimary();
    };
  }
}
