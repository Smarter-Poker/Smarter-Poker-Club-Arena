/**
 * THE ENGINE'S "NOTHING ARMED" PUSH MUST NOT OUTRUN THE TURN (2026-09-08).
 *
 * Dan 2026-09-04: "WHEN YOU CLICK THE FOLD BUTTON WHEN USING THE PRE ACTION
 * BAR ... IT STILL 'PROMPTS YOU' AND STARTS THE CLOCK FOR A SPLIT SECOND
 * INSTEAD OF JUST EXECUTING THE PRE TURN ACTION YOU'VE SELECTED."
 *
 * handleTurnChange consumes the pre-action synchronously, at its top, before
 * the visible beat, the snapshot and the turn_change. PreActionEngine emits
 * PRE_ACTION_EXECUTED right there, and the engine used to push the (now
 * empty) copy to the hero at once - a frame AHEAD of the snapshot that put
 * them on the clock. The client's bar disarmed on it, its suppression of every
 * "your turn" surface had nothing left to key on, and the bell, ring, clock
 * and panel all fired for a turn the engine was already taking. Two client
 * fixes (2026-08-29, 2026-09-04) were correct on paper and dead in practice.
 *
 * The contract now: no push on execution (the executed action clears the
 * client's arm when it lands); a REJECTED execution pushes explicitly with
 * `reason: 'rejected'`; invalidation and clearing push with their reasons;
 * RESYNC pushes with `reason: 'resync'`. A push without a reason no longer
 * exists on this engine, which is what lets the client hold one from an
 * older one.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

const { ServerTableEngine } = await import('./ServerTableEngine.js');

const TABLE = 'eeeeeeee-1111-2222-3333-444444444444';

afterEach(() => vi.restoreAllMocks());

function engine() {
  const e = new ServerTableEngine(TABLE) as any;
  e.hub = { emitEvent: vi.fn(), sendToUser: vi.fn().mockReturnValue(1) };
  return e;
}

describe('what the engine pushes to the hero about their pre-action', () => {
  it('pushes the arm when it is SET, with no reason', () => {
    const e = engine();
    e.preActionEngine.setPreAction(TABLE, 'hero', 'auto_fold', 0);
    const frames = e.hub.sendToUser.mock.calls.map((c: any[]) => c[2]);
    expect(frames.at(-1)).toEqual(
      expect.objectContaining({ kind: 'pre_action', action: 'auto_fold' })
    );
    expect(frames.at(-1).reason).toBeUndefined();
  });

  it('does NOT push when the pre-action is EXECUTED - that frame outran the turn', () => {
    const e = engine();
    e.preActionEngine.setPreAction(TABLE, 'hero', 'auto_fold', 0);
    e.hub.sendToUser.mockClear();
    const r = e.preActionEngine.executePreAction(TABLE, 'hero', true, 0, 100);
    expect(r.executed).toBe(true);
    expect(e.hub.sendToUser).not.toHaveBeenCalled();
  });

  it('pushes "nothing armed" WITH its reason when a Check is invalidated by a bet', () => {
    const e = engine();
    e.preActionEngine.setPreAction(TABLE, 'hero', 'auto_check', 0);
    e.hub.sendToUser.mockClear();
    e.preActionEngine.onBetPlaced(TABLE, 'villain');
    const frame = e.hub.sendToUser.mock.calls.at(-1)?.[2];
    expect(frame).toEqual(
      expect.objectContaining({ kind: 'pre_action', action: null, reason: 'invalidated' })
    );
  });

  it('pushes "nothing armed" WITH its reason when the player clears it', () => {
    const e = engine();
    e.preActionEngine.setPreAction(TABLE, 'hero', 'auto_fold', 0);
    e.hub.sendToUser.mockClear();
    e.preActionEngine.clearPreAction(TABLE, 'hero');
    const frame = e.hub.sendToUser.mock.calls.at(-1)?.[2];
    expect(frame).toEqual(
      expect.objectContaining({ kind: 'pre_action', action: null, reason: 'cleared' })
    );
  });

  it('RESYNC re-sends the engine copy as authoritative, reason resync', () => {
    const e = engine();
    e.rePushPreAction('hero');
    const frame = e.hub.sendToUser.mock.calls.at(-1)?.[2];
    expect(frame).toEqual(
      expect.objectContaining({ kind: 'pre_action', action: null, reason: 'resync' })
    );
  });

  it('a REJECTED execution is pushed from the turn handler with reason rejected', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const { sliceMethod } = await import('../testHelpers/sourceWindow.js');
    const turns = readFileSync(
      resolve(process.cwd(), 'src/engine/ServerTableEngineTurns.ts'),
      'utf8'
    );
    const body = sliceMethod(turns, 'protected async handleTurnChange(');
    // The push sits on the rejected fallthrough, after performAction returned
    // false and before the turn timer is armed.
    const rejected = body.indexOf('falling through to the turn timer');
    const timer = body.indexOf('Step 2: Check disconnect state');
    expect(rejected).toBeGreaterThan(-1);
    expect(timer).toBeGreaterThan(rejected);
    expect(body.slice(rejected, timer)).toMatch(
      /this\.pushPreActionToPlayer\(player\.user_id, \{ reason: 'rejected' \}\)/
    );
  });
});
