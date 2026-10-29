import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import ts from 'typescript';

const page = readFileSync(resolve(__dirname, '../../src/pages/TablePage.tsx'), 'utf8');
const parsed = ts.createSourceFile(
  'TablePage.tsx',
  page,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX
);
function eventHandler(event: string): string {
  let found = '';
  const visit = (node: ts.Node) => {
    if (ts.isIfStatement(node) && node.expression.getText(parsed) === `eventType === '${event}'`)
      found = node.getText(parsed);
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  expect(found).not.toBe('');
  return found;
}

// Owner correction October 28: a settled choice has no felt announcement.
describe('the run-choice strip leaves when the decision is settled', () => {
  it.each([
    ['rit_all_accepted', { runs: 2 }],
    ['rit_all_accepted', { runs: 3 }],
    ['rit_mandatory', { runs: 2 }],
    ['rit_mandatory', { runs: 3 }],
    ['rit_single_run', { reason: 'chooser_chose_one', player_id: 'chooser' }],
    ['rit_single_run', { reason: 'player_declined', player_id: 'chooser' }],
    ['rit_single_run', { reason: 'no_answer', player_id: 'chooser' }],
  ])('%s clears immediately for %j, including replay', (eventType, handState) => {
    let strip: string | null = 'Waiting For Players.';
    let deadline: unknown = { kind: 'rit', at: Date.now() + 25000 };
    const panel = vi.fn();
    const scope = {
      eventType,
      handState,
      ritPanelOpenTimerRef: { current: null },
      setShowRIT: panel,
      setRitHeroAccepted: vi.fn(),
      ritDeadlineRef: { current: Date.now() + 25000 },
      setDecisionDeadline: (update: (value: unknown) => unknown) => {
        deadline = update(deadline);
      },
      clearRitWaitingStrip: () => {
        strip = null;
      },
      ritExpectedRunsRef: { current: 0 },
      setRitRunsThisHand: vi.fn(),
      ritConfirmationShownRef: { current: false },
      showRitFeltBanner: (text: string) => {
        strip = text;
      },
      resetRitPanelState: () => {
        strip = null;
        deadline = null;
      },
      tableStateRef: { current: { players: [{ id: 'chooser', name: 'WooWoo' }] } },
      clearTimeout,
    };
    const body = eventHandler(eventType);
    const execute = new Function(...Object.keys(scope), ts.transpile(body));
    for (let replay = 0; replay < 2; replay++) {
      execute(...Object.values(scope));
      expect(strip).toBeNull();
      expect(deadline).toBeNull();
      expect(panel).toHaveBeenLastCalledWith(false);
    }
  });

  it('anchors the waiting strip to the board rather than the player-card band', () => {
    const board = page.indexOf('<div className="community-area">');
    const strip = page.indexOf('className="rit-felt-banner"');
    const cards = page.indexOf('ritBoardsView.length >= 2 ?', board);
    expect(strip).toBeGreaterThan(board);
    expect(strip).toBeLessThan(cards);
  });
});
