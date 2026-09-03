/**
 * THE REAPER'S TRUST, MADE AUDITABLE.
 *
 * GameServer's zombie reaper deletes a not-running engine from its map without
 * tearing it down, on the assumption that whatever cleared `running` already
 * did. That assumption holds for every path today — `stop()` and
 * `killForRestart()` both tear down at source — but it is trust, not
 * enforcement, and the cost of it being wrong once is a heartbeat entry and
 * armed turn deadlines belonging to a table nothing owns any more. The table
 * stops being watched, and every stall on it becomes permanent.
 *
 * `stop()` cannot be the enforcement: its first line is
 * `if (!this.running) return`, so calling it from the reaper would be a no-op
 * dressed up as a safety net — worse than nothing, because the next reader
 * would believe it.
 *
 * The ownership guard is what makes cleanup safe rather than catastrophic: if a
 * REPLACEMENT engine has claimed the tableId, the scheduler entries are its
 * entries, and cancelling them would cause the exact freeze this guards
 * against. That case is the third test and it is the important one.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { ServerTableEngine } from './ServerTableEngine.js';
import { deadlineScheduler } from './DeadlineScheduler.js';

const TABLE = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';

afterEach(() => {
  deadlineScheduler.cancelAll(TABLE);
});

const arm = (eventId: string) =>
  deadlineScheduler.schedule({
    tableId: TABLE,
    eventId,
    deadlineMs: Date.now() + 60_000,
    callback: () => {},
  });

describe('reconcileTeardown', () => {
  it('says nothing about a running engine - it is supposed to hold deadlines', () => {
    const e = new ServerTableEngine(TABLE) as any;
    e.running = true;
    arm('heartbeat_check');
    expect(e.reconcileTeardown()).toBeNull();
  });

  it('says nothing when a stopped engine tore itself down properly', () => {
    const e = new ServerTableEngine(TABLE) as any;
    e.running = false;
    expect(e.reconcileTeardown()).toBeNull();
  });

  it('refuses to touch deadlines once a REPLACEMENT engine owns the table', () => {
    const old = new ServerTableEngine(TABLE) as any;
    // Constructing the second engine makes it the current one for this id.
    const live = new ServerTableEngine(TABLE) as any;
    old.running = false;
    arm('heartbeat_check');

    expect(old.reconcileTeardown()).toBeNull();
    // The live engine's clock is still armed. Cancelling it here is precisely
    // how a table permanently loses its watchdog.
    expect(deadlineScheduler.persistPending(TABLE)).toHaveLength(1);
    expect(live).toBeDefined();
  });

  it('names and cancels what a stopped owner left behind', () => {
    const e = new ServerTableEngine(TABLE) as any;
    e.running = false;
    arm('heartbeat_check');
    arm('turn:seat3');

    const leaked = e.reconcileTeardown();

    expect(leaked).toBe('heartbeat_check, turn:seat3');
    expect(deadlineScheduler.persistPending(TABLE)).toHaveLength(0);
  });
});
