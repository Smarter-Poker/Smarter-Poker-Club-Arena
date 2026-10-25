/**
 * A Lightning "not now" waits for the hand (2026-10-24).
 *
 * Production, 2026-10-24 06:23-06:39: one player at two Lightning anchor
 * tables was refused "Your Chips Are In A Lightning Hand" 392 times, with an
 * error toast every time. The anchor is halted while Lightning runs, so the
 * Auto Top Up effect saw "between hands" on every snapshot and asked again.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  LIGHTNING_ADD_ON_REFUSED_TEXT,
  LIGHTNING_HOLD_MAX_CHECK_MS,
  LIGHTNING_HOLD_MAX_UNANSWERED,
  LightningAddOnHold,
  isLightningAddOnRefusal,
  lightningHoldDelay,
} from '../../src/lightning/lightningAddOnHold';
import { LIGHTNING_ADD_ON_REFUSED_MESSAGE } from '../../server/src/lightning/rpcErrors';

const root = resolve(__dirname, '../..');
const read = (file: string) => readFileSync(resolve(root, file), 'utf8');

/** A manual clock: timers run only when the test says so. */
function manualTimers() {
  const pending: Array<{ fn: () => void; ms: number }> = [];
  return {
    pending,
    setTimer: (fn: () => void, ms: number) => {
      const t = { fn, ms };
      pending.push(t);
      return t;
    },
    clearTimer: (h: unknown) => {
      const i = pending.indexOf(h as never);
      if (i >= 0) pending.splice(i, 1);
    },
    async fire() {
      const t = pending.shift();
      if (!t) throw new Error('no timer pending');
      t.fn();
      await new Promise((r) => setTimeout(r, 0));
      return t.ms;
    },
  };
}

describe('the refusal sentence', () => {
  it('is the engine constant, verbatim', () => {
    expect(LIGHTNING_ADD_ON_REFUSED_TEXT).toBe(LIGHTNING_ADD_ON_REFUSED_MESSAGE);
    expect(isLightningAddOnRefusal(LIGHTNING_ADD_ON_REFUSED_MESSAGE)).toBe(true);
    expect(isLightningAddOnRefusal('Insufficient balance')).toBe(false);
    expect(isLightningAddOnRefusal(undefined)).toBe(false);
  });
});

describe('LightningAddOnHold', () => {
  it('reproduces the loop without a hold, and closes it with one', async () => {
    /* A model of the effect: it runs once per snapshot and asks whenever the
       seat is short and nothing says wait. The engine refuses every ask while
       the Lightning hand is live. */
    let handLive = true;
    const engineAsks: number[] = [];
    const run = (hold: LightningAddOnHold | null, snapshots: number) => {
      for (let s = 0; s < snapshots; s++) {
        if (hold?.isHeld()) continue;
        engineAsks.push(s);
        if (handLive) hold?.engage('cluster-1');
      }
    };
    run(null, 60);
    expect(engineAsks).toHaveLength(60); // one refusal per snapshot: the bug

    engineAsks.length = 0;
    const timers = manualTimers();
    const released = vi.fn();
    const hold = new LightningAddOnHold({
      inHand: async () => handLive,
      onRelease: released,
      ...timers,
    });
    run(hold, 60);
    expect(engineAsks).toHaveLength(1); // asked once, then waited

    await timers.fire(); // still in the hand
    expect(released).not.toHaveBeenCalled();
    run(hold, 60);
    expect(engineAsks).toHaveLength(1);

    handLive = false; // the hand settles
    await timers.fire();
    expect(released).toHaveBeenCalledOnce();
    expect(hold.isHeld()).toBe(false);
    run(hold, 1);
    expect(engineAsks).toHaveLength(2); // and the top-up goes through
  });

  it('asks on a growing interval with a ceiling', () => {
    expect(lightningHoldDelay(0)).toBe(2_000);
    expect(lightningHoldDelay(1)).toBe(3_000);
    expect(lightningHoldDelay(20)).toBe(LIGHTNING_HOLD_MAX_CHECK_MS);
  });

  it('a second refusal inside the hold does not start a second wait', () => {
    const timers = manualTimers();
    const hold = new LightningAddOnHold({
      inHand: async () => true,
      onRelease: vi.fn(),
      ...timers,
    });
    hold.engage('c');
    hold.engage('c');
    hold.engage('c');
    expect(timers.pending).toHaveLength(1);
  });

  it('an unanswerable question keeps waiting, then lets one attempt through', async () => {
    const timers = manualTimers();
    const released = vi.fn();
    const hold = new LightningAddOnHold({
      inHand: async () => {
        throw new Error('offline');
      },
      onRelease: released,
      ...timers,
    });
    hold.engage('c');
    for (let i = 0; i < LIGHTNING_HOLD_MAX_UNANSWERED - 1; i++) await timers.fire();
    expect(released).not.toHaveBeenCalled();
    await timers.fire();
    expect(released).toHaveBeenCalledOnce();
  });

  it('with no Cluster to ask about, waits the longest interval once', async () => {
    const timers = manualTimers();
    const released = vi.fn();
    const inHand = vi.fn();
    const hold = new LightningAddOnHold({ inHand, onRelease: released, ...timers });
    hold.engage(null);
    expect(hold.isHeld()).toBe(true);
    expect(await timers.fire()).toBe(LIGHTNING_HOLD_MAX_CHECK_MS);
    expect(inHand).not.toHaveBeenCalled();
    expect(released).toHaveBeenCalledOnce();
  });

  it('reset forgets the wait and a late answer releases nothing', async () => {
    let answer!: (v: boolean) => void;
    const timers = manualTimers();
    const released = vi.fn();
    const hold = new LightningAddOnHold({
      inHand: () => new Promise<boolean>((r) => (answer = r)),
      onRelease: released,
      ...timers,
    });
    hold.engage('c');
    void timers.fire();
    await new Promise((r) => setTimeout(r, 0));
    hold.reset();
    answer(false);
    await new Promise((r) => setTimeout(r, 0));
    expect(released).not.toHaveBeenCalled();
    expect(hold.isHeld()).toBe(false);
  });
});

describe('TablePage wiring', () => {
  const page = read('src/pages/TablePage.tsx');

  it('treats the refusal as a hold, not a reported error, before the generic path', () => {
    const at = page.indexOf('if (isLightningAddOnRefusal(res.error)) {');
    const generic = page.indexOf("'TablePage.addChips_engine_rejected'");
    expect(at).toBeGreaterThan(-1);
    expect(generic).toBeGreaterThan(at);
    // The branch ends at its own `return false;` - delimited by the code, not
    // by a character count.
    const end = page.indexOf('return false;', at);
    expect(end).toBeGreaterThan(at);
    expect(end).toBeLessThan(generic);
    const branch = page.slice(at, end);
    expect(branch).toContain('hold?.engage(');
    expect(branch).not.toContain('toast.error');
    expect(branch).not.toContain('reportError');
  });

  it('the automatic top-up does not ask while held, and re-runs on release', () => {
    expect(page).toContain('!lightningAddOnHoldRef.current?.isHeld() &&');
    const deps = page.indexOf('    handleSitOut,\n    lightningHoldRelease,\n  ]);');
    expect(deps).toBeGreaterThan(-1);
  });
});
