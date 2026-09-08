import { describe, expect, it, vi } from 'vitest';
import { ServerTableEngine } from './ServerTableEngine.js';

const TABLE_ID = '81818181-8181-4181-8181-818181818181';

describe('between-hands pause signal', () => {
  it('publishes the exact barrier edge after the engine is actually waiting', async () => {
    const engine = new ServerTableEngine(TABLE_ID);
    const internal = engine as any;
    internal.running = true;
    internal.handForHandPaused = true;

    const waitingAtSignal: boolean[] = [];
    engine.onPauseReady(() => waitingAtSignal.push(engine.isWaitingForHandForHand()));

    const parked = internal.awaitPauseGate() as Promise<void>;
    expect(waitingAtSignal).toEqual([true]);
    expect(engine.isWaitingForHandForHand()).toBe(true);
    expect(internal.pauseGateTimer).not.toBeNull();

    engine.resumeDealing();
    await parked;
    expect(engine.isWaitingForHandForHand()).toBe(false);
    expect(internal.pauseGateTimer).toBeNull();
  });

  it('lets a retired owner detach before the next pause edge', async () => {
    const engine = new ServerTableEngine('82828282-8282-4282-8282-828282828282');
    const internal = engine as any;
    internal.running = true;
    internal.handForHandPaused = true;
    const callback = vi.fn();
    const detach = engine.onPauseReady(callback);
    detach();

    const parked = internal.awaitPauseGate() as Promise<void>;
    expect(callback).not.toHaveBeenCalled();
    engine.resumeDealing();
    await parked;
  });

  it('a terminal engine releases the parked loop and cancels its escape timer', async () => {
    const engine = new ServerTableEngine('83838383-8383-4383-8383-838383838383');
    const internal = engine as any;
    internal.running = true;
    internal.handForHandPaused = true;

    const parked = internal.awaitPauseGate() as Promise<void>;
    expect(internal.pauseGateTimer).not.toBeNull();
    await engine.stop();
    await parked;
    expect(internal.handForHandResolve).toBeNull();
    expect(internal.pauseGateTimer).toBeNull();
  });
});
