/**
 * A SLIDER DRAG IS ONE DECISION, NOT SIXTY WRITES
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Cross-device filters made every store change write a row to the database.
 * The blinds and seat controls are <input type="range">, and onChange fires on
 * EVERY value change while the thumb moves - so one drag across a 0-15,000
 * slider became dozens of upserts of the same row. A write storm on the
 * database, paid for again in bandwidth on a phone, for a gesture with exactly
 * one meaningful result: where the thumb was released.
 *
 * localStorage still writes immediately - it is synchronous and free, and it
 * is what makes "saves when clicked" true without waiting on a network. Only
 * the remote push is debounced.
 *
 * The second half matters just as much: a player who taps one chip and closes
 * the sheet straight away is the COMMON case, and if the pending write were
 * simply dropped they would lose the cross-device half of that choice until
 * they happened to change something else. So the timer is flushed on unmount.
 *
 * These model the exact timer logic the component uses.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { REMOTE_SYNC_DEBOUNCE_MS } from '../../src/components/lobby/AdvancedFilters';

/** The component's scheduling rule, extracted so it can be driven by fake timers. */
function makeSyncer(push: (v: string) => void) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: string | null = null;
  return {
    change(value: string) {
      pending = value;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        const p = pending;
        pending = null;
        if (p) push(p);
      }, REMOTE_SYNC_DEBOUNCE_MS);
    },
    unmount() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      const p = pending;
      pending = null;
      if (p) push(p);
    },
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('remote filter sync', () => {
  it('collapses a whole slider drag into ONE write, carrying the final value', () => {
    const push = vi.fn();
    const s = makeSyncer(push);
    // 60 onChange events, as a real drag produces.
    for (let i = 0; i < 60; i += 1) s.change(`v${i}`);
    expect(push).not.toHaveBeenCalled(); // nothing yet - the thumb is moving

    vi.advanceTimersByTime(REMOTE_SYNC_DEBOUNCE_MS);
    expect(push).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith('v59'); // where the thumb was released
  });

  it('writes separate decisions separately', () => {
    const push = vi.fn();
    const s = makeSyncer(push);
    s.change('first');
    vi.advanceTimersByTime(REMOTE_SYNC_DEBOUNCE_MS);
    s.change('second');
    vi.advanceTimersByTime(REMOTE_SYNC_DEBOUNCE_MS);
    expect(push).toHaveBeenCalledTimes(2);
    expect(push).toHaveBeenLastCalledWith('second');
  });

  it('flushes on close, so tap-then-close is not lost', () => {
    const push = vi.fn();
    const s = makeSyncer(push);
    s.change('tapped a chip');
    s.unmount(); // player closes the sheet immediately
    expect(push).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith('tapped a chip');
  });

  it('does not double-write when the debounce already fired before close', () => {
    const push = vi.fn();
    const s = makeSyncer(push);
    s.change('settled');
    vi.advanceTimersByTime(REMOTE_SYNC_DEBOUNCE_MS);
    s.unmount();
    expect(push).toHaveBeenCalledTimes(1);
  });

  it('writes nothing at all when the player changed nothing', () => {
    const push = vi.fn();
    const s = makeSyncer(push);
    s.unmount();
    expect(push).not.toHaveBeenCalled();
  });
});
