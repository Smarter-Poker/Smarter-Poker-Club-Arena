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
 * Every debit now carries an id through fn_consume_time_bank, which
 * records a receipt in the debit's own transaction. A lost answer keeps its
 * id, and the engine asks again with that same id where the answer matters.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { ServerTableEngine } from './ServerTableEngine.js';
import { supabase } from '../services/supabase.js';
import {
  currentTournamentDataAuthority,
  runWithTournamentDataAuthority,
} from '../services/supabase/dataActorContext.js';

const TABLE = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const USER = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const source = readFileSync(new URL('./ServerTableEngineBase.ts', import.meta.url), 'utf8');
const snapshotsSource = readFileSync(
  new URL('../services/supabase/snapshots.ts', import.meta.url),
  'utf8'
);
const TOURNAMENT = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const LOST_LEASE = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

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
  it('is sent with its own request id, never without one', async () => {
    const rpc = vi.spyOn(supabase, 'rpc').mockResolvedValue({
      data: { success: true },
      error: null,
    } as any);
    const h = harness();
    h.use();
    await settle(h.engine);
    const calls = rpc.mock.calls.filter((c: unknown[]) =>
      String(c[0]).startsWith('fn_consume_time_bank')
    );
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe('fn_consume_time_bank');
    expect(typeof calls[0][1].p_request_id).toBe('string');
    expect(calls[0][1]).toEqual({
      p_user_id: USER,
      p_seconds: 20,
      p_request_id: expect.any(String),
    });
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
    const firstId = rpc.mock.calls[0][1].p_request_id;

    // Still unknown on the first re-ask: the id is kept and the flag holds.
    rpc.mockRejectedValueOnce(new Error('fetch failed'));
    await h.engine.resolveUnconfirmedTimeBankDebits();
    expect(h.engine.timeBankAccountingUnconfirmed).toBe(true);
    expect(rpc.mock.calls[1][1]).toEqual({ p_user_id: USER, p_seconds: 20, p_request_id: firstId });

    // The database answers from its receipt: the debit had committed.
    rpc.mockResolvedValueOnce({
      data: { success: true, idempotent_replay: true },
      error: null,
    } as any);
    await h.engine.resolveUnconfirmedTimeBankDebits();
    expect(rpc.mock.calls[2][1]).toEqual({ p_user_id: USER, p_seconds: 20, p_request_id: firstId });
    expect(h.engine.unresolvedTimeBankDebits.size).toBe(0);
    expect(h.engine.timeBankAccountingUnconfirmed).toBe(false);
    // Nothing else was sent: one debit, asked about three times, one id.
    expect(new Set(rpc.mock.calls.map((c: any[]) => c[1].p_request_id))).toEqual(
      new Set([firstId])
    );
  });

  it('treats a refusal as an answer: nothing was charged, nothing is pending', async () => {
    const rpc = vi.spyOn(supabase, 'rpc');
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'supabase_timeout' } } as any);
    const h = harness();
    h.use();
    await settle(h.engine);
    rpc.mockResolvedValueOnce({
      data: { success: false, error: 'unknown user' },
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
    rpc.mockResolvedValue({ data: { success: true }, error: null } as any);
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

  it('no engine code sends the debit without its request id', () => {
    const calls = [
      ...source.matchAll(/rpc\(\s*'fn_consume_time_bank',\s*\{([^}]*)\}/g),
      ...snapshotsSource.matchAll(/rpc\(\s*'fn_consume_time_bank',\s*\{([^}]*)\}/g),
    ];
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const [, args] of calls) expect(args).toContain('p_request_id');
  });
});

/**
 * THE RE-ASK GOES OUT AS THE PROCESS (2026-10-03). The 16:35Z Postgres
 * restart lost the answer to debit 6b1de5d5 on spin 20a7de08 table 9aa37b13.
 * The receipt had committed, but the engine re-asked under its manager's lost
 * lease generation, the database fenced every re-ask
 * (TOURNAMENT_MANAGER_FENCED), and the manager's stop failed "retained
 * time-bank custody" once a minute for two hours with three players seated.
 */
describe('a re-ask from an engine whose tournament lease is gone', () => {
  it('reaches the database without that lease authority, and the answer clears the flag', async () => {
    const rpc = vi.spyOn(supabase, 'rpc');
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'supabase_timeout' } } as any);
    const h = harness();
    h.use();
    await settle(h.engine);
    expect(h.engine.unresolvedTimeBankDebits.size).toBe(1);

    const seen: unknown[] = [];
    rpc.mockImplementationOnce(((name: string) => {
      seen.push([name, currentTournamentDataAuthority()]);
      return Promise.resolve({ data: { success: true, idempotent_replay: true }, error: null });
    }) as any);
    // The manager stop calls this inside the (now lost) lease authority.
    await runWithTournamentDataAuthority(
      { tournamentId: TOURNAMENT, leaseGeneration: LOST_LEASE },
      () => h.engine.resolveUnconfirmedTimeBankDebits()
    );
    expect(seen).toEqual([['fn_consume_time_bank', null]]);
    expect(h.engine.unresolvedTimeBankDebits.size).toBe(0);
    expect(h.engine.timeBankAccountingUnconfirmed).toBe(false);
  });

  it('the engine re-asks only through the process-root helper', () => {
    const start = source.indexOf('resolveUnconfirmedTimeBankDebits(): Promise<void> {');
    const body = source.slice(start, source.indexOf('\n  }\n', start));
    expect(body).toContain('await reaskTimeBankDebit({');
    expect(body).not.toContain("supabase.rpc('fn_consume_time_bank'");
    expect(snapshotsSource).toMatch(/export const reaskTimeBankDebit = bindToProcessRoot\(/);
  });
});
