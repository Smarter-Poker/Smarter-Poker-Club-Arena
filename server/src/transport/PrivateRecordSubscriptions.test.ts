import { describe, expect, it, vi } from 'vitest';
import { PrivateRecordSubscriptions } from './PrivateRecordSubscriptions.js';
const topic =
  'member-record:11111111-1111-1111-1111-111111111111:22222222-2222-2222-2222-222222222222';
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
function fixture() {
  const frames: any[] = [];
  const allow = vi.fn(async () => true);
  const owner = new PrivateRecordSubscriptions({
    current: () => true,
    authorize: allow,
    send: (data, complete) => {
      frames.push(JSON.parse(data));
      complete();
    },
    buffered: () => 0,
    retire: vi.fn(),
    error: vi.fn(),
  });
  return { owner, frames, allow };
}
describe('private record socket ownership', () => {
  it('revalidates topic authority for every delivery and keeps sockets separate', async () => {
    const a = fixture();
    const b = fixture();
    await a.owner.join(topic, () => true);
    await flush();
    a.owner.notify(topic);
    b.owner.notify(topic);
    await flush();
    expect(a.frames.map((x) => x.type)).toEqual([
      'PRIVATE_RECORD_STATUS',
      'PRIVATE_RECORD_CHANGED',
    ]);
    expect(b.frames).toEqual([]);
    a.allow.mockResolvedValue(false);
    a.owner.notify(topic);
    await flush();
    expect(a.frames).toHaveLength(2);
    expect(a.allow).toHaveBeenCalledTimes(4);
  });
  it('never delivers a queued old generation after leave or rejoin', async () => {
    const a = fixture();
    let release!: (value: boolean) => void;
    a.allow.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        })
    );
    const pending = a.owner.join(topic, () => true);
    a.owner.leave(topic);
    release(true);
    await pending;
    await flush();
    expect(a.frames).toEqual([]);
  });
  it('refreshes on listener reconnect only through the authorized queue', async () => {
    const a = fixture();
    await a.owner.join(topic, () => false);
    await flush();
    a.owner.readiness(true);
    await flush();
    expect(a.frames.map((x) => x.ready)).toEqual([false, true]);
  });
});
