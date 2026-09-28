/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  AN UNKNOWN DEBIT IS WRITTEN DOWN, NOT HELD FOREVER (2026-09-28)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `fn_consume_time_bank` spends a player's ACCOUNT entitlement and carries no
 * idempotency key of its own, so a lost reply may not be retried and may not
 * be certified. `timeBankAccountingUnconfirmed` said so, correctly:
 *
 *     // An unacknowledged non-idempotent debit must not be retried or certified.
 *
 * What it did not have was any way back down. Nothing in the repository ever
 * set it false, and four separate gates read it as "this table's stopped time
 * bank is not on disk":
 *
 *   · `shouldPersistStoppedCustody()` refuses over it - so the bank is never
 *     written, which is the very thing that would clear the gate;
 *   · `persistPresenceForRestart('parked')` throws over it - so it is not
 *     written on that path either;
 *   · `hasUnretiredStoppedTimeBankCustody()` returns true from it directly,
 *     before it looks at whether the snapshot is on disk at all;
 *   · `maintenanceDurabilityReason()` answers `stopped_bank_custody_*`, which
 *     refuses the platform restart.
 *
 * ── WHAT PRODUCTION LOOKED LIKE (2026-09-28) ──────────────────────────────
 *
 * ONE lost reply. The whole cause, once, in five hours of engine log:
 *
 *     [TimeBank] consume unconfirmed: Error: supabase_timeout
 *
 * From it, on table 9333d016 of tournament 87a68e55:
 *
 *     stop attempt                    112, over 115 minutes
 *     custodyRefusal                  mixed:originals_not_drained:
 *                                     engine_stops_not_all_fulfilled
 *     tables frozen                   43
 *     players seated at them          335
 *     frozen since                    12:19Z
 *     maintenance census              stopped_bank_custody_stuck, past its
 *                                     600s bound - and still refusing the
 *                                     hourly restart that would clear it
 *
 * That last line is the shape of the bug: an unbounded fail-closed gate on a
 * resource the whole platform shares also shuts the door it would have to
 * walk out of. MaintenanceBreak's own census bounded exactly this for the F06
 * class in #4909, for the reason written above it - "a stuck table never
 * recovers" is the worse bug.
 *
 * ── WHAT THIS LAW PINS ────────────────────────────────────────────────────
 *
 *   1. An unknown debit still refuses. Fail-closed is not relaxed: while the
 *      seconds are owed and nowhere but in this process, every gate holds.
 *   2. Writing it down is what releases it. Not a timer, not a bound, not a
 *      watchdog: the flag comes down when, and only when, the owed seconds
 *      are on disk where a reconciler can settle them.
 *   3. A write that does not land keeps the hold, and retries under the SAME
 *      attempt id. That is what makes recording safe for a non-idempotent
 *      debit: however many times the record is attempted, nobody is charged
 *      twice.
 *   4. The debit itself is never re-sent. The one thing a non-idempotent
 *      write may not do, this must still never do.
 *   5. Both gates that read the flag resolve it first. A gate that refuses
 *      over a flag it never gives a chance to clear is the original defect.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const recorded: Array<{ attemptId: string; userId: string; seconds: number }> = [];
let recordLands = true;

vi.mock('../services/supabase/snapshots.js', async () => ({
  ...(await vi.importActual<Record<string, unknown>>('../services/supabase/snapshots.js')),
  recordUnconfirmedTimeBankConsume: vi.fn(
    async (p: { attemptId: string; userId: string; seconds: number }) => {
      recorded.push({ attemptId: p.attemptId, userId: p.userId, seconds: p.seconds });
      return recordLands;
    }
  ),
}));

import { ServerTableEngineBase } from './ServerTableEngineBase.js';

const proto = ServerTableEngineBase.prototype as unknown as Record<string, CallableFunction>;
const BASE = readFileSync(join(__dirname, 'ServerTableEngineBase.ts'), 'utf8');

/** A member body, sliced from its signature to its matching brace. */
const slice = (signature: string): string => {
  const start = BASE.indexOf(signature);
  expect(start, `${signature} is gone; re-anchor this law rather than deleting it`).toBeGreaterThan(
    -1
  );
  let depth = 0;
  for (let i = BASE.indexOf('{', start); i < BASE.length; i++) {
    if (BASE[i] === '{') depth++;
    else if (BASE[i] === '}' && --depth === 0) return BASE.slice(start, i + 1);
  }
  throw new Error(`unbalanced body for ${signature}`);
};

/**
 * The narrowest object the three real methods touch. Everything here is a
 * plain field the engine also has; the METHODS under test are the shipped
 * ones, taken off the prototype.
 */
const engine = () =>
  Object.assign(Object.create(ServerTableEngineBase.prototype) as Record<string, unknown>, {
    tableId: '00000000-0000-0000-0000-0000009333d0',
    handCount: 16636034,
    engineLeaseTournamentId: '00000000-0000-0000-0000-00000087a68e',
    tableInfo: null as unknown,
    terminal: true,
    engineLeaseScope: 'tournament',
    stoppedTimeBankCustodyTransferred: false,
    stoppedTimeBankDurableReceipt: null as unknown,
    acknowledgedTimeBankPark: null as unknown,
    presenceSavePending: 0,
    parkedTimeBanks: {},
    timeBankMeta: new Map(),
    timeBankEngine: { hasPlayerBanksForTable: () => false },
    timeBankAccountingPending: new Set<Promise<void>>(),
    timeBankAccountingUnconfirmed: false,
    timeBankAccountingUnrecorded: new Map<string, unknown>(),
    timeBankAccountingRecordChain: null as unknown,
    // A bank frozen at the custody hand, already acknowledged on disk. Nothing
    // but the unknown debit can hold this engine.
    stoppedTimeBankCustody: {
      handNumber: 16636034,
      banks: { '00000000-0000-0000-0000-0000000p1ayr': { remainingSeconds: 30 } },
    },
  });

type Engine = ReturnType<typeof engine>;
const call = (e: Engine, name: string, ...args: unknown[]): unknown =>
  (proto[name] as (this: unknown, ...a: unknown[]) => unknown).apply(e, args);
const hold = (e: Engine, ...args: unknown[]) => call(e, 'holdUnconfirmedTimeBankConsume', ...args);
const resolve = (e: Engine) => call(e, 'resolveUnconfirmedTimeBankAccounting') as Promise<void>;
const unretired = (e: Engine) => call(e, 'hasUnretiredStoppedTimeBankCustody') as boolean;
const reason = (e: Engine) => call(e, 'maintenanceDurabilityReason') as string | null;
const flag = (e: Engine) => e.timeBankAccountingUnconfirmed as boolean;

/** Acknowledge the park, as a landed write does, so only the debit can hold. */
const withParkOnDisk = (e: Engine) => {
  const custody = e.stoppedTimeBankCustody as { handNumber: number; banks: object };
  e.acknowledgedTimeBankPark = {
    handNumber: custody.handNumber,
    banks: call(e, 'timeBankCustodyFingerprint', custody.banks),
  };
  return e;
};

beforeEach(() => {
  recorded.length = 0;
  recordLands = true;
});

describe('an unknown time-bank debit', () => {
  it('holds the custody while the seconds are owed nowhere but in this process', () => {
    const e = withParkOnDisk(engine());
    expect(unretired(e), 'a parked bank with no unknown debit is not retained').toBe(false);

    recordLands = false; // the record cannot reach disk yet
    hold(e, 'a7e3f1c2-0000-4000-8000-000000000001', 'player-1', 40, 'supabase_timeout');

    expect(flag(e)).toBe(true);
    expect(unretired(e), 'an unknown debit must still refuse').toBe(true);
    expect(reason(e)).toBe('stopped_bank_custody_unreadable');
  });

  it('comes down when, and only when, the owed seconds are on disk', async () => {
    const e = withParkOnDisk(engine());
    recordLands = false;
    hold(e, 'a7e3f1c2-0000-4000-8000-000000000002', 'player-1', 40, 'supabase_timeout');

    await resolve(e);
    expect(flag(e), 'a write that did not land keeps the hold').toBe(true);
    expect(unretired(e)).toBe(true);

    recordLands = true;
    await resolve(e);
    expect(flag(e), 'on disk is the clearing path').toBe(false);
    expect(unretired(e), 'and the custody is no longer retained by it').toBe(false);
    expect(reason(e)).toBeNull();
  });

  it('retries the RECORD under one attempt id, so nobody is charged twice', async () => {
    const e = withParkOnDisk(engine());
    recordLands = false;
    hold(e, 'a7e3f1c2-0000-4000-8000-000000000003', 'player-1', 40, 'supabase_timeout');

    await resolve(e);
    await resolve(e);
    recordLands = true;
    await resolve(e);

    expect(recorded.length, 'the record was retried').toBeGreaterThan(1);
    expect(new Set(recorded.map((r) => r.attemptId)).size, 'under exactly one id').toBe(1);
    expect(new Set(recorded.map((r) => r.seconds))).toEqual(new Set([40]));
  });

  it('records each distinct unknown debit, and forgets none of them', async () => {
    const e = withParkOnDisk(engine());
    recordLands = true;
    hold(e, 'a7e3f1c2-0000-4000-8000-000000000004', 'player-1', 40, 'supabase_timeout');
    hold(e, 'a7e3f1c2-0000-4000-8000-000000000005', 'player-2', 20, 'missing receipt');
    await resolve(e);

    expect(new Set(recorded.map((r) => r.userId))).toEqual(new Set(['player-1', 'player-2']));
    expect(flag(e)).toBe(false);
  });

  it('never re-sends the debit itself', () => {
    const holdBody = slice('private holdUnconfirmedTimeBankConsume(');
    const resolveBody = slice('private async resolveUnconfirmedTimeBankAccounting(');
    for (const [name, body] of [
      ['hold', holdBody],
      ['resolve', resolveBody],
    ] as const) {
      expect(body, `${name} must never re-send a non-idempotent debit`).not.toMatch(
        /fn_consume_time_bank/
      );
    }
  });

  it('is resolved by both gates that refuse over it', () => {
    const persistStopped = slice('async persistStoppedTimeBankCustody(): Promise<void> {');
    expect(
      persistStopped,
      'shouldPersistStoppedCustody() refuses while the flag is up, so the resolve must come first'
    ).toMatch(
      /resolveUnconfirmedTimeBankAccounting\(\)[\s\S]*?if \(!this\.shouldPersistStoppedCustody\(\)\) return;/
    );

    const persistPresence = slice(
      "protected async persistPresenceForRestart(when: 'announced' | 'parked'): Promise<void> {"
    );
    expect(
      persistPresence,
      'the parked write throws over the flag; it must give it a chance to clear first'
    ).toMatch(
      /resolveUnconfirmedTimeBankAccounting\(\)[\s\S]*?if \(this\.timeBankAccountingUnconfirmed\) \{/
    );
  });

  it('leaves the flag with exactly one clearing path, and it is the record', () => {
    const raises = [...BASE.matchAll(/this\.timeBankAccountingUnconfirmed = (true|false)/g)];
    const clears = raises.filter((m) => m[1] === 'false');
    expect(clears.length, 'more than one clearing path is how a bound creeps back in').toBe(2);
    const resolveBody = slice('private async resolveUnconfirmedTimeBankAccounting(');
    for (const clear of clears) {
      expect(
        resolveBody.includes(clear[0]),
        'the flag may only be lowered inside resolveUnconfirmedTimeBankAccounting'
      ).toBe(true);
    }
  });
});
