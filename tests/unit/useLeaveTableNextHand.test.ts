import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LeaveTableNextHandController,
  type LeaveNextHandInputs,
} from '../../src/hooks/useLeaveTableNextHand';
const tick = async () => {
  await Promise.resolve();
  await Promise.resolve();
};
let input: LeaveNextHandInputs;
beforeEach(() => {
  localStorage.clear();
  input = {
    ready: true,
    userId: 'user',
    tableId: 'table',
    occupancyId: 'seat1',
    seated: true,
    handLive: true,
    completionVersion: 1,
    setSitOut: vi.fn(async () => ({ success: true })),
    onLeave: vi.fn(),
  };
});
describe('next hand departure uses accepted sit-out and authoritative completion', () => {
  it('waits for completion, and never folds or leaves during the current hand', async () => {
    const c = new LeaveTableNextHandController(localStorage);
    c.update(input);
    await c.request();
    expect(input.setSitOut).toHaveBeenCalledOnce();
    expect(input.onLeave).not.toHaveBeenCalled();
    c.update({ ...input, handLive: false });
    await tick();
    expect(input.onLeave).not.toHaveBeenCalled();
    c.update({ ...input, handLive: false, completionVersion: 2 });
    await tick();
    c.update({ ...input, handLive: false, completionVersion: 2 });
    await tick();
    expect(input.onLeave).toHaveBeenCalledOnce();
  });
  it('handles completion before a delayed sit-out acknowledgement', async () => {
    let acknowledge!: (x: { success: boolean }) => void;
    input.setSitOut = vi.fn(
      () =>
        new Promise((resolve) => {
          acknowledge = resolve;
        })
    );
    const c = new LeaveTableNextHandController(localStorage);
    c.update(input);
    const request = c.request();
    await c.request();
    c.update({ ...input, handLive: false, completionVersion: 2 });
    expect(input.onLeave).not.toHaveBeenCalled();
    acknowledge({ success: true });
    await request;
    await tick();
    expect(input.setSitOut).toHaveBeenCalledOnce();
    expect(input.onLeave).toHaveBeenCalledOnce();
  });
  it('does not leave a new live hand even if an earlier completion arrived', async () => {
    const c = new LeaveTableNextHandController(localStorage);
    c.update(input);
    await c.request();
    c.update({ ...input, completionVersion: 2, handLive: true });
    await tick();
    expect(input.onLeave).not.toHaveBeenCalled();
    c.update({ ...input, completionVersion: 3, handLive: false });
    await tick();
    expect(input.onLeave).toHaveBeenCalledOnce();
  });
  it('refuses departure when the server refuses sit-out', async () => {
    input.setSitOut = vi.fn(async () => ({ success: false, error: 'Seat Locked' }));
    const c = new LeaveTableNextHandController(localStorage);
    c.update(input);
    expect(await c.request()).toBe(false);
    c.update({ ...input, handLive: false, completionVersion: 2 });
    await tick();
    expect(input.onLeave).not.toHaveBeenCalled();
    expect(localStorage.length).toBe(0);
  });
  it('isolates a changed occupancy from a delayed acknowledgement', async () => {
    let acknowledge!: (x: { success: boolean }) => void;
    input.setSitOut = vi.fn(
      () =>
        new Promise((resolve) => {
          acknowledge = resolve;
        })
    );
    const c = new LeaveTableNextHandController(localStorage);
    c.update(input);
    const request = c.request();
    c.update({ ...input, occupancyId: 'seat2', handLive: false, completionVersion: 2 });
    acknowledge({ success: true });
    await request;
    await tick();
    expect(input.onLeave).not.toHaveBeenCalled();
    expect(localStorage.length).toBe(0);
  });
  it('restores the exact occupancy across refresh and rearms only an idempotent sit-out', async () => {
    const c = new LeaveTableNextHandController(localStorage);
    c.update(input);
    await c.request();
    c.deactivate();
    const restored = new LeaveTableNextHandController(localStorage);
    restored.update(input);
    await tick();
    expect(input.onLeave).not.toHaveBeenCalled();
    restored.update({ ...input, handLive: false, completionVersion: 2 });
    await tick();
    expect(input.onLeave).toHaveBeenCalledOnce();
    expect(localStorage.length).toBe(0);
  });
  it('leaves between hands after acknowledgement and suppresses duplicate pending leave calls', async () => {
    input.handLive = false;
    input.onLeave = vi.fn(() => new Promise(() => {}));
    const c = new LeaveTableNextHandController(localStorage);
    c.update(input);
    await c.request();
    await tick();
    await c.request();
    c.update(input);
    await tick();
    expect(input.onLeave).toHaveBeenCalledOnce();
  });
  it('does not mistake an unknown refresh completion for a new hand boundary', async () => {
    const c = new LeaveTableNextHandController(localStorage);
    c.update({ ...input, completionVersion: 'hand-old' });
    await c.request();
    c.deactivate();
    const restored = new LeaveTableNextHandController(localStorage);
    restored.update({ ...input, handLive: false, completionVersion: '' });
    await tick();
    expect(input.onLeave).not.toHaveBeenCalled();
    restored.update({ ...input, handLive: false, completionVersion: 'hand-new' });
    await tick();
    expect(input.onLeave).toHaveBeenCalledOnce();
  });
  it('waits for a hand boundary when the server started a hand after the idle click', async () => {
    input.handLive = false;
    input.setSitOut = vi.fn(async () => ({ success: true, willFoldNextHand: true }));
    const c = new LeaveTableNextHandController(localStorage);
    c.update(input);
    await c.request();
    expect(input.onLeave).not.toHaveBeenCalled();
    c.update({ ...input, handLive: true });
    expect(input.onLeave).not.toHaveBeenCalled();
    c.update({ ...input, handLive: false, completionVersion: 2 });
    await tick();
    expect(input.onLeave).toHaveBeenCalledOnce();
  });
  it('retains a restored intent while engine scope is unknown without arming or leaving', async () => {
    const c = new LeaveTableNextHandController(localStorage);
    c.update(input);
    await c.request();
    c.deactivate();
    vi.mocked(input.setSitOut).mockClear();
    const restored = new LeaveTableNextHandController(localStorage);
    restored.update({
      ...input,
      ready: false,
      seated: false,
      handLive: false,
      completionVersion: 'stale-bootstrap',
    });
    await tick();
    expect(localStorage.length).toBe(1);
    expect(input.setSitOut).not.toHaveBeenCalled();
    expect(input.onLeave).not.toHaveBeenCalled();
    expect(await restored.request()).toBe(false);
    restored.update({ ...input, ready: true });
    await tick();
    expect(input.setSitOut).toHaveBeenCalledOnce();
    expect(input.onLeave).not.toHaveBeenCalled();
    restored.update({ ...input, handLive: false, completionVersion: 2 });
    await tick();
    expect(input.onLeave).toHaveBeenCalledOnce();
  });
});
