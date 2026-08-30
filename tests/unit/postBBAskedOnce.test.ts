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

    for (const call of calls) {
      const window = TABLE_PAGE.slice(call.index ?? 0, (call.index ?? 0) + 1200);
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
    // lastIndexOf, deliberately: the flag-reset effect earlier in the file
    // tests the same membership, and anchoring on the first hit reads the
    // wrong block.
    const at = TABLE_PAGE.lastIndexOf('tableState.waitingForBBUserIds.includes(userId)');
    expect(at, 'the overlay gate moved').toBeGreaterThan(-1);
    const gate = TABLE_PAGE.slice(at, at + 900);
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

  it('the optimistic flag cannot outlive the hold', () => {
    // It HIDES a prompt, so a stale one is worse than no flag at all: the
    // player would sit unable to answer. Cleared as soon as the engine stops
    // listing the hero as held.
    const at = TABLE_PAGE.indexOf('if (!bbPostAgreed) return;');
    expect(at, 'the flag reset effect is gone').toBeGreaterThan(-1);
    const effect = TABLE_PAGE.slice(at, at + 500);
    expect(effect).toMatch(/waitingForBBUserIds\.includes\(userId\)/);
    expect(effect).toMatch(/setBBPostAgreed\(false\)/);
  });
});
