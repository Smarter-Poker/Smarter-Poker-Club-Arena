/**
 * YOU ARE ASKED TO POST THE BIG BLIND ONCE.
 * ============================================================================
 * Dan 2026-08-29, binding, with a screenshot of the felt:
 *
 *   "in cash games when you click POST BB but you are IN BETWEEN THE BLINDS
 *    you get this pop up. that shouldn't happen because you already agreed to
 *    post bb, it should be a pop up that says, 'You Are In Between The Blinds,
 *    And Will Be Dealt In When The Button Passes.' and auto post the blind
 *    then. it currently makes you hit the button again, or it simply won't
 *    deal you in at all."
 *
 * THE SHAPE OF THE BUG, because it is a client bug as much as an engine one.
 * The engine refuses a post from the seat the small blind or the button is
 * about to reach — correctly, and that refusal is not what changed. But the
 * refusal left the player in `waitingForBB`, and TablePage renders the
 * "Post Big Blind To Enter" overlay purely off `waitingForBBUserIds`. So the
 * prompt came straight back, tapping it from the same seat was refused again,
 * and the loop only broke when the button happened to move.
 *
 * The repair has three parts and all three are pinned here, because losing any
 * one of them re-opens the report:
 *
 *   1. the reply is read as DEFERRED before it is read as success or failure,
 *      and says the sentence Dan asked for;
 *   2. the overlay is gated on the engine's published agreement, so a reload
 *      does not re-ask (the hostile-state case: the local flag is gone, the
 *      engine's answer is not);
 *   3. the optimistic local flag covers the poll between the tap and that
 *      snapshot, and is cleared the moment the hero stops being held — a
 *      stale flag would hide a prompt that genuinely needs answering.
 *
 * Source-text guards in the house style: they pin the SHAPE of the rule, which
 * is what regressed, rather than mounting a 20k-line page component.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
/* Structural extractors, never `.slice(at, at + N)`. A fixed window drifts off
   the end of what it guards as comments grow — and it can drift while staying
   GREEN, which is why noFixedSizeSourceWindows.test.ts gates it. */
import { sliceEnclosingBlock, sliceStatement } from '../helpers/sourceWindow';

const read = (p: string) => readFileSync(resolve(__dirname, '../../', p), 'utf8');
const TABLE_PAGE = read('src/pages/TablePage.tsx');
const MAPPER = read('src/utils/mapEngineSnapshot.ts');
const API = read('src/services/GameServerAPI.ts');

const DEFERRED_COPY = 'You Are In Between The Blinds, And Will Be Dealt In When The Button Passes.';

describe('the post-BB prompt asks once', () => {
  it('every /post-bb caller reads `deferred` BEFORE success or failure', () => {
    // Order is the whole assertion. `deferred` comes back alongside
    // success:true, so a handler that checks success first reports "dealt into
    // the next hand" for a post that has not happened yet.
    const calls = [...TABLE_PAGE.matchAll(/await serverPostBBToEnter\(tableId\)/g)];
    expect(calls.length, 'the post-bb call sites moved').toBeGreaterThanOrEqual(2);

    for (let i = 0; i < calls.length; i++) {
      // The `try { ... }` the call sits inside — bounded by the brace, so the
      // window grows with the handler instead of being outrun by it.
      const window = sliceEnclosingBlock(TABLE_PAGE, 'await serverPostBBToEnter(tableId)', i);
      const deferred = window.indexOf('res?.deferred');
      const success = window.indexOf('res?.success');
      expect(deferred, 'a post-bb call site ignores the deferred reply').toBeGreaterThan(-1);
      expect(success).toBeGreaterThan(-1);
      expect(deferred, 'deferred must be read before success').toBeLessThan(success);
      // And it banks the agreement locally rather than only toasting.
      expect(window).toMatch(/setBBPostAgreed\(true\)/);
    }
  });

  it('says the sentence Dan asked for, in the popup house style', () => {
    // CLAUDE.md rule 7: Title Case, and em dashes are forbidden in popup text.
    expect(TABLE_PAGE).toContain(DEFERRED_COPY);
    expect(DEFERRED_COPY).not.toMatch(/—/);
  });

  it('the overlay is gated on the ENGINE agreement, so a reload does not re-ask', () => {
    // The durable half. Without it the prompt returns on every fresh load of a
    // table the player has already answered for.
    /* Anchored on the gate's OWN clause rather than on the membership test,
       which by now appears three times (the flag-reset effect, the footer
       label, and here) — an occurrence index over a string that keeps gaining
       call sites is a magic number wearing a different hat. This clause reads
       `includes(userId)`; the footer's reads `includes(userId!)`, so the
       anchor cannot slide onto it. */
    const gate = sliceEnclosingBlock(
      TABLE_PAGE,
      '!(tableState.postBBDeferredUserIds ?? []).includes(userId) &&'
    );
    expect(gate).toMatch(/tableState\.waitingForBBUserIds\.includes\(userId\)/);
    expect(gate).toMatch(/!\(tableState\.postBBDeferredUserIds \?\? \[\]\)\.includes\(userId\)/);
    expect(gate).toMatch(/!bbPostAgreed/);
  });

  it('the agreement survives the wire: engine field -> mapper -> page state', () => {
    // A field that is published but never mapped is the quiet version of this
    // bug — everything looks right and the prompt still comes back.
    expect(MAPPER).toMatch(/postBBDeferredUserIds/);
    expect(MAPPER).toMatch(/post_bb_deferred_user_ids/);
    expect(TABLE_PAGE).toMatch(/postBBDeferredUserIds: mapped\.postBBDeferredUserIds/);
    expect(API).toMatch(/deferred\?: boolean/);
  });

  it('an older engine that does not publish it falls back to asking, not to silence', () => {
    // Fail OPEN. Hiding the prompt when the engine has no agreement to report
    // would strand a player who really does need to answer.
    expect(MAPPER).toMatch(
      /post_bb_deferred_user_ids\?: string\[\] \}\)\.post_bb_deferred_user_ids \?\? \[\]/
    );
  });

  it('the reserved-seat footer stops contradicting the overlay', () => {
    /* Dan 2026-08-30. In the screenshot from 2026-08-29 the overlay says
       "Post Big Blind To Enter" and the bar below says "Seat Reserved, You'll
       Be Dealt In Next Hand" AT THE SAME TIME. They cannot both be true, and
       the footer is the wrong one — a player between the blinds waits for the
       button to pass, which is two or three hands. It is also the one people
       believe, because it is not a button.

       Three states, and the sentence must depend on which one holds. */
    expect(
      TABLE_PAGE.indexOf('SAY WHICH STATE YOU ARE ACTUALLY IN'),
      'the reserved-seat footer branch is gone'
    ).toBeGreaterThan(-1);
    // The IIFE body that computes the label, bounded by its own braces.
    const bar = sliceEnclosingBlock(TABLE_PAGE, 'SAY WHICH STATE YOU ARE ACTUALLY IN');

    // It must ASK the engine, not assume.
    expect(bar).toMatch(/waitingForBBUserIds/);
    expect(bar).toMatch(/postBBDeferredUserIds/);
    expect(bar).toMatch(/bbPostAgreed/);

    // Held and unanswered: agrees with the overlay instead of promising a deal.
    expect(bar).toContain('Seat Reserved, Post The Big Blind Or Wait For It');
    // Held and answered: nothing is being asked, and it names the real trigger.
    expect(bar).toContain('Posting The Big Blind, You Are Dealt In When The Button Passes');
    // Not held: the original sentence survives, now only said when it is true.
    expect(bar).toContain("Seat Reserved, You'll Be Dealt In Next Hand");
  });

  it('the optimistic flag cannot outlive the hold', () => {
    // It HIDES a prompt, so a stale one is worse than no flag at all: the
    // player would sit unable to answer. Cleared as soon as the engine stops
    // listing the hero as held.
    expect(
      TABLE_PAGE.indexOf('if (!bbPostAgreed) return;'),
      'the flag reset effect is gone'
    ).toBeGreaterThan(-1);
    // The useEffect callback body, bounded by its own braces.
    const effect = sliceEnclosingBlock(TABLE_PAGE, 'if (!bbPostAgreed) return;');
    expect(effect).toMatch(/waitingForBBUserIds\.includes\(userId\)/);
    expect(effect).toMatch(/setBBPostAgreed\(false\)/);
  });
});
