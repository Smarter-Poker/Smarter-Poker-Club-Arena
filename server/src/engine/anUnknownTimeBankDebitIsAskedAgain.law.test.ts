/**
 * AN UNKNOWN TIME BANK DEBIT IS ASKED AGAIN, BY ITS OWN ID (2026-09-28).
 *
 * One fn_consume_time_bank timeout at 12:17:06Z set this engine's
 * timeBankAccountingUnconfirmed flag, and nothing could ever clear it: the
 * debit had no key, so asking again risked charging the player twice. The
 * stopped table could then never write its time bank custody, its tournament
 * manager could never finish its stop (87a68e55, 335 players, frozen from
 * 12:19Z), and 55 tables held the restart gate shut.
 *
 * Every debit now carries an id through fn_consume_time_bank_once, which
 * records a receipt in the debit's own transaction. A lost answer keeps its
 * id, and the engine asks again with that same id where the answer matters.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { ServerTableEngine } from './ServerTableEngine.js';
import { supabase } from '../services/supabase.js';

const TABLE = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const USER = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const source = readFileSync(new URL('./ServerTableEngineBase.ts', import.meta.url), 'utf8');

afterEach(() => {
  vi.restoreAllMocks();
});

function harness() {
  const engine = new ServerTableEngine(TABLE) as any;
  engine.timeBankEngine.configure(TABLE, { secondsPerUse: 20 });
  engine.timeBankEngine.initializePlayer(TABLE, USER, { remainingSeconds: 40, usesRemaining: 2 });
  engine.timeBankMeta.set(USER, { initialSeconds: 40, baseSeconds: 0, dbConsumedSeconds: 0 });
  const use = () => {
    engine.timeBankEngine.resetStreetActivations(TABLE);
    engine.timeBankEngine.activate(TABLE, USER, () => {});
    engine.timeBankEngine.playerActed(TABLE, USER);
  };
  return { engine, use };
}

const settle = async (engine: any) => {
  await Promise.all([...engine.timeBankAccountingPending]);
  await Promise.resolve();
};

describe('a time bank debit whose answer was lost', () => {
  it('is sent with its own id through the receipted door, never the unkeyed one', async () => {
    const rpc = vi.spyOn(supabase, 'rpc').mockResolvedValue({
      data: { success: true, receipted: true, replayed: false },
      error: null,
    } as any);
    const h = harness();
    h.use();
    await settle(h.engine);
    const calls = rpc.mock.calls.filter((c: unknown[]) => String(c[0]).startsWith('fn_consume_time_bank'));
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe('fn_consume_time_bank_once');
    expect(calls[0][1]).toEqual({ p_user_id: USER, p_seconds: 20, p_debit_id: expect.any(String) });
    expect(h.engine.timeBankAccountingUnconfirmed).toBe(false);
    expect(h.engine.unresolvedTimeBankDebits.size).toBe(0);
  });

  it('keeps its id, and the re-ask with that same id clears the flag once answered', async () => {
    const rpc = vi.spyOn(supabase, 'rpc');
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'supabase_timeout' } } as any);
    const h = harness();
    h.use();
    await settle(h.engine);
    expect(h.engine.timeBankAccountingUnconfirmed).toBe(true);
    expect(h.engine.unresolvedTimeBankDebits.size).toBe(1);
    const firstId = rpc.mock.calls[0][1].p_debit_id;

    // Still unknown on the first re-ask: the id is kept and the flag holds.
    rpc.mockRejectedValueOnce(new Error('fetch failed'));
    await h.engine.resolveUnconfirmedTimeBankDebits();
    expect(h.engine.timeBankAccountingUnconfirmed).toBe(true);
    expect(rpc.mock.calls[1][1]).toEqual({ p_user_id: USER, p_seconds: 20, p_debit_id: firstId });

    // The database answers from its receipt: the debit had committed.
    rpc.mockResolvedValueOnce({
      data: { success: true, receipted: true, replayed: true, debit_id: firstId },
      error: null,
    } as any);
    await h.engine.resolveUnconfirmedTimeBankDebits();
    expect(rpc.mock.calls[2][1]).toEqual({ p_user_id: USER, p_seconds: 20, p_debit_id: firstId });
    expect(h.engine.unresolvedTimeBankDebits.size).toBe(0);
    expect(h.engine.timeBankAccountingUnconfirmed).toBe(false);
    // Nothing else was sent: one debit, asked about three times, one id.
    expect(new Set(rpc.mock.calls.map((c: any[]) => c[1].p_debit_id))).toEqual(new Set([firstId]));
  });

  it('treats a receipted refusal as an answer: nothing was charged, nothing is pending', async () => {
    const rpc = vi.spyOn(supabase, 'rpc');
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'supabase_timeout' } } as any);
    const h = harness();
    h.use();
    await settle(h.engine);
    rpc.mockResolvedValueOnce({
      data: { success: false, error: 'unknown user', receipted: true, replayed: false },
      error: null,
    } as any);
    await h.engine.resolveUnconfirmedTimeBankDebits();
    expect(h.engine.timeBankAccountingUnconfirmed).toBe(false);
  });

  it('runs one resolution at a time', async () => {
    const rpc = vi.spyOn(supabase, 'rpc');
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'supabase_timeout' } } as any);
    const h = harness();
    h.use();
    await settle(h.engine);
    rpc.mockResolvedValue({ data: { success: true, receipted: true }, error: null } as any);
    const a = h.engine.resolveUnconfirmedTimeBankDebits();
    const b = h.engine.resolveUnconfirmedTimeBankDebits();
    expect(a).toBe(b);
    await a;
    expect(rpc.mock.calls).toHaveLength(2);
  });

  it('an unconfirmed flag with no kept debit is never cleared by a resolution (fail closed)', async () => {
    const rpc = vi.spyOn(supabase, 'rpc');
    const h = harness();
    h.engine.timeBankAccountingUnconfirmed = true;
    await h.engine.resolveUnconfirmedTimeBankDebits();
    expect(rpc).not.toHaveBeenCalled();
    expect(h.engine.timeBankAccountingUnconfirmed).toBe(true);
  });
});

describe('the answer is asked for where it matters', () => {
  it('the manager stop asks again before it decides whether the custody can be written', () => {
    const start = source.indexOf('async persistStoppedTimeBankCustody(): Promise<void> {');
    expect(start).toBeGreaterThan(0);
    const body = source.slice(start, source.indexOf('\n  }\n', start));
    const ask = body.indexOf('await this.resolveUnconfirmedTimeBankDebits()');
    const gate = body.indexOf('this.shouldPersistStoppedCustody()');
    expect(ask).toBeGreaterThan(0);
    expect(ask).toBeLessThan(gate);
  });

  it('the restart gate census asks again for any table holding an unknown debit', () => {
    const start = source.indexOf('maintenanceDurabilityReason(): string | null {');
    const firstCustody = source.indexOf('if (this.hasUnretiredStoppedTimeBankCustody()) {', start);
    const kick = source.indexOf('void this.resolveUnconfirmedTimeBankDebits()', start);
    expect(kick).toBeGreaterThan(start);
    expect(kick).toBeLessThan(firstCustody);
  });

  it('no engine code sends the unkeyed debit any more', () => {
    expect(source).not.toMatch(/rpc\(\s*'fn_consume_time_bank'/);
  });
});
