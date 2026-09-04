/**
 * PREVIOUS HAND SHOWS THIS TABLE'S HANDS (Dan 2026-09-04, binding)
 *
 * "THE PREVIOUS HAND FUNCTIONALITY IS COMPLETELY BROKEN, UN ORGANIZED,
 * DOESN'T DISPLAY THE CORRECT DATA, DOESN'T DISPLAY THE CORRECT HANDS."
 *
 * What it was doing: listing the player's last 50 hands from EVERY table they
 * had ever sat at, ordered by the row's insert time (a retry-queued row lands
 * minutes late and jumps the queue), caching that cross-table list under each
 * table's own localStorage key, filing fold-around hands under "Showdown"
 * with a roster of card backs, printing sb/bb/ante/return as raw database
 * tokens and ADDING a returned uncalled bet to the pot, showing one board for
 * a double-board bomb pot, and refusing to say who won each run of a
 * run-it-twice hand - because until today the row could not say either.
 *
 * Each pin here is one of those, corrected.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { buildReplay } from '../src/utils/handReplay';

const ROOT = resolve(__dirname, '..');
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');

/** Four dealt, two folded preflop, two saw a river and both showed. */
const FOLD_THEN_SHOW = {
  handNumber: 1,
  playedAt: '2026-09-04T20:00:00.000Z',
  gameVariant: 'nlh',
  smallBlind: 1,
  bigBlind: 2,
  potSize: 100,
  rakeAmount: 0,
  bbjAmount: 0,
  buttonSeat: 1,
  board: ['2h', '7d', '9c', 'Ts', '3d'],
  players: [
    { seat: 1, userId: 'f1', username: 'Folder One', stack: 100 },
    { seat: 2, userId: 'f2', username: 'Folder Two', stack: 100 },
    { seat: 3, userId: 'w', username: 'Winner', stack: 100 },
    { seat: 4, userId: 's', username: 'Shower', stack: 100 },
  ],
  actions: [
    { seat: 1, stage: 'preflop', action: 'fold', amount: 0, userId: 'f1' },
    { seat: 2, stage: 'preflop', action: 'fold', amount: 0, userId: 'f2' },
    { seat: 3, stage: 'preflop', action: 'raise', amount: 10, userId: 'w' },
    { seat: 4, stage: 'preflop', action: 'call', amount: 10, userId: 's' },
    { seat: 3, stage: 'river', action: 'bet', amount: 40, userId: 'w' },
    { seat: 4, stage: 'river', action: 'call', amount: 40, userId: 's' },
  ],
  winners: [{ userId: 'w', amount: 100, potIndex: 0, hand: { name: 'Two Pair', ranking: 3 } }],
  holeCards: {
    w: ['9h', '9s'],
    s: ['Th', 'Jh'],
  },
  showdown: [
    { user_id: 'w', seat: 3, mucked: false, reveal_order: 0, hand_name: 'Two Pair' },
    { user_id: 's', seat: 4, mucked: false, reveal_order: 1, hand_name: 'Pair' },
  ],
  pots: [{ index: 0, amount: 100 }],
};

describe('the correct hands', () => {
  it('a live table asks for ITS hands, in play order', () => {
    const svc = read('src/services/HandHistoryService.ts');
    expect(svc).toContain("if (opts.tableId) query = query.eq('table_id', opts.tableId);");
    expect(svc).toContain(".order('hand_number', { ascending: false })");
    expect(svc).not.toContain(".order('created_at', { ascending: false })\n      .limit(limit)");
    const page = read('src/pages/TablePage.tsx');
    expect(page).toContain('handHistoryService.getPlayerHands(userId, 50, { tableId })');
    expect(page).toContain('handHistoryService.getPlayerHands(userId, 1, { tableId })');
  });

  it('the cache key changed, and every v1 key is thrown away', () => {
    const page = read('src/pages/TablePage.tsx');
    expect(page).toContain('hand_history_v2_${tableId');
    expect(page).not.toMatch(/localStorage\.(get|set)Item\(`hand_history_\$\{tableId/);
    expect(page).toContain("if (!key.startsWith('hand_history_v2_')) {");
  });

  it('played_at is when the hand was played, not when the row landed', () => {
    expect(read('src/services/HandHistoryService.ts')).toContain(
      'played_at: (row as any).started_at || row.created_at,'
    );
  });
});

describe('the correct data', () => {
  it('a showdown is a card turning over; a fold-around is not filed under one', () => {
    const panel = read('src/components/table/HandHistoryPanel.tsx');
    expect(panel).toContain('{!hand.wentToShowdown && hand.winners.length > 0 && (');
    expect(panel).toContain('{hand.wentToShowdown && showdownRows.length > 0 && (');
    expect(panel).toContain(
      '.filter((p) => (p.holeCards && p.holeCards.length > 0) || mucked.has(p.id))'
    );
    expect(panel).toContain("{r.mucked ? 'Mucked' : 'Not Shown'}");
    // Behaviour, not text: a four-handed hand where two folded and two showed
    // has exactly two showdown rows, both with cards.
    const m = buildReplay(FOLD_THEN_SHOW as never);
    const rows = m.showdown.filter((r) => r.boardIndex === 0);
    expect(rows.map((r) => r.name).sort()).toEqual(['Shower', 'Winner']);
    expect(rows.every((r) => r.hole !== null)).toBe(true);
    // A fold-around: nobody showed, nobody mucked at showdown, no rows at all.
    const walk = buildReplay({ ...FOLD_THEN_SHOW, holeCards: {}, showdown: [] } as never);
    expect(walk.showdown).toHaveLength(0);
  });

  it('who won each board comes from the record, on every surface', () => {
    const svc = read('src/services/HandHistoryService.ts');
    expect(svc).toContain('winners_by_board');
    const adapter = read('src/lib/handHistoryAdapter.ts');
    expect(adapter).toContain('winnersByBoard: (h.winners_by_board || []).length');
    const panel = read('src/components/table/HandHistoryPanel.tsx');
    expect(panel).toContain('const winners = byBoard.get(bi + 1) || [];');
    const modal = read('src/components/table/HandDetailModal.tsx');
    expect(modal).toContain('const winners = byBoard.get(bi + 1) || [];');
    const model = read('src/hooks/useHandReplayModel.ts');
    expect(model).toContain("'winners_by_board',");
    expect(model).toContain("'community_cards3',");
    // Behaviour: with winners_by_board, a player who took only board 2 is a
    // winner on board 2 and not on board 1, under board 2's own hand name.
    const m = buildReplay({
      ...FOLD_THEN_SHOW,
      extraBoards: [['Ah', 'Kh', 'Qh', 'Jh', '2c']],
      winnersByBoard: [
        { board: 1, userId: 'w', amount: 50, handName: 'Two Pair' },
        { board: 2, userId: 's', amount: 50, handName: 'Flush' },
      ],
    } as never);
    const board2 = m.showdown.filter((r) => r.boardIndex === 1);
    const board1 = m.showdown.filter((r) => r.boardIndex === 0);
    expect(board2.find((r) => r.userId === 's')?.isWinner).toBe(true);
    expect(board2.find((r) => r.userId === 's')?.handName).toBe('Flush');
    expect(board1.find((r) => r.userId === 's')?.isWinner).toBe(false);
    expect(board1.find((r) => r.userId === 'w')?.isWinner).toBe(true);
    // The "covers every run" note survives ONLY for rows that predate the column.
    expect(panel).toContain('{!hasPerBoard && (');
    expect(modal).toContain('{byBoard.size === 0 && (');
  });

  it('bomb-pot boards reach the panel', () => {
    const adapter = read('src/lib/handHistoryAdapter.ts');
    expect(adapter).toContain('const bombBoards = [h.community_cards2, h.community_cards3]');
    expect(read('src/components/table/HandHistoryPanel.tsx')).toContain(
      'const extra = hand.ritBoards?.length ? hand.ritBoards : hand.bombBoards;'
    );
  });

  it('a returned uncalled bet leaves the pot, and the forced posts read as words', () => {
    const modal = read('src/components/table/HandDetailModal.tsx');
    expect(modal).toContain("acc += a.action === 'return' ? -a.amount : a.amount;");
    expect(modal).toContain("rowPot += a.action === 'return' ? -a.amount : a.amount;");
    const panel = read('src/components/table/HandHistoryPanel.tsx');
    expect(panel).toContain("case 'return':\n      return 'Uncalled, Returned';");
    expect(panel).toContain("case 'sb':\n      return 'Posts SB';");
    expect(panel).toContain('{getActionLabel(a.action)}');
  });

  it('rake is on the panel, beside the pot it came out of', () => {
    expect(read('src/components/table/HandHistoryPanel.tsx')).toContain(
      '{hand.rake > 0 && <span className="hh-entry__rake"> · Rake {formatAmount(hand.rake)}</span>}'
    );
  });
});

describe('the record is readable by everyone who played it', () => {
  it('the writer never files a hand under a roster missing a participant', () => {
    const settlement = read('server/src/engine/ServerTableEngineSettlement.ts');
    expect(settlement).toContain('...snap.holeCards.keys(),');
    expect(settlement).toContain('...snap.winners.map((w) => w.userId),');
    expect(settlement).toContain('[hand_history] roster disagreed with the hand');
  });
});
