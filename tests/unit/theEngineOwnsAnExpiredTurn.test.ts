/**
 * ═══ THE ENGINE OWNS AN EXPIRED TURN (2026-10-04) ════════════════════════════
 *
 * Six times in the hands Dan reported on 2026-10-04 a popup told him "The
 * Table View Is Out Of Date. Reload To Continue." It appeared on the lobby and
 * on the financial pages as well as at a table, because the table that raised
 * it was mounted behind them.
 *
 * Each one was TablePage folding for him. A client-side fold lived behind the
 * local turn timer (`handleTimerAutoFold`): when the page's own ring reached
 * zero it asked the engine for a time bank, and on a refusal it submitted a
 * fold. Production, the same hands, engine clock:
 *
 *   19:38:11.025  engine force-folds seat 1 (its time bank ran out)
 *   19:38:11.131  the page's fold is refused, the popup is shown
 *   19:38:55.631  engine force-folds seat 1
 *   19:38:55.647  refused, popup
 *   19:42:15.251  engine force-folds seat 1
 *   19:42:15.311, .694, 19:42:17.031  refused on three clients, popup on each
 *
 * A refused bank request usually MEANS the turn is already over, so the fold
 * that followed it was for a hand the engine had finished. It carried no
 * decision context (the callback closed over a submitter from an earlier
 * render), which is the only reason the engine refused it. Given the right
 * context, the same code folds a player during a time bank: the engine
 * extends a turn for a bank without publishing a new deadline, so the "six
 * seconds past the deadline" this fold waited for is the MIDDLE of the bank.
 *
 * The page knows less about the clock than the engine does. So it does not
 * fold. The engine checks or folds an expired seat itself.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { blankNonCode, sliceCall, sliceMethod } from '../helpers/sourceWindow';

const PAGE = readFileSync(resolve(__dirname, '../../src/pages/TablePage.tsx'), 'utf8');
/** Comments and strings blanked: only code can satisfy, or break, a pin. */
const CODE = blankNonCode(PAGE);

/** The guard the removed fold used: true means "send the fold". */
function previousGuardSendsFold(deadline: number | undefined, now: number): boolean {
  if (deadline && now < deadline + 6000) return false;
  return true;
}

describe('why the page may not fold: what it knew when it did', () => {
  const D = 1_800_000_015_000; // the engine's primary deadline for the turn

  it('a hand that had just ended has no deadline, and no deadline meant fold', () => {
    // HAND_COMPLETE clears the deadline from page state. The bank refusal
    // arrives a moment later, and the guard read "no deadline" as "go".
    expect(previousGuardSendsFold(undefined, D + 22_100)).toBe(true);
  });

  it('six seconds past the primary deadline is the middle of a time bank', () => {
    // The engine starts a 20s bank at the deadline plus its 2s grace, and
    // publishes no new deadline for it. The page still holds D.
    const bankEnds = D + 2_000 + 20_000;
    const lateTick = D + 9_000; // a hidden tab's timer, running late
    expect(lateTick).toBeLessThan(bankEnds);
    expect(previousGuardSendsFold(D, lateTick)).toBe(true);
  });
});

describe('TablePage submits only what the player chose', () => {
  it('there is no client-side fold behind the turn timer', () => {
    expect(CODE).not.toMatch(/handleTimerAutoFold/);
    expect(CODE).not.toMatch(/AutoFold\(/);
  });

  it('the timer expiring asks for a time bank and submits nothing', () => {
    const timer = sliceCall(PAGE, 'useTableTimer({');
    const code = blankNonCode(timer);
    expect(code).toMatch(/GameServerAPI\.activateTimeBank\(tableId, userId\)/);
    expect(code).not.toMatch(/submitAction/);
    expect(code).not.toMatch(/Fold\(/);
    // A refused bank still takes the borrowed time off the clock.
    expect(code).toMatch(/setTimeBankActive\(false\);/);
  });

  it('every action the page sends comes from the action panel handler', () => {
    // The one sender, and the one place that calls it.
    const senders = CODE.match(/[^A-Za-z_.]submitAction\(/g) ?? [];
    expect(senders, 'submitAction is called outside submitActionWithToast').toHaveLength(1);
    const wrapper = sliceMethod(PAGE, 'const submitActionWithToast = useCallback(');
    expect(blankNonCode(wrapper)).toMatch(/await submitAction\(/);

    const panel = sliceMethod(PAGE, 'const handleActionPanelAction = useCallback(');
    const inPanel = (blankNonCode(panel).match(/submitActionWithToast\(/g) ?? []).length;
    const inPage = (CODE.match(/submitActionWithToast\(/g) ?? []).length;
    expect(inPanel).toBeGreaterThan(0);
    expect(inPage, 'an action is submitted from outside the action panel handler').toBe(inPanel);
  });
});
