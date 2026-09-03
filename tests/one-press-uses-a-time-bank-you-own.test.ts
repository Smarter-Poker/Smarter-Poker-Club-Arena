/**
 * ONE PRESS USES A TIME BANK YOU OWN (binding)
 *
 * Dan, 2026-09-03: "IF A USER HAS TIME BANKS ALREADY IN THEIR ACCOUNT (LIKE I
 * DO NOW WITH 366) IF YOU CLICK THE TIME BANK IT SHOULD AUTO ENGAGE OR AUTO
 * USE THE TIME BANK FOR THIS ACTION ... IT SHOULD JUST BE ABLE TO CLICK AND
 * USE AS SOON AS THEIR 15 SECOND TIMER IS UP. THIS SHOULD NOT WORK IF THEY
 * DON'T HAVE ANY, IT SHOULD DIRECT THEM TO BUY MORE."
 *
 * The engine has done the "arm now, spend it the instant the clock runs out"
 * half since 2026-08-23, and it re-reads the player's PURCHASED allowance
 * before refusing (refreshTimeBankFromDb). The client was what said no: the
 * press early-returned on `timeBanksRemaining <= 0` and the button was
 * `disabled` on the same number - and that number is the SEAT's per-session
 * counter off the engine snapshot, which defaults to 4. It is not what the
 * player owns. Measured through fn_time_bank_allowance on the day of the
 * report, Dan held 7,620 purchased seconds plus VIP and still got a dead
 * button with no toast and nothing to buy.
 *
 * The law has two halves, and the second is what stops the first being fixed
 * by simply always opening a store:
 *   1. the client must not pre-judge the press on a count that is not a balance
 *   2. only a genuine "you have none" refusal may open the store
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sliceMethod, sliceEnclosingBlock } from './helpers/sourceWindow';

const SRC = readFileSync(resolve(__dirname, '../src/pages/TablePage.tsx'), 'utf8');
const handler = sliceMethod(SRC, 'const handleActivateTimeBank = useCallback(async () =>');

describe('one press uses a time bank you own', () => {
  it('the press is not refused by the seat counter before the server is asked', () => {
    expect(handler, 'handleActivateTimeBank was not found').toBeTruthy();
    // The regression shape, exactly: an early return gated on the seat count.
    expect(handler).not.toMatch(/timeBanksRemaining[^\n]*<=\s*0\s*\)\s*return/);
    expect(handler).not.toMatch(/\(timeBanksRemaining \?\? 0\) <= 0/);
    // It still asks the engine, which is the only thing that knows the pool,
    // the per-street cap and the purchase ledger.
    expect(handler).toContain('GameServerAPI.activateTimeBank');
  });

  it('having none - and ONLY that - directs the player to buy more', () => {
    expect(handler).toContain('setShowTimeBankStore(true)');
    // Gated on the engine's own words for an empty pool.
    expect(handler).toMatch(/no time bank uses remaining/i);
    // An ordinary refusal keeps its toast and must not throw a store in the
    // player's face mid-decision.
    expect(handler).toContain('Could Not Start Your Time Bank');
  });

  it('the button is not disabled on a number that is not the balance', () => {
    const btn = sliceEnclosingBlock(SRC, 'onClick={handleActivateTimeBank}');
    expect(btn, 'the time bank button was not found').toBeTruthy();
    expect(btn).not.toMatch(/disabled=\{[^}]*timeBanksRemaining[^}]*\}/);
    // A bank already running is still a legitimate reason to refuse a press.
    expect(btn).toMatch(/disabled=\{[^}]*timeBankActive[^}]*\}/);
  });
});
