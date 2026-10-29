import { describe, expect, it } from 'vitest';
import { PrivateRecordFailover } from '../../src/services/PrivateRecordFailover';
import type { PrivateRecordMessage } from '../../src/services/EngineStateClient';
const topic = 'club-roster:11111111-1111-1111-1111-111111111111';
function transport() {
  let receive: (message: PrivateRecordMessage) => void = () => {};
  let active = false;
  return {
    get active() {
      return active;
    },
    onPrivateRecord: (_topic: string, callback: typeof receive) => {
      active = true;
      receive = callback;
      return () => {
        active = false;
      };
    },
    emit: (message: PrivateRecordMessage) => receive(message),
  };
}
const status = (ready: boolean): PrivateRecordMessage => ({
  type: 'PRIVATE_RECORD_STATUS',
  topic,
  ready,
  phase: 'unavailable',
});
const changed: PrivateRecordMessage = { type: 'PRIVATE_RECORD_CHANGED', topic };
describe('private record failover', () => {
  it('uses standby until primary READY then retires its delivery authority synchronously', () => {
    const primary = transport();
    const standby = transport();
    const frames: PrivateRecordMessage[] = [];
    const stop = new PrivateRecordFailover(primary, standby).onPrivateRecord(topic, (m) =>
      frames.push(m)
    );
    expect(standby.active).toBe(true);
    standby.emit(status(true));
    standby.emit(changed);
    expect(frames.at(-1)).toEqual(changed);
    primary.emit(status(true));
    expect(standby.active).toBe(false);
    const count = frames.length;
    standby.emit(status(false));
    standby.emit(changed);
    expect(frames).toHaveLength(count);
    primary.emit(changed);
    expect(frames).toHaveLength(count + 1);
    stop();
    expect(primary.active).toBe(false);
  });
  it('activates an independent standby on primary loss and owes a recovery refresh', () => {
    const primary = transport();
    const standby = transport();
    const frames: PrivateRecordMessage[] = [];
    const stop = new PrivateRecordFailover(primary, standby).onPrivateRecord(topic, (m) =>
      frames.push(m)
    );
    primary.emit(status(true));
    primary.emit(status(false));
    expect(standby.active).toBe(true);
    standby.emit(status(true));
    standby.emit(changed);
    expect(frames.slice(-3)).toEqual([status(false), status(true), changed]);
    standby.emit(status(false));
    expect(frames.at(-1)).toEqual(status(false));
    standby.emit(status(true));
    expect(frames.at(-1)).toEqual(status(true));
    stop();
  });
  it('keeps a healthy standby authoritative through repeated primary reconnect statuses', () => {
    const primary = transport();
    const standby = transport();
    const frames: PrivateRecordMessage[] = [];
    const stop = new PrivateRecordFailover(primary, standby).onPrivateRecord(topic, (m) =>
      frames.push(m)
    );
    standby.emit(status(true));
    primary.emit(status(false));
    expect(frames.at(-1)).toEqual(status(true));
    standby.emit(changed);
    expect(frames.at(-1)).toEqual(changed);
    stop();
  });
  it('does not accept other topics or a callback after disposal', () => {
    const primary = transport();
    const standby = transport();
    const frames: PrivateRecordMessage[] = [];
    const stop = new PrivateRecordFailover(primary, standby).onPrivateRecord(topic, (m) =>
      frames.push(m)
    );
    primary.emit({ ...status(true), topic: 'club-roster:wrong' });
    expect(frames).toEqual([]);
    stop();
    primary.emit(status(true));
    standby.emit(status(true));
    expect(frames).toEqual([]);
  });
});
