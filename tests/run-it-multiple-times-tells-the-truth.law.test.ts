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
    expect(block).toContain(
      'setRitFeltBanner((prev) => (prev === RIT_WAITING_BANNER ? null : prev));'
    );
  });

  it('rit_mandatory and rit_result do the same, whatever path got them there', () => {
    for (const name of ['rit_mandatory', 'rit_result']) {
      const block = handler(name);
      expect(block, name).toContain('ritDeadlineRef.current = 0;');
      expect(block, name).toContain(
        "setDecisionDeadline((prev) => (prev?.kind === 'rit' ? null : prev));"
      );
    }
    expect(handler('rit_result')).toContain(
      'setRitFeltBanner((prev) => (prev === RIT_WAITING_BANNER ? null : prev));'
    );
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
    expect(writer).toContain('winners_by_board: params.winnersByBoard?.some((w) => w.board > 1)');
    // NULL on a single-board hand: ordinary rows stay byte-identical.
    expect(writer).toMatch(/winners_by_board:[\s\S]{0,120}: null,/);
  });
});
