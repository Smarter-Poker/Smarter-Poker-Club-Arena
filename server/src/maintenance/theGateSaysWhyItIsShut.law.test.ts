/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  LAW: THE GATE SAYS WHY IT IS SHUT (2026-09-18)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The restart gate is one boolean, and on the night of 2026-09-17 it stayed
 * false through five consecutive breaks while the engine went eight hours
 * without a release. Each time the only published number was the unparked
 * COUNT:
 *
 *   23:55  3 tables unparked, flat for the whole five minutes
 *   00:55 16 tables unparked, flat
 *   01:55 22 tables unparked, flat  (cut over by hand)
 *   02:55 22 falling to 17 during last_hand, then flat
 *
 * Every one of those tables had logged "Parked between hands", none had a
 * presence-persist error, and none had a refused park write. Which of the
 * four conditions held the gate had to be reconstructed from the database,
 * the container log and the source, at three in the morning, twice.
 *
 * A gate that can refuse for four different reasons must say which one. These
 * pins are that: the engine answers with the reason, the boolean is DERIVED
 * from the reason so the two can never disagree, the break counts the reasons
 * it refused for, and the scrape carries every reason zero-seeded so a rule
 * can read one before it has ever been the reason.
 */

import { describe, expect, it } from 'vitest';
import { MaintenanceBreak } from './MaintenanceBreak.js';

type Engine = {
  isRunning: () => boolean;
  isBetweenHands: () => boolean;
  isParkedBetweenHands: () => boolean;
  pauseForMaintenance: (ms: number) => void;
  resumeFromMaintenance: () => void;
  isMaintenanceStateDurable?: () => boolean;
  maintenanceDurabilityReason?: () => string | null;
};

/** A table with whatever answers the case needs. */
const table = (over: Partial<Engine> = {}): Engine => ({
  isRunning: () => true,
  isBetweenHands: () => true,
  isParkedBetweenHands: () => true,
  pauseForMaintenance: () => {},
  resumeFromMaintenance: () => {},
  isMaintenanceStateDurable: () => true,
  maintenanceDurabilityReason: () => null,
  ...over,
});

const notDurable = (reason: string | null): Partial<Engine> => ({
  isMaintenanceStateDurable: () => false,
  maintenanceDurabilityReason: () => reason,
});

/** A break already counting down, with this set of engines. */
function countingDown(engines: Array<[string, Engine]>): MaintenanceBreak {
  const mb = new MaintenanceBreak({
    engines: () => new Map(engines) as never,
    isRunning: () => true,
  } as never);
  // The phase and the durable flag are what snapshot() reads; the pins below
  // are about the reason breakdown, not about how a break is announced.
  Object.assign(mb as never, { phase: 'counting_down', durableConfirmed: true });
  return mb;
}

const reasons = (mb: MaintenanceBreak): Record<string, number> =>
  (mb.snapshot().unparkedReasons ?? {}) as Record<string, number>;

describe('the restart gate says why it is shut', () => {
  it('counts a table with cards in the air as cards_in_air', () => {
    const mb = countingDown([
      ['a', table({ isBetweenHands: () => false })],
      ['b', table()],
    ]);
    expect(mb.snapshot().unparkedTables).toBe(1);
    expect(reasons(mb)).toMatchObject({ cards_in_air: 1 });
  });

  it('counts each durability reason under its own name', () => {
    const mb = countingDown([
      ['a', table(notDurable('accounting_pending'))],
      ['b', table(notDurable('accounting_pending'))],
      ['c', table(notDurable('bank_park_write_incomplete'))],
      ['d', table(notDurable('accounting_unconfirmed'))],
      ['e', table()],
    ]);
    expect(mb.snapshot().unparkedTables).toBe(4);
    expect(reasons(mb)).toMatchObject({
      accounting_pending: 2,
      bank_park_write_incomplete: 1,
      accounting_unconfirmed: 1,
    });
  });

  it('never guesses: an engine that publishes only the boolean is unknown', () => {
    const mb = countingDown([
      ['a', table({ isMaintenanceStateDurable: () => false, maintenanceDurabilityReason: undefined })],
    ]);
    expect(mb.snapshot().unparkedTables).toBe(1);
    expect(reasons(mb)).toMatchObject({ unknown: 1 });
  });

  it('a table with cards in the air is counted once, not twice', () => {
    // Both conditions true. The gate refuses once and the reason is the one
    // that matters first: nothing durable can be concluded mid-hand.
    const mb = countingDown([
      ['a', table({ isBetweenHands: () => false, ...notDurable('accounting_pending') })],
    ]);
    expect(mb.snapshot().unparkedTables).toBe(1);
    expect(reasons(mb)).toMatchObject({ cards_in_air: 1 });
    expect(reasons(mb).accounting_pending).toBeUndefined();
  });

  it('reports nothing when every table is parked and durable', () => {
    const mb = countingDown([['a', table()], ['b', table()]]);
    expect(mb.snapshot().unparkedTables).toBe(0);
    expect(Object.values(reasons(mb)).reduce((a, b) => a + b, 0)).toBe(0);
  });

  it('a stopped engine is not the gate’s business', () => {
    const mb = countingDown([
      ['a', table({ isRunning: () => false, isBetweenHands: () => false })],
    ]);
    expect(mb.snapshot().unparkedTables).toBe(0);
  });

  it('an engine that throws on inspection does not become a reason', () => {
    const mb = countingDown([
      [
        'a',
        table({
          isBetweenHands: () => {
            throw new Error('unreadable');
          },
        }),
      ],
      ['b', table()],
    ]);
    expect(mb.snapshot().unparkedTables).toBe(0);
    expect(Object.values(reasons(mb)).reduce((a, b) => a + b, 0)).toBe(0);
  });
});
