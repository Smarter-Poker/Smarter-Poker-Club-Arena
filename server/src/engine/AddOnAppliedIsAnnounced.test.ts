/**
 * Dan 2026-09-04: "IF A PLAYER ADDS ON AFTER A HAND, THEY SHOULD GET A LITTLE
 * POP UP ABOVE THEIR HEAD. 'HAS ADDED ON FOR XX.XX'."
 *
 * The chips land in exactly one place — `processPendingAddOns`, when
 * `resolve_pending_addon` says how much actually reached the seat. These tests
 * pin that the table's event hub hears about it there, with the APPLIED
 * amount (not the requested one), the seat, and the ledger kind; and that a
 * row already resolved elsewhere, or one that applied nothing, says nothing.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

const { ServerTableEngine } = await import('./ServerTableEngine.js');
const { supabase } = await import('../services/supabase.js');

const TABLE = 'dddddddd-dddd-dddd-dddd-dddddddddddd';

afterEach(() => {
  vi.restoreAllMocks();
});

type Row = { id: string; user_id: string; amount: number; kind?: string };
type Resolve = { applied: number; refunded: number; was_resolved: boolean };

function engineWith(rows: Row[], resolve: (id: string) => Resolve) {
  const engine = new ServerTableEngine(TABLE) as any;
  engine.tableInfo = { id: TABLE, tournament_id: null };
  engine.getMaxBuyIn = () => 500;
  engine.broadcastCurrentState = vi.fn();
  engine.pendingAddOnSweepNeeded = true;
  engine.hub = { emitEvent: vi.fn() };

  vi.spyOn(supabase, 'from').mockReturnValue({
    select: () => ({
      eq: () => ({ is: () => Promise.resolve({ data: rows, error: null }) }),
    }),
  } as never);
  vi.spyOn(supabase, 'rpc').mockImplementation(((fn: string, args: Record<string, unknown>) => {
    if (fn === 'resolve_pending_addon') {
      return Promise.resolve({ data: [resolve(String(args.p_pending_id))], error: null });
    }
    return Promise.resolve({ data: null, error: null });
  }) as never);
  return engine;
}

describe('an add-on that lands is announced to the table', () => {
  it('emits add_on_applied with the APPLIED amount, the seat and the kind', async () => {
    // Asked for 300 on a 500 cap with 350 already on the felt: 150 lands.
    const engine = engineWith(
      [{ id: 'row-1', user_id: 'hero', amount: 300, kind: 'addon' }],
      () => ({
        applied: 150,
        refunded: 150,
        was_resolved: true,
      })
    );
    const hero = { user_id: 'hero', seat_number: 4, stack: 350 };

    await engine.processPendingAddOns([hero]);

    expect(engine.hub.emitEvent).toHaveBeenCalledTimes(1);
    const [tableId, payload] = engine.hub.emitEvent.mock.calls[0];
    expect(tableId).toBe(TABLE);
    expect(payload).toMatchObject({
      type: 'add_on_applied',
      table_id: TABLE,
      seat: 4,
      user_id: 'hero',
      amount: 150, // what reached the stack, not the 300 requested
      stack: 500, // and the stack it made
      kind: 'addon',
    });
    expect(typeof payload.timestamp).toBe('number');
  });

  it('carries kind=rebuy for the C3 bust rebuy, which rides the same ledger', async () => {
    const engine = engineWith(
      [{ id: 'row-2', user_id: 'hero', amount: 200, kind: 'rebuy' }],
      () => ({
        applied: 200,
        refunded: 0,
        was_resolved: true,
      })
    );
    await engine.processPendingAddOns([{ user_id: 'hero', seat_number: 1, stack: 0 }]);
    expect(engine.hub.emitEvent).toHaveBeenCalledWith(
      TABLE,
      expect.objectContaining({ type: 'add_on_applied', kind: 'rebuy', amount: 200, seat: 1 })
    );
  });

  it('still announces when the player is not in `players` (busted, not dealt in) — seat null', async () => {
    const engine = engineWith([{ id: 'row-3', user_id: 'hero', amount: 100 }], () => ({
      applied: 100,
      refunded: 0,
      was_resolved: true,
    }));
    await engine.processPendingAddOns([{ user_id: 'villain', seat_number: 2, stack: 500 }]);
    expect(engine.hub.emitEvent).toHaveBeenCalledWith(
      TABLE,
      expect.objectContaining({ type: 'add_on_applied', user_id: 'hero', seat: null, amount: 100 })
    );
  });

  it('says nothing for a row resolved elsewhere, or one that applied nothing', async () => {
    const engine = engineWith(
      [
        { id: 'elsewhere', user_id: 'a', amount: 100 },
        { id: 'nothing', user_id: 'b', amount: 100 },
      ],
      (id) =>
        id === 'elsewhere'
          ? { applied: 100, refunded: 0, was_resolved: false }
          : { applied: 0, refunded: 100, was_resolved: true }
    );
    await engine.processPendingAddOns([
      { user_id: 'a', seat_number: 1, stack: 100 },
      { user_id: 'b', seat_number: 2, stack: 500 },
    ]);
    expect(engine.hub.emitEvent).not.toHaveBeenCalled();
  });
});
