/**
 * VIP TIME BANKS — behavioural proof of the 2026-08-17 wiring.
 *
 * Before this wiring, EVERY player received the table default time bank
 * (120 uses = 1800s) in memory, VIP or not: the VIP perk (120s/month) was
 * meaningless, the monthly ledger never moved, and diamond-purchased
 * extensions were burned diamonds. These tests drive the real
 * TimeBankEngine + the engine's accounting hook and assert:
 *
 *   1. A DB-derived session allowance is honored at init (not the default).
 *   2. The free session base is spent FIRST; only the excess is committed
 *      to the DB via fn_consume_time_bank, exactly once per use.
 *   3. Mid-session refresh (top-up purchase) rebases the bank to
 *      base-residue + fresh DB extras and resets the accounting meta.
 *   4. rebase() refuses to touch an actively counting bank.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { ServerTableEngine } from './ServerTableEngine.js';
import { TimeBankEngine } from './TimeBankEngine.js';
import { PreciseActionTimer } from './PreciseActionTimer.js';
import { supabase } from '../services/supabase.js';

const TABLE = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('TimeBankEngine session allowance', () => {
  it('honors an explicit initial allowance instead of the table default', () => {
    const tbe = new TimeBankEngine(new PreciseActionTimer());
    tbe.initializePlayer(TABLE, 'u1', { remainingSeconds: 45, usesRemaining: 3 });
    expect(tbe.getRemainingSeconds(TABLE, 'u1')).toBe(45);
    expect(tbe.getUsesRemaining(TABLE, 'u1')).toBe(3);
  });

  it('rebase() updates an idle bank and refuses an active one', () => {
    const tbe = new TimeBankEngine(new PreciseActionTimer());
    tbe.initializePlayer(TABLE, 'u1', { remainingSeconds: 30, usesRemaining: 2 });
    expect(tbe.rebase(TABLE, 'u1', 90)).toBe(true);
    expect(tbe.getRemainingSeconds(TABLE, 'u1')).toBe(90);
    // No configure() call here, so the DEFAULT grant applies: 90s / 20s = 5.
    // Was 6 when a bank granted 15s (Bible V8 §6.2 changed to 20 on 2026-08-18).
    expect(tbe.getUsesRemaining(TABLE, 'u1')).toBe(5);

    expect(tbe.activate(TABLE, 'u1', () => {})).toBe(true);
    expect(tbe.rebase(TABLE, 'u1', 300)).toBe(false);
    tbe.playerActed(TABLE, 'u1'); // cleanup: cancel the countdown
  });
});

describe('engine accounting: base first, DB for the excess', () => {
  function accountingHarness(opts: { initialSeconds: number; baseSeconds: number }) {
    const engine = new ServerTableEngine(TABLE) as any;
    const rpc = vi
      .spyOn(supabase, 'rpc')
      .mockReturnValue(Promise.resolve({ data: null, error: null }) as any);
    engine.timeBankEngine.configure(TABLE, { secondsPerUse: 15 });
    engine.timeBankEngine.initializePlayer(TABLE, 'u1', {
      remainingSeconds: opts.initialSeconds,
      usesRemaining: Math.ceil(opts.initialSeconds / 15),
    });
    engine.timeBankMeta.set('u1', {
      initialSeconds: opts.initialSeconds,
      baseSeconds: opts.baseSeconds,
      dbConsumedSeconds: 0,
    });
    const useOnce = () => {
      // Each use here is its own street (Bible V8 §6.2 caps 2 per street).
      // These tests pin secondsPerUse: 15 above deliberately — they exercise
      // the base-first/DB-excess ACCOUNTING, which is per-second and does not
      // care what one bank grants.
      engine.timeBankEngine.resetStreetActivations(TABLE);
      engine.timeBankEngine.activate(TABLE, 'u1', () => {});
      engine.timeBankEngine.playerActed(TABLE, 'u1');
    };
    const consumeCalls = () =>
      rpc.mock.calls.filter((c: unknown[]) => c[0] === 'fn_consume_time_bank');
    return { engine, rpc, useOnce, consumeCalls };
  }

  it('never touches the DB while the free session base covers the usage', () => {
    const h = accountingHarness({ initialSeconds: 45, baseSeconds: 30 });
    h.useOnce(); // 15s used, base has 30
    h.useOnce(); // 30s used, base exactly exhausted
    expect(h.consumeCalls()).toHaveLength(0);
  });

  it('commits exactly the DB-backed excess, once per use', () => {
    const h = accountingHarness({ initialSeconds: 45, baseSeconds: 30 });
    h.useOnce();
    h.useOnce();
    h.useOnce(); // 45s used → 15s beyond base
    const calls = h.consumeCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toEqual({ p_user_id: 'u1', p_seconds: 15 });
  });

  it('a player with no meta (pre-wiring session) never triggers DB writes', () => {
    const h = accountingHarness({ initialSeconds: 45, baseSeconds: 30 });
    (h.engine as any).timeBankMeta.delete('u1');
    h.useOnce();
    h.useOnce();
    h.useOnce();
    expect(h.consumeCalls()).toHaveLength(0);
  });
});

describe('mid-session refresh (diamond top-up)', () => {
  it('rebases to base-residue + fresh DB extras and resets accounting', async () => {
    const engine = new ServerTableEngine(TABLE) as any;
    const rpc = vi.spyOn(supabase, 'rpc').mockImplementation(((fn: string) => {
      if (fn === 'fn_time_bank_allowance') {
        return Promise.resolve({
          data: [{ user_id: 'u1', extra_seconds: 60 }],
          error: null,
        });
      }
      return Promise.resolve({ data: null, error: null });
    }) as any);

    engine.timeBankEngine.configure(TABLE, { secondsPerUse: 15 });
    // Session fully spent: 45s allowance, all used (30 base + 15 DB-consumed).
    engine.timeBankEngine.initializePlayer(TABLE, 'u1', {
      remainingSeconds: 0,
      usesRemaining: 0,
    });
    engine.timeBankMeta.set('u1', {
      initialSeconds: 45,
      baseSeconds: 30,
      dbConsumedSeconds: 15,
    });

    const ok = await engine.refreshTimeBankFromDb('u1');
    expect(ok).toBe(true);
    expect(engine.timeBankEngine.getRemainingSeconds(TABLE, 'u1')).toBe(60);
    expect(engine.timeBankEngine.getUsesRemaining(TABLE, 'u1')).toBe(4);
    expect(engine.timeBankMeta.get('u1')).toEqual({
      initialSeconds: 60,
      baseSeconds: 0,
      dbConsumedSeconds: 0,
    });

    // The next use is entirely DB-backed now.
    engine.timeBankEngine.activate(TABLE, 'u1', () => {});
    engine.timeBankEngine.playerActed(TABLE, 'u1');
    const consume = rpc.mock.calls.filter((c: unknown[]) => c[0] === 'fn_consume_time_bank');
    expect(consume).toHaveLength(1);
    expect(consume[0][1]).toEqual({ p_user_id: 'u1', p_seconds: 15 });
  });

  it('fails closed (base only) when the allowance fetch errors', async () => {
    const engine = new ServerTableEngine(TABLE) as any;
    vi.spyOn(supabase, 'rpc').mockReturnValue(
      Promise.resolve({ data: null, error: { message: 'boom' } }) as any
    );
    engine.timeBankEngine.initializePlayer(TABLE, 'u1', {
      remainingSeconds: 0,
      usesRemaining: 0,
    });
    engine.timeBankMeta.set('u1', { initialSeconds: 45, baseSeconds: 30, dbConsumedSeconds: 15 });
    const ok = await engine.refreshTimeBankFromDb('u1');
    expect(ok).toBe(false);
    expect(engine.timeBankEngine.getRemainingSeconds(TABLE, 'u1')).toBe(0);
  });
});
