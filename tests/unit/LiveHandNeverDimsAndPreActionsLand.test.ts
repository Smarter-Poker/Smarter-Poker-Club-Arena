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
  it('arming retries instead of losing to a 30s circuit breaker', () => {
    expect(code).toMatch(/retryAsync\(\(\) => serverSetPreAction\(tableId, serverAction\)/);
  });

  it('clearing retries too - it is the direction that folds a live hand', () => {
    expect(code).toMatch(/retryAsync\(\(\) => serverSetPreAction\(tableId, 'clear'\)/);
  });

  it('a failed clear restores the armed control rather than going dark', () => {
    // If the engine is still holding it, the player must be able to SEE it.
    // BOTH failure paths must restore it: the resolved-but-refused branch AND
    // the thrown branch. Requiring only one let a mutation that removed the
    // first still pass, which is how this pin was caught being too weak.
    const restores = code.match(/if \(armed\) setPreAction\(armed\)/g) ?? [];
    expect(restores, 'expected the armed control restored in .then AND .catch').toHaveLength(2);
  });

  it('a failed arm still disarms, so the bar never claims what the engine refused', () => {
    expect(code).toMatch(/setPreAction\(null\); /);
    expect(code).toMatch(/PreAction_set_refused/);
  });

  it('both directions survive a thrown error, not just a falsy result', () => {
    expect(code).toMatch(/PreAction_set_threw/);
    expect(code).toMatch(/PreAction_clear_threw/);
  });
});
