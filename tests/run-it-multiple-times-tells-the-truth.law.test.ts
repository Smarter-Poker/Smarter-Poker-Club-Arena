/**
 * RUN IT MULTIPLE TIMES TELLS THE TRUTH (Dan 2026-09-04, binding)
 *
 * Hand #6145364, PLO6, run it 3 times. The engine dealt all three boards and
 * settled a triple scoop by the cards. What the player saw: run 3 with no
 * result, the opponent's hand mucked before the boards were even out,
 * "Waiting For Players To Run It Multiple Times." sitting over the result,
 * "TRIPLE SCOOP!" up while run 1's flop was still landing, and a red
 * "RUN IT / 0s Left" pill that stayed in the tab strip for the rest of the
 * session. Then the bust rebuy read "insufficient balance" on a player with
 * chips, and the seat was stood up.
 *
 * Each of these was a place where one part of the client kept believing
 * something the rest of the hand had already moved past. These pins hold the
 * corrections; each is a bug that shipped.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sliceEnclosingBlock } from './helpers/sourceWindow';

const ROOT = resolve(__dirname, '..');
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');
const page = read('src/pages/TablePage.tsx');

const handler = (eventName: string) =>
  sliceEnclosingBlock(page, `if (eventType === '${eventName}')`);

describe('the offer is over when consent completes', () => {
  it('rit_all_accepted closes the deadline, the clock and the waiting strip', () => {
    const block = handler('rit_all_accepted');
    expect(block).toContain('ritDeadlineRef.current = 0;');
    expect(block).toContain("setDecisionDeadline((prev) => (prev?.kind === 'rit' ? null : prev));");
    expect(block).toContain('clearRitWaitingStrip();');
  });

  it('rit_mandatory and rit_result do the same, whatever path got them there', () => {
    for (const name of ['rit_mandatory', 'rit_result']) {
      const block = handler(name);
      expect(block, name).toContain('ritDeadlineRef.current = 0;');
      expect(block, name).toContain(
        "setDecisionDeadline((prev) => (prev?.kind === 'rit' ? null : prev));"
      );
    }
    expect(handler('rit_result')).toContain('clearRitWaitingStrip();');
  });

  it('the hand-boundary reset clears the tab clock too', () => {
    const reset = sliceEnclosingBlock(page, 'const resetRitPanelState = useCallback(');
    expect(reset).toContain("setDecisionDeadline((prev) => (prev?.kind === 'rit' ? null : prev));");
  });

  it('the tab strip refuses to show a clock that has already run out', () => {
    const multi = read('src/pages/MultiTablePage.tsx');
    expect(multi).toContain('const d = raw && raw.at > nowMs ? raw : null;');
  });
});

describe('the felt waits for the last run before it judges', () => {
  it('the scoop banner is scheduled against the end of the reveal, not a flat 2.2s', () => {
    expect(page).toContain('const end = ritRevealEndsAtRef.current;');
    expect(page).toContain(
      'return end > Date.now() ? Math.max(base, end - Date.now() + scoopBeat) : base;'
    );
    // pot_win can beat rit_result onto the wire: wait for the timeline, bounded.
    expect(page).toContain('if (ritExpected && ritRevealEndsAtRef.current === 0) {');
    expect(page).not.toContain('}, 2200 * getAnimationSpeed());');
  });

  it("the losers' cards stay up until the reveal is finished", () => {
    expect(page).toContain(
      'revealEnd > Date.now() ? Math.max(muckBase, revealEnd - Date.now() + 200) : muckBase;'
    );
    expect(page).toContain('}, muckDelay);');
  });
});

describe('an unknown balance is unknown, not zero', () => {
  it('the layer passes null through instead of collapsing it', () => {
    const layer = read('src/components/table/TableModalsLayer.tsx');
    expect(layer).toContain('accountBalance={bustWalletBalance}');
    expect(layer).not.toContain('accountBalance={bustWalletBalance ?? 0}');
    expect(layer).toContain('onRetryBalance={onRetryBustBalance}');
  });

  it('the modal says so and offers a retry, and never calls it insufficient', () => {
    const modal = read('src/components/table/BuyInModal.tsx');
    expect(modal).toContain('accountBalance: number | null;');
    expect(modal).toContain(
      'const hasEnoughBalance = balanceKnown && accountBalance >= clampedBuyIn;'
    );
    expect(modal).toContain("'Balance Unavailable'");
    expect(modal).toContain('onClick={onRetryBalance}');
  });

  it('the bust prompt reads twice before giving up', () => {
    const helper = sliceEnclosingBlock(page, 'const readBustBalance = useCallback(');
    expect(helper).toContain('for (let attempt = 0; attempt < 2; attempt += 1)');
    expect(helper).toContain('return null;');
    expect(page).toContain('setBustWalletBalance(await readBustBalance(userId, tableId));');
  });
});

describe('the record says who won each run', () => {
  it('the settlement snapshot carries the per-board winners and the writer persists them', () => {
    const settlement = read('server/src/engine/ServerTableEngineSettlement.ts');
    expect(settlement).toContain('winnersByBoard: [...this.currentHandWinnersByBoard],');
    expect(settlement).toContain('winnersByBoard: snap.winnersByBoard,');
    const writer = read('server/src/services/supabase/handHistory.ts');
    expect(writer).toContain(
      'winners_by_board: params.winnersByBoard?.some((w) => w.board > 1 || w.low)'
    );
    // NULL on a single-board hand: ordinary rows stay byte-identical.
    expect(writer).toMatch(/winners_by_board:[\s\S]{0,120}: null,/);
  });
});
describe('second sweep (2026-09-04): the parts the first fix missed or broke', () => {
  it('a scoop banner waits for a RIT reveal ONLY when a RIT was agreed (bomb pots do not stall)', () => {
    // Regression from the first fix: `|| boardsSeen.length >= 2` inside a block
    // entered only when boardsSeen.length >= 2 made this constant true, so every
    // double/triple-board bomb pot polled 8s for a timeline that never comes.
    expect(page).toContain('const ritExpected = ritExpectedRunsRef.current >= 2;');
    expect(page).not.toContain('ritExpectedRunsRef.current >= 2 || boardsSeen.length >= 2');
  });

  it('the scoop timers die at the hand boundary, on their own refs', () => {
    const started = sliceEnclosingBlock(page, 'if (scoopBannerClearTimerRef.current) {');
    expect(page).toContain(
      'const scoopBannerClearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);'
    );
    expect(started).toContain('clearTimeout(scoopBannerClearTimerRef.current)');
    expect(page).toContain('scoopBannerClearTimerRef.current = setTimeout(() => {');
  });

  it('the waiting strip is compared by its rendered form, not a coincidence', () => {
    expect(page).toContain(
      'const RIT_WAITING_BANNER_RENDERED = formatPopupText(RIT_WAITING_BANNER);'
    );
    expect(page).toContain('clearRitWaitingStrip();');
  });

  it('the tab strip never alarms or animates for an expired decision', () => {
    const multi = read('src/pages/MultiTablePage.tsx');
    expect(multi).toContain('(parseTimed(t.decision)?.at ?? 0) > nowMs ||');
    expect(multi).toContain('if (left > 5 || left <= 0) continue;');
    expect(multi).toContain('const d = raw && raw.at > nowMs ? raw : null;');
  });

  it('the felt shows the engine verdict per board: hi-lo halves named, net shares', () => {
    expect(page).toContain(
      'const awardsHere = (ritResult.perBoardAwards || []).filter((a) => a.board === bi + 1);'
    );
    expect(page).toContain("${a.low ? ' (Low)' : ''}");
    expect(page).toContain('const netTotal = ritResult.netPot ?? ritResult.potTotal;');
    expect(page).not.toContain('const boardPot = Math.floor(ritResult.potTotal / runs);');
    const runout = read('server/src/engine/ServerTableEngineRunout.ts');
    expect(runout).toContain('per_board_awards: this.currentHandPerPotAwards.map((a) => ({');
    expect(runout).toContain('net_pot: netPot,');
  });

  it('winners_by_board is post-rake on every path that writes it', () => {
    const hc = read('server/src/engine/HandController.ts');
    expect(hc).toContain('winnersByBoard: winnersByBoardPostRake,');
    expect(hc).not.toContain('winnersByBoard: this.pendingWinnersByBoard,');
  });

  it('a reconnect during a runout sees the tabled hands, like everyone else', () => {
    const eng = read('server/src/engine/ServerTableEngine.ts');
    // Three reveal gates, one rule: broadcast, resync, observer.
    expect(
      eng.match(/state\.stage === 'showdown' \|\| this\.runoutRevealActive/g)?.length ?? 0
    ).toBeGreaterThanOrEqual(3);
  });

  it('an unknown balance is unknown on the normal buy-in and the cashier too', () => {
    expect(page).not.toContain('accountBalance={accountBalance ?? 0}');
    const layer = read('src/components/table/TableModalsLayer.tsx');
    expect(layer).toContain('accountBalance: number | null;');
    expect(layer).toContain('onRetryBalance={onRetryAccountBalance}');
    const cashier = read('src/components/table/CashierModal.tsx');
    expect(cashier).toContain(
      "balanceKnown ? formatAmount(accountBalance, currency) : 'Unavailable'"
    );
  });

  it('a busted seat is not released while its owner is at the rebuy dialog', () => {
    const dealing = read('server/src/engine/ServerTableEngineDealing.ts');
    expect(dealing).toContain('static readonly REBUY_PROMPT_HOLD_MS = 12_000;');
    expect(dealing).toContain(
      'if (now - promptSeen < ServerTableEngineDealing.REBUY_PROMPT_HOLD_MS) {'
    );
    const turns = read('server/src/engine/ServerTableEngineTurns.ts');
    expect(turns).toContain(
      'if (opts?.rebuyPromptOpen) this.rebuyPromptOpenAt.set(userId, Date.now());'
    );
    expect(page).toContain('rebuyPromptOpen: bustRebuyOpenRef.current,');
  });
});
