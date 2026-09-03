/**
 * TWO MOBILE BUGS FROM THE FELT (Dan 2026-08-27).
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 1. "Sometimes cards dim like you folded, even though you are live in a
 *     hand. That should never happen while you still have a hand."
 *
 *    The dim comes from `winnerDisplayActive`, which darkens every face-up
 *    card outside the winning five. Its only fence was a RESET at hand start,
 *    and a reset cannot fence an OUT-OF-ORDER event: a POT_WIN belonging to
 *    hand N arriving after hand N+1 had started merged into the fresh hand and
 *    dimmed the hero's brand-new hole cards. The merge comment even claimed
 *    "the hand-start resets fence the union to the current hand" - true only
 *    while events arrive in order.
 *
 *    Fixed with a hand number, which survives any delivery order, at BOTH
 *    ends: the merge refuses a payload that is not for the live hand, and the
 *    render refuses to dim for winners stamped with a different hand.
 *
 * 2. "There are bugs in the pre action buttons, they don't work and function
 *     all the time, and sometimes stay engaged on future streets."
 *
 *    Both halves were one-shot network calls. `setPreAction` resolves
 *    { success: false } rather than throwing - including for a FULL 30 SECONDS
 *    whenever GameServerAPI's circuit breaker is open - so a single attempt
 *    inside that window simply lost.
 *
 *    The clear direction was the one that costs a hand: the ENGINE disposes
 *    pre-actions only at hand end while the CLIENT clears every street, so a
 *    failed clear left the engine armed and the bar dark. The player saw
 *    nothing engaged and the engine acted for them on a later street - exactly
 *    "stays engaged on future streets".
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const src = readFileSync(join(process.cwd(), 'src/pages/TablePage.tsx'), 'utf8');
/** Strip comments so the prose ABOUT these bugs cannot satisfy a pin. */
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('a live hand is never dimmed by a finished one', () => {
  it('winner state carries the hand it belongs to', () => {
    expect(code).toMatch(/handNumber: number;/);
  });

  it('the POT_WIN merge refuses winners from another hand', () => {
    // The fence must sit ABOVE the derived maps, or a stale display's
    // hole-card indices and amounts are carried forward anyway.
    const mergeIdx = code.indexOf('const mergedHole');
    const fenceIdx = code.indexOf('carried.handNumber !== liveHandNumber');
    expect(fenceIdx, 'expected a hand-number fence on the merge').toBeGreaterThan(-1);
    expect(fenceIdx, 'the fence must run before the merged maps are built').toBeLessThan(mergeIdx);
  });

  it('the render will not dim for winners stamped with a different hand', () => {
    expect(code).toMatch(/winnerInfo\.handNumber === \(tableState\.handNumber \?\? 0\)/);
  });

  it('still dims for the hand actually being shown down', () => {
    // The guarantee is "not another hand's winners", NOT "never dim" - the
    // showdown display is the feature this must not break. handNumber 0 is
    // the unstamped/legacy payload and is still honoured.
    expect(code).toMatch(/winnerInfo\.handNumber === 0 \|\|/);
    expect(code).toMatch(/winnerInfo\.playerIds\.length > 0 &&/);
  });
});

describe('pre-actions reach the engine, and never hide an armed one', () => {
  /* Dan 2026-08-28 rewrite: serverSetPreAction NEVER throws, so the old
     `retryAsync(() => serverSetPreAction(...))` shape resolved its first
     `{success:false}` and retried NOTHING — the pin here used to require
     exactly that broken shape. Both directions must now throw a retryable
     error on a falsy result so retryAsync's attempts are real. */
  it('arming retries for real: a falsy result is thrown as retryable', () => {
    expect(code).toMatch(/await serverSetPreAction\(tableId, serverAction, armCap\)/);
    expect(code).toMatch(/network\/preaction-arm/);
  });

  it('the armed CALL carries the price the player was looking at (Dan 2026-08-28)', () => {
    // "Call 15" can never call a raise to 65 — the arm-time price rides to
    // the engine as auto_call's cap, and only for auto_call.
    expect(code).toMatch(
      /serverAction === 'auto_call' \? preActionCallAmountRef\.current : undefined/
    );
    expect(code).toMatch(/preActionCallAmountRef\.current = Math\.max\(/);
  });

  it('clearing retries too - it is the direction that folds a live hand', () => {
    expect(code).toMatch(/await serverSetPreAction\(tableId, 'clear'\)/);
    expect(code).toMatch(/network\/preaction-clear/);
  });

  it('a failed clear restores the armed control rather than going dark', () => {
    // If the engine is still holding it, the player must be able to SEE it.
    // The restore must read from lastArmedPreActionRef — `const armed =
    // preAction` inside the clear branch is null by definition (dead code
    // this repo shipped until 2026-08-28).
    expect(code).toMatch(/const armed = lastArmedPreActionRef\.current/);
    const restores = code.match(/if \(armed\) setPreAction\(armed\)/g) ?? [];
    expect(
      restores.length,
      'expected the armed control restored on a failed clear'
    ).toBeGreaterThanOrEqual(1);
    expect(code).toMatch(/lastArmedPreActionRef\.current = preAction/);
  });

  it('a failed arm still disarms, so the bar never claims what the engine refused', () => {
    expect(code).toMatch(/setPreAction\(null\); /);
    expect(code).toMatch(/PreAction_set_refused/);
  });

  it('both failure paths report', () => {
    expect(code).toMatch(/PreAction_set_refused/);
    expect(code).toMatch(/PreAction_clear_refused/);
  });
});

describe('the action bar does not flash back after you act', () => {
  /* Dan 2026-08-27: "you make an action (check, call, raise or fold), the
     action happens, but then the action bar reappears for a split second."

     The bar renders on `currentPlayerSeat === heroSeat`. Acting optimistically
     sets that to 0 so it hides at once - but the snapshot merge then applied
     `currentPlayerSeat: mapped.currentPlayerSeat` UNCONDITIONALLY, and a
     snapshot generated before the engine processed the action still names the
     hero as the actor. It landed a beat later, handed the turn back, and the
     bar returned for exactly one round trip. */

  it('the merge no longer assigns the engine seat unconditionally', () => {
    expect(code).not.toMatch(/currentPlayerSeat: mapped\.currentPlayerSeat,/);
    expect(code).toMatch(/currentPlayerSeat: nextCurrentSeat,/);
  });

  it('a stale snapshot cannot hand the turn back to the seat that just acted', () => {
    expect(code).toMatch(/mapped\.currentPlayerSeat === fence\.seat/);
    expect(code).toMatch(/nextCurrentSeat = 0/);
  });

  it('the fence is armed only when the hero actually held the turn', () => {
    expect(code).toMatch(/if \(prev\.currentPlayerSeat === heroSeat\) \{/);
    expect(code).toMatch(/heroActedFenceRef\.current = \{/);
  });

  it('it is scoped to one hand, so it cannot leak into the next', () => {
    expect(code).toMatch(/fence\.hand !== snapHand/);
  });

  it('it releases the moment the engine names a different actor', () => {
    // The success signal. Without this the fence would sit out its full
    // timeout on every single action.
    expect(code).toMatch(/heroActedFenceRef\.current = null; /);
  });

  it('it expires on its own, so a lost action can never strand the player', () => {
    expect(code).toMatch(/HERO_ACTED_FENCE_MS/);
    expect(code).toMatch(/Date\.now\(\) >= fence\.until/);
  });

  it('a REJECTED action clears the fence and gives the turn straight back', () => {
    /* The other half of the same bug: revert() restored lastActions,
       lastBetAmounts and status but NOT currentPlayerSeat, which the
       optimistic update had zeroed - so a refused fold or call left the hero
       on the clock with no action bar at all until the next snapshot. */
    const revertIdx = code.indexOf('heroActedFenceRef.current = null;');
    expect(revertIdx).toBeGreaterThan(-1);
    expect(code).toMatch(
      /prev\.currentPlayerSeat === 0 \? \{ currentPlayerSeat: heroSeat \} : \{\}/
    );
  });
});
