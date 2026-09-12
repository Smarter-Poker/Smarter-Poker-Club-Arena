/**
 * A DIAMOND SEAT ADDS MID HAND, AND IS TOLD WHAT THAT MEANS (Phase 7 line two).
 *
 * The chip lane takes the money when the player taps and lands the chips at
 * the end of the hand, through the durable `table_pending_addons` ledger. This
 * arena cannot do that, and the reason is a constraint rather than a
 * preference: the deferred trigger `zzz_diamond_seat_keeps_custody` requires a
 * Diamond seat's `stack` to EQUAL its custody balance at every COMMIT, so a
 * reservation made now and applied later is a committed state the database
 * refuses. There is no ordering of the chip lane's two steps this arena
 * permits.
 *
 * So a mid-hand Diamond top-up is an INTENT. Nothing moves until the hand
 * ends, and then the whole thing happens in the one transaction that is
 * allowed, through `fn_poker_diamond_top_up` - the door that already exists
 * and is already certified. The engine half is proved in
 * server/src/engine/DiamondCashBoundary.test.ts; this is the half the player
 * sees, which is where a lane like this usually lies.
 *
 * THE PROMISE IS NARROWER AND THE SENTENCE HAS TO SAY SO. The chip sentence
 * ends "the difference returns to your wallet", which is true because the
 * chips were taken on the tap. Nothing has been taken here, so there is
 * nothing to return; and the local balance, the session buy-in total and the
 * rebuy count must not move either, or the player is shown a balance they
 * still have and a session P/L built on a purchase nobody made.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sliceMethod, sliceStatement } from '../helpers/sourceWindow';

const at = (p: string) => readFileSync(resolve(__dirname, '..', '..', p), 'utf8');
const TABLE_PAGE = 'src/pages/TablePage.tsx';
const SEATING = 'server/src/engine/ServerTableEngineSeating.ts';
const BASE = 'server/src/engine/ServerTableEngineBase.ts';

describe('a mid-hand Diamond top-up takes nothing until it lands', () => {
  it('the engine records an intent and calls no money door during the hand', () => {
    const method = sliceMethod(at(SEATING), 'protected async addDiamonds(');
    /* The if-BLOCK, not the rest of the method: everything after it is the
       between-hands path, which calls the door and is supposed to. `sliceMethod`
       is the same scanner under the name `sliceBlockAfter` for exactly this. */
    const midHand = sliceMethod(method, 'if (midHand) {');
    expect(midHand, 'the mid-hand branch is gone').toContain('diamondTopUpIntents.set');
    expect(midHand, 'a mid-hand branch that calls the door has already moved money').not.toMatch(
      /supabase\.rpc/
    );
    expect(midHand, 'the intent is keyed by the request id, so a retried tap is one').toMatch(
      /requestId/
    );
  });

  it('the intent lane is memory only, and says why that is safe', () => {
    /* A durable intent would be a durable promise, and there is no promise to
       keep: nothing was taken. The chip ledger is durable because it holds
       money that HAS been taken, which is the opposite case. */
    const decl = at(BASE);
    expect(decl).toContain('protected diamondTopUpIntents');
    expect(decl, 'the intent lane acquired a table').not.toMatch(
      /diamond_top_up_intents|diamondTopUpIntents[^\n]*from\(/
    );
  });

  it('it lands between hands, on the stack as it is by then', () => {
    const lander = sliceMethod(at(SEATING), 'protected async applyDiamondTopUpIntents(');
    expect(lander, 'it can land while a hand is running').toMatch(
      /if \(this\.handController\) return/
    );
    expect(lander).toMatch(/fn_poker_diamond_top_up/);
    expect(lander, 'the door must be told the stack it is actually raising').toMatch(
      /p_expected_stack: stack/
    );
    expect(lander, 'the pot moved the stack, so the amount is measured again').toMatch(
      /Math\.min\(intent\.amount/
    );
  });

  it('and the client counts nothing it has not been charged for', () => {
    const handler = sliceStatement(at(TABLE_PAGE), 'const handleAddChips =');
    expect(
      handler,
      'a queued Diamond top-up falls through to the debit accounting below it'
    ).toMatch(/if \(res\.queued && topUpAsset === 'diamonds'\) return true;/);
    /* The early return has to come BEFORE the balance delta, not after it. */
    const returnAt = handler.indexOf("if (res.queued && topUpAsset === 'diamonds') return true;");
    const deltaAt = handler.indexOf('applyBalanceDelta(');
    expect(returnAt, 'the early return is missing').toBeGreaterThan(-1);
    expect(deltaAt, 'the optimistic debit is missing').toBeGreaterThan(-1);
    expect(returnAt, 'the debit runs before the Diamond lane returns').toBeLessThan(deltaAt);
  });

  it('and tells the player the narrower promise rather than the comfortable one', () => {
    const handler = sliceStatement(at(TABLE_PAGE), 'const handleAddChips =');
    expect(handler, 'the Diamond sentence is missing').toMatch(/And Are Taken Then/);
    expect(handler, 'the chip sentence was changed instead of branched').toMatch(
      /The Difference Returns To Your Wallet/
    );
  });
});

describe('what a Diamond table honestly does not have', () => {
  /* Phase 7 exit: "unsupported features remain honestly unavailable." These
     two are unavailable BY CONSTRUCTION rather than by omission, and the
     difference matters: nothing has to be remembered to keep them off. */
  it('has no cluster, because the boundary refuses one', () => {
    const boundary = at('server/src/domain/DiamondCashBoundary.ts');
    expect(boundary).toMatch(/table\.cluster_id != null/);
  });

  it('so the seat change and must-move doors cannot be reached at all', () => {
    /* `fn_cash_seat_change_request` looks its game up in `cash_games` and
       refuses a game that is not `must_move`. A Diamond table belongs to no
       cluster, so it has no `cash_games` row, so there is no game id to pass
       and no roster to spend a seat change from. The same structure is what
       provides must-move itself. */
    const migrations = at(
      'supabase/migrations/20260909181259_a_leave_cancels_the_move_and_a_move_says_why_it_expired.sql'
    );
    expect(migrations).toMatch(/fn_cash_seat_change_request/);
    const creation = at(
      'supabase/migrations/20260912070000_the_diamond_arena_deals_the_games_the_estate_deals.sql'
    );
    expect(creation, 'the Diamond creation door started writing a cluster id').toMatch(
      /cluster_id[\s\S]{0,400}NULL/
    );
  });
});
