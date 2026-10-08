import { describe, expect, it } from 'vitest';
import {
  observeMissionQuietWindow,
  type MissionQuietSnapshot,
} from '../e2e/support/missionQuietWindow';

function observe(windows: MissionQuietSnapshot[]) {
  let current = { sockets: 1, cursorReads: 0 };
  let count = 0;
  return {
    run: () =>
      observeMissionQuietWindow({
        snapshot: () => ({ ...current }),
        waitUntilLive: async () => undefined,
        waitWindow: async () => {
          current = windows[count++];
        },
      }),
    count: () => count,
  };
}

describe('Daily Missions uninterrupted no-poll proof', () => {
  it('accepts a stable connection with no cursor reads', async () => {
    await expect(observe([{ sockets: 1, cursorReads: 0 }]).run()).resolves.toEqual({
      interruptions: 0,
      sockets: 1,
      cursorReads: 0,
    });
  });
  it('requires a new full quiet window after a natural reconnect and its legitimate read', async () => {
    const observation = observe([
      { sockets: 2, cursorReads: 1 },
      { sockets: 2, cursorReads: 1 },
    ]);
    await expect(observation.run()).resolves.toEqual({
      interruptions: 1,
      sockets: 2,
      cursorReads: 0,
    });
    expect(observation.count()).toBe(2);
  });
  it('refuses polling on a stable socket immediately', async () => {
    const observation = observe([{ sockets: 1, cursorReads: 1 }]);
    await expect(observation.run()).rejects.toThrow('stable Daily Missions socket issued 1');
    expect(observation.count()).toBe(1);
  });
  it('still refuses polling after a natural reconnect', async () => {
    await expect(
      observe([
        { sockets: 2, cursorReads: 1 },
        { sockets: 2, cursorReads: 2 },
      ]).run()
    ).rejects.toThrow('stable Daily Missions socket issued 1');
  });
  it('refuses a provider that never holds a quiet connection within the bound', async () => {
    const observation = observe([
      { sockets: 2, cursorReads: 1 },
      { sockets: 3, cursorReads: 2 },
      { sockets: 4, cursorReads: 3 },
    ]);
    await expect(observation.run()).rejects.toThrow('never held one uninterrupted');
    expect(observation.count()).toBe(3);
  });
});
