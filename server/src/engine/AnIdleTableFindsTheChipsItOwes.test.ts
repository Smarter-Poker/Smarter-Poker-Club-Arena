/**
 * AN IDLE TABLE FINDS THE CHIPS IT OWES (launch audit 2026-10-05).
 *
 * A browser rebuy is a `table_pending_addons` row with the wallet already
 * debited. Nothing raised the engine's sweep flag for a row belonging to a
 * seat that still had chips, so at a table that was not dealing the row
 * waited for the next engine restart (production: 36 minutes).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ServerTableEngine } from './ServerTableEngine.js';

const rows: Array<{ user_id: string }> = [];
const queries: Array<{ table: string; users: string[] }> = [];
let ledgerError: { message: string } | null = null;

vi.mock('../services/supabase/client.js', () => ({
  supabase: {
    from: (table: string) => {
      const q: any = {
        users: [] as string[],
        select: () => q,
        eq: () => q,
        in: (_col: string, users: string[]) => {
          q.users = users;
          return q;
        },
        is: () => {
          queries.push({ table, users: q.users });
          return Promise.resolve(
            ledgerError ? { data: null, error: ledgerError } : { data: rows, error: null }
          );
        },
      };
      return q;
    },
    rpc: vi.fn(),
  },
  maintenanceSupabase: {},
}));

const TABLE = 'aaaa2244-3333-4333-8333-333333333333';

function idleEngine() {
  const engine = new ServerTableEngine(TABLE) as any;
  engine.seatedPlayers = [
    { user_id: 'seat-with-chips', seat_number: 1, stack: 1000, is_horse: false },
    { user_id: 'other', seat_number: 2, stack: 400, is_horse: true },
  ];
  engine.pendingAddOnSweepNeeded = false;
  return engine;
}

afterEach(() => {
  rows.length = 0;
  queries.length = 0;
  ledgerError = null;
});

describe('an idle table finds the chips it owes', () => {
  it('a ledger row for a seat that still has chips raises the sweep', async () => {
    rows.push({ user_id: 'seat-with-chips' });
    const engine = idleEngine();
    await engine.findLedgerChipsOwedWhileWaiting();
    expect(queries).toEqual([
      { table: 'table_pending_addons', users: ['seat-with-chips', 'other'] },
    ]);
    expect(engine.pendingAddOnSweepNeeded).toBe(true);
  });

  it('an empty ledger leaves the flag down', async () => {
    const engine = idleEngine();
    await engine.findLedgerChipsOwedWhileWaiting();
    expect(queries).toHaveLength(1);
    expect(engine.pendingAddOnSweepNeeded).toBe(false);
  });

  it('asks nothing when a sweep is already requested or nobody is seated', async () => {
    const engine = idleEngine();
    engine.pendingAddOnSweepNeeded = true;
    await engine.findLedgerChipsOwedWhileWaiting();
    const empty = idleEngine();
    empty.seatedPlayers = [];
    await empty.findLedgerChipsOwedWhileWaiting();
    expect(queries).toHaveLength(0);
  });

  it('an unreadable ledger changes nothing and does not throw', async () => {
    ledgerError = { message: 'PGRST002' };
    const engine = idleEngine();
    await engine.findLedgerChipsOwedWhileWaiting();
    expect(engine.pendingAddOnSweepNeeded).toBe(false);
  });

  it('the wait loop asks before the sweep that delivers', () => {
    const src = readFileSync(resolve(__dirname, 'ServerTableEngineBase.ts'), 'utf8');
    const ask = src.indexOf('await this.findLedgerChipsOwedWhileWaiting();');
    const deliver = src.indexOf('await this.processPendingAddOns(this.seatedPlayers);', ask);
    expect(ask).toBeGreaterThan(-1);
    expect(deliver).toBeGreaterThan(ask);
    expect(deliver - ask).toBeLessThan(200);
  });
});
