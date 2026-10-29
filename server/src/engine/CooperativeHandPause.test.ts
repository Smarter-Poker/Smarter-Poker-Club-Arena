import { describe, expect, it, vi } from 'vitest';
import { CooperativeHandPause } from './CooperativeHandPause.js';

describe('original-hand cooperative mutation custody', () => {
  it('does not attest a pause until every admitted side effect settles', () => {
    const gate = new CooperativeHandPause();
    const first = gate.enterMutation()!;
    const second = gate.enterMutation()!;
    const stable = vi.fn();
    gate.onStable(stable);
    gate.hold('weekly-owner');
    expect(gate.stable('weekly-owner')).toBe(false);
    expect(gate.enterMutation()).toBeNull();
    first();
    first();
    expect(gate.stable('weekly-owner')).toBe(false);
    expect(stable).not.toHaveBeenCalled();
    second();
    expect(gate.stable('weekly-owner')).toBe(true);
    expect(stable).toHaveBeenCalledTimes(1);
  });
  it('retains the original continuation and state until the last owner releases', async () => {
    const gate = new CooperativeHandPause();
    const state = { pot: 17, cards: ['Ah', 'Ks'], turn: 3 };
    gate.hold('weekly-owner');
    gate.hold('second-owner');
    let continued = false;
    const original = (async () => {
      if (await gate.checkpoint()) continued = true;
    })();
    gate.release('foreign-owner');
    gate.release('weekly-owner');
    await Promise.resolve();
    expect(continued).toBe(false);
    expect(state).toEqual({ pot: 17, cards: ['Ah', 'Ks'], turn: 3 });
    gate.release('second-owner');
    await original;
    expect(continued).toBe(true);
  });
  it('a new hold before the queued continuation resumes keeps it parked', async () => {
    const gate = new CooperativeHandPause();
    gate.hold('first');
    let continued = false;
    const original = gate.checkpoint().then((ok) => {
      continued = ok;
    });
    gate.release('first');
    gate.hold('second');
    await Promise.resolve();
    expect(continued).toBe(false);
    gate.release('second');
    await original;
    expect(continued).toBe(true);
  });
  it('shutdown cannot resume a waiting hand or attest stopped custody', async () => {
    const gate = new CooperativeHandPause();
    gate.hold('weekly-owner');
    const original = gate.checkpoint();
    gate.stop();
    expect(await original).toBe(false);
    expect(gate.stable('weekly-owner')).toBe(false);
    expect(gate.enterMutation()).toBeNull();
  });
});
