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

  it('the record is read, never cached: no localStorage hand list at all', () => {
    /* 2026-09-04 second sweep. The per-table cache seeded a fresh sit-down
       with the previous visit's hands and only yielded to a fetch that
       returned rows, so a table with no hands showed somebody's stale list as
       "session stats". The cache is gone; old keys are removed once. */
    const page = read('src/pages/TablePage.tsx');
    expect(page).not.toMatch(/localStorage\.(get|set)Item\(`hand_history_/);
    expect(page).toContain("if (key?.startsWith('hand_history_')) localStorage.removeItem(key);");
    // An empty answer is applied, not ignored.
    expect(page).toContain(
      'setHandHistory((hands || []).map((h) => adaptServiceHandToPanel(h, userId)));'
    );
    expect(page).not.toContain('if (!cancelled && hands && hands.length > 0) {');
    // and the table id is a dependency of the fetch
    expect(page).toMatch(/\}, \[showHandHistory, showHandDetail, userId, tableId\]\);/);
  });

  it('played_at is when the hand was played, not when the row landed', () => {
    expect(read('src/services/HandHistoryService.ts')).toContain(
      'played_at: (row as any).started_at || row.created_at,'
    );
  });
});

describe('the correct data', () => {
  it('a showdown is a card turning over; a fold-around is not filed under one', () => {
    // Behaviour, not text: a four-handed hand where two folded and two showed
    // has exactly two showdown rows, both with cards.
    const m = buildReplay(FOLD_THEN_SHOW as never);
    const rows = m.showdown.filter((r) => r.boardIndex === 0);
    expect(rows.map((r) => r.name).sort()).toEqual(['Shower', 'Winner']);
    expect(rows.every((r) => r.hole !== null)).toBe(true);
    // A fold-around: nobody showed, nobody mucked at showdown, no rows at all.
    const walk = buildReplay({ ...FOLD_THEN_SHOW, holeCards: {}, showdown: [] } as never);
    expect(walk.showdown).toHaveLength(0);
    // The modal says so in words rather than drawing a roster of backs.
    const modal = read('src/components/table/HandDetailModal.tsx');
    expect(modal).toMatch(/No Showdown\{takenBy \? ` · Pot Taken By \$\{takenBy\}` : ''\}/);
  });

  it('ONE reconstruction: every surface renders hand.replay, and nothing walks the log itself', () => {
    /* 2026-09-04 second sweep. There were four: buildReplay, the modal's
       Summary adapter, the modal's "degraded" walk (which summed raise-TO
       levels as chips added) and the panel's own street list. The service
       builds the model once from the raw row and attaches it; the panel and
       the modal render it through HandDetailView. */
    const svc = read('src/services/HandHistoryService.ts');
    expect(svc).toContain('replayInputFromRow(row, {');
    expect(svc).toContain('replay,\n    };');
    const panel = read('src/components/table/HandHistoryPanel.tsx');
    expect(panel).toContain('<HandDetailView model={hand.replay}');
    expect(panel).not.toMatch(/getActionColor|getActionLabel|showdownRows/);
    const modal = read('src/components/table/HandDetailModal.tsx');
    expect(modal).toContain('const model = hand.replay;');
    expect(modal).not.toMatch(
      /useHandReplayModel|hdm-degraded|acc \+= a\.action|netOf|summaryRows/
    );
    // The replay hook (jackpot rundown) reads the row through the same mapper.
    expect(read('src/hooks/useHandReplayModel.ts')).toContain(
      'buildReplay(replayInputFromRow(data as unknown as HandHistoryRowLike))'
    );
    // No orphan normaliser beside it.
    expect(() => read('src/utils/handHistoryShape.ts')).toThrow();
  });

  it('who won each board comes from the record, on every surface', () => {
    const svc = read('src/services/HandHistoryService.ts');
    expect(svc).toContain("'winners_by_board',");
    expect(svc).toContain("'bomb_pot',");
    // ONE select list, so getHand and getPlayerHands cannot drift apart again
    // (getHand never selected winners_by_board; getPlayerHands never bomb_pot).
    expect(svc.match(/\.select\(\s*HAND_HISTORY_COLUMNS\s*\)/g)?.length).toBe(2);
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
    // Without the record, boards 2+ carry no invented share.
    const bare = buildReplay({
      ...FOLD_THEN_SHOW,
      extraBoards: [['Ah', 'Kh', 'Qh', 'Jh', '2c']],
    } as never);
    expect(bare.showdown.filter((r) => r.boardIndex === 1).every((r) => r.net === null)).toBe(true);
  });

  it('a board is listed once, whichever of its two recordings the row carries', () => {
    const both = buildReplay({
      ...FOLD_THEN_SHOW,
      extraBoards: [['Ah', 'Kh', 'Qh', 'Jh', '2c']],
      actions: [
        ...FOLD_THEN_SHOW.actions,
        {
          seat: 0,
          stage: 'river',
          action: 'rit_board_2:Ah,Kh,Qh,Jh,2c',
          amount: 0,
          userId: 'system',
        },
      ],
    } as never);
    expect(both.boards).toHaveLength(2);
  });

  it('a returned uncalled bet leaves the pot, and the forced posts read as words', () => {
    // Behaviour: a bet nobody calls comes back as a negative `return` row and
    // the pot the model reports excludes it.
    const m = buildReplay({
      ...FOLD_THEN_SHOW,
      potSize: 21,
      actions: [
        { seat: 1, stage: 'preflop', action: 'fold', amount: 0, userId: 'f1' },
        { seat: 2, stage: 'preflop', action: 'fold', amount: 0, userId: 'f2' },
        { seat: 3, stage: 'preflop', action: 'raise', amount: 10, userId: 'w' },
        { seat: 4, stage: 'preflop', action: 'call', amount: 10, userId: 's' },
        { seat: 3, stage: 'river', action: 'bet', amount: 40, userId: 'w' },
        { seat: 4, stage: 'river', action: 'fold', amount: 0, userId: 's' },
      ],
      winners: [{ userId: 'w', amount: 21, potIndex: 0, hand: null }],
      holeCards: {},
      showdown: [],
    } as never);
    const river = m.streets.find((st) => st.key === 'river')!;
    const ret = river.rows.find((r) => r.verb === 'return');
    expect(ret?.amount).toBe(-40);
    expect(ret?.label).toBe('Return');
    // 1 sb + 2 bb + 8 (raise to 10 over the 2 already in) + 10 call = 21
    expect(m.rebuiltPot).toBe(21);
    const pre = m.streets.find((st) => st.key === 'preflop')!;
    expect(pre.rows.find((r) => r.verb === 'sb')?.label).toBe('SB');
    expect(pre.rows.find((r) => r.verb === 'bb')?.label).toBe('BB');
  });

  it('rake is on the panel, beside the pot it came out of', () => {
    // Format-tolerant: Prettier decides the line breaks, the pin decides the truth.
    expect(read('src/components/table/HandHistoryPanel.tsx')).toMatch(
      /hand\.rake > 0 &&[\s(]*<span className="hh-entry__rake">[^<]*Rake \{formatAmount\(hand\.rake\)\}<\/span>/
    );
  });

  it('hi-lo: the low half is its own row, named by the same evaluator the engine pays with', () => {
    /* PLO8. Winner holds A-2 for the nut low on a 3-4-8 board; Shower holds a
       high-only hand. Without the per-half record the low row cannot say who
       was paid and does not; with it, it does. */
    const plo8 = {
      ...FOLD_THEN_SHOW,
      gameVariant: 'plo8',
      board: ['3h', '4d', '8c', 'Ks', 'Qd'],
      holeCards: { w: ['Ah', '2s', 'Kd', 'Kc'], s: ['Qh', 'Qs', 'Jh', 'Th'] },
    };
    const bare = buildReplay(plo8 as never);
    expect(bare.hiLo).toBe(true);
    const lowRows = bare.showdown.filter((r) => r.low);
    expect(lowRows.map((r) => r.userId)).toEqual(['w']);
    expect(lowRows[0].handName).toBe('Low: 8-4-3-2-1');
    expect(lowRows[0].isWinner).toBe(false);
    expect(lowRows[0].net).toBeNull();
    const paid = buildReplay({
      ...plo8,
      winnersByBoard: [
        { board: 1, userId: 'w', amount: 50, handName: 'Three Of A Kind' },
        { board: 1, userId: 'w', amount: 50, handName: 'Low: 8-4-3-2-1', low: true },
      ],
    } as never);
    const low = paid.showdown.find((r) => r.low && r.userId === 'w')!;
    expect(low.isWinner).toBe(true);
    expect(low.net).toBe(50);
    expect(low.boardLabel).toBe('Low');
    // The engine writes the half on every hi-lo award, single board included.
    const hc = read('server/src/engine/HandController.ts');
    expect(hc).toContain('const low = a.low === true;');
    expect(read('server/src/services/supabase/handHistory.ts')).toContain('w.board > 1 || w.low');
  });

  it('your own cards on a hand you folded: read through RLS, never a reveal', () => {
    const svc = read('src/services/HandHistoryService.ts');
    // No user id in the query: the policy narrows it (same shape as fetchOwnDiscards).
    const fn = svc.slice(
      svc.indexOf('private async fetchOwnHoleCards'),
      svc.indexOf('private async fetchTableNames')
    );
    expect(fn).toContain(".from('ca_hand_facts')");
    expect(fn).not.toMatch(/\.eq\('user_id'/);
    // Kept apart from hole_cards on the record
    expect(svc).toContain('private_hole_cards: privateForPlayer(uid),');
    // Behaviour: the folder's cards appear on their fold row and nowhere else.
    const m = buildReplay({
      ...FOLD_THEN_SHOW,
      privateHoleCards: { f1: ['7h', '2c'] },
    } as never);
    const fold = m.streets[0].rows.find((r) => r.userId === 'f1' && r.verb === 'fold')!;
    expect(fold.privateCards?.length).toBe(2);
    expect(m.showdown.some((r) => r.userId === 'f1')).toBe(false);
    expect(
      m.streets.flatMap((st) => st.rows).some((r) => r.verb === 'show' && r.userId === 'f1')
    ).toBe(false);
    expect(m.players.find((p) => p.userId === 'f1')?.privateHole?.length).toBe(2);
    // A mucked hand at showdown draws the viewer's own cards, marked private.
    const mucked = buildReplay({
      ...FOLD_THEN_SHOW,
      holeCards: { w: ['9h', '9s'] },
      showdown: [
        { user_id: 'w', seat: 3, mucked: false, reveal_order: 0, hand_name: 'Two Pair' },
        { user_id: 's', seat: 4, mucked: true, reveal_order: 1 },
      ],
      privateHoleCards: { s: ['Th', 'Jh'] },
    } as never);
    const sRow = mucked.showdown.find((r) => r.userId === 's' && !r.low)!;
    expect(sRow.holePrivate).toBe(true);
    expect(sRow.hole?.length).toBe(2);
  });
});

describe('the record is readable by everyone who played it', () => {
  it('the writer never files a hand under a roster missing a participant', () => {
    const settlement = read('server/src/engine/ServerTableEngineSettlement.ts');
    expect(settlement).toMatch(
      /\.\.\.snap\.holeCards\.keys\(\),\s*\.\.\.snap\.winners\.map\(\(w\) => w\.userId\)/
    );
    expect(settlement).toContain('[hand_history] roster disagreed with the hand');
  });
});
