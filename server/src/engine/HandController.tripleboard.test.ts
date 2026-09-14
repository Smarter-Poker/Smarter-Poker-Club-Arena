/**
 * TRIPLE-BOARD BOMB POT — functional verification (2026-08-27, Dan's spec
 * §9 / §21).
 *
 * Drives complete triple-board bomb-pot hands through the real HandController:
 * three boards dealt in lockstep, every pot layer split into three integer
 * shares with remainders to the lowest board numbers first, chips conserved to
 * the cent, and the stepwise deck-feasibility downgrade (3 → 2 → 1).
 *
 * Cards are crypto-random, so assertions are structural (counts, conservation,
 * winner sums), never on which card comes out. Companion file:
 * HandController.doubleboard.test.ts pins the two-board behaviour.
 */
import { describe, it, expect } from 'vitest';
import { HandController } from './HandController.js';
import type { HandConfig, HandEvent, SeatPlayer } from '../types.js';

function mkPlayers(stacks: number[]): SeatPlayer[] {
  return stacks.map(
    (stack, i) =>
      ({
        seat: i + 1,
        user_id: `u${i + 1}`,
        username: `P${i + 1}`,
        stack,
        bet: 0,
        totalInvested: 0,
        cards: [],
        is_folded: false,
        is_all_in: false,
        is_sitting_out: false,
      }) as SeatPlayer
  );
}

function mkConfig(over: Partial<HandConfig> = {}): HandConfig {
  return {
    tableId: 't1',
    handNumber: 1,
    gameVariant: 'nlh',
    smallBlind: 1,
    bigBlind: 2,
    rakeConfig: { percent: 0, cap: 0, noFlopNoDrop: true },
    bombPot: { anteMultiplier: 2, boardCount: 3 },
    ...over,
  } as HandConfig;
}

function harness(config: HandConfig, players: SeatPlayer[], dealerSeat = 1) {
  const events: HandEvent[] = [];
  const hc = new HandController(config, players, dealerSeat);
  hc.onEvent((e) => events.push(e));
  const st = () => (hc as unknown as { state: any }).state;
  const cur = () => st().currentPlayerSeat;
  const act = (action: string, amount = 0) => hc.performAction(cur(), action as any, amount);
  const stacksSum = () => st().players.reduce((s: number, p: SeatPlayer) => s + p.stack, 0);
  return { hc, events, st, cur, act, stacksSum };
}

/** Check every live seat through to showdown from the flop. */
function checkDown(h: ReturnType<typeof harness>) {
  let guard = 60;
  while (h.st().stage !== 'showdown' && h.cur() > 0 && guard-- > 0) {
    h.act('check');
  }
}

describe('TRIPLE-BOARD BOMB POT - dealing', () => {
  it('deals three full boards in lockstep and reports boardCount in the trigger', () => {
    const h = harness(mkConfig(), mkPlayers([200, 200, 200, 200]));
    h.hc.start();

    const trigger = h.events.find((e) => e.type === 'BOMB_POT_TRIGGERED') as any;
    expect(trigger).toBeTruthy();
    expect(trigger.boardCount).toBe(3);
    expect(trigger.doubleBoard).toBe(true); // legacy multi-board flag
    expect(trigger.postings).toHaveLength(4);
    expect(trigger.postings.every((p: any) => p.amount === 4)).toBe(true); // 2 x BB

    // Bomb pot opens on the flop: all three boards have 3 cards
    expect(h.st().stage).toBe('flop');
    expect(h.st().communityCards).toHaveLength(3);
    expect(h.st().communityCards2).toHaveLength(3);
    expect(h.st().communityCards3).toHaveLength(3);

    checkDown(h);
    expect(h.st().communityCards).toHaveLength(5);
    expect(h.st().communityCards2).toHaveLength(5);
    expect(h.st().communityCards3).toHaveLength(5);

    // Every COMMUNITY_CARDS emit carried matching cards2 AND cards3
    const ccEvents = h.events.filter((e) => e.type === 'COMMUNITY_CARDS') as any[];
    expect(ccEvents.length).toBeGreaterThanOrEqual(3);
    for (const ev of ccEvents) {
      expect(ev.cards2?.length).toBe(ev.cards.length);
      expect(ev.cards3?.length).toBe(ev.cards.length);
    }

    // No card is shared between the three boards, and no duplicates anywhere
    const all = [
      ...h.st().communityCards,
      ...h.st().communityCards2,
      ...h.st().communityCards3,
    ].map((c: any) => `${c.rank}${c.suit}`);
    expect(new Set(all).size).toBe(15);
  });

  it('records the bomb antes as forced money on the hand record', () => {
    const h = harness(mkConfig(), mkPlayers([200, 200, 200]));
    h.hc.start();
    const forced = h.events.find((e) => (e as any).type === 'FORCED_BETS_POSTED') as any;
    expect(forced).toBeTruthy();
    expect(forced.postings).toHaveLength(3);
    for (const p of forced.postings) {
      expect(p.kind).toBe('bomb_ante');
      expect(p.dead).toBe(true);
      expect(p.amount).toBe(4);
    }
  });

  it('FIXED ante mode overrides the BB multiple (spec §3 anteMode FIXED)', () => {
    const h = harness(
      mkConfig({ bombPot: { anteMultiplier: 2, boardCount: 3, anteFixed: 7 } }),
      mkPlayers([200, 200, 200])
    );
    h.hc.start();
    const trigger = h.events.find((e) => e.type === 'BOMB_POT_TRIGGERED') as any;
    expect(trigger.anteAmount).toBe(7);
    expect(trigger.postings.every((p: any) => p.amount === 7)).toBe(true);
    // POLISH 2026-08-28: fixed mode must not advertise a BB multiple the
    // price was never derived from — zero tells the overlay "fixed amount".
    expect(trigger.bbMultiplier).toBe(0);
  });

  it('conserves chips exactly and splits the pot across three boards', () => {
    const stacks = [200, 200, 200, 200];
    const total = stacks.reduce((a, b) => a + b, 0);
    const h = harness(mkConfig(), mkPlayers(stacks));
    h.hc.start();
    checkDown(h);

    const winnersEvt = h.events.find((e) => e.type === 'WINNERS') as any;
    expect(winnersEvt).toBeTruthy();
    const winnerSum = winnersEvt.winners.reduce((s: number, w: any) => s + w.amount, 0);
    // rake 0 in this config → winners get the whole pot (16 = 4 players x 4)
    expect(Math.round(winnerSum * 100)).toBe(1600);
    expect(Math.round(h.stacksSum() * 100)).toBe(total * 100);

    // Per-board winner labels cover all three boards
    const boards = new Set((winnersEvt.winnersByBoard ?? []).map((w: any) => w.board));
    expect(boards).toEqual(new Set([1, 2, 3]));

    // The per-board shares sum exactly to the pot, remainder to low boards:
    // each pot layer's three shares differ by at most one cent, board 1 first.
    const byBoard: Record<number, number> = { 1: 0, 2: 0, 3: 0 };
    for (const w of winnersEvt.winnersByBoard as Array<{ board: number; amount: number }>) {
      byBoard[w.board] += Math.round(w.amount * 100);
    }
    expect(byBoard[1] + byBoard[2] + byBoard[3]).toBe(1600);
    expect(byBoard[1]).toBeGreaterThanOrEqual(byBoard[2]);
    expect(byBoard[2]).toBeGreaterThanOrEqual(byBoard[3]);

    // THE POT AXIS SURVIVES THE MERGE (2026-09-13): every per-board row says
    // which pot(s) its share came from, and the slices sum to the row.
    for (const w of winnersEvt.winnersByBoard as Array<{
      amount: number;
      pots?: Array<{ index: number; amount: number }>;
    }>) {
      expect(Array.isArray(w.pots) && w.pots.length > 0, 'a row without pot slices').toBe(true);
      const sliced = w.pots!.reduce((s, p) => s + Math.round(p.amount * 100), 0);
      expect(sliced).toBe(Math.round(w.amount * 100));
      for (const p of w.pots!) expect(Number.isInteger(p.index) && p.index >= 0).toBe(true);
    }

    // Showdown carried board-2 and board-3 evaluations for every shown hand
    const showdown = h.events.find((e) => e.type === 'SHOWDOWN') as any;
    expect(showdown).toBeTruthy();
    for (const r of showdown.results) {
      expect(r.hand2).toBeTruthy();
      expect(r.hand3).toBeTruthy();
    }
  });

  it('splits an odd pot with remainders to Board 1 then Board 2 (spec §9.1)', () => {
    // 3 players × 5.00 ante (2.5x BB of 2) = 15.00 → 1500 cents = 500 each:
    // even. Use a fixed ante of 1.01 × 3 players = 3.03 → 101 cents per
    // board share… we assert conservation and monotone share order instead of
    // exact card outcomes (winners vary), which the byBoard checks above
    // already pin. Here: 3 players, ante 3.37 → 10.11 total → 337 cents per
    // player; per-pot split of 1011 cents = 337 / 337 / 337. Make it uneven:
    // ante 3.34 → 1002 cents → 334 / 334 / 334. Choose 3.35 → 1005: still
    // divisible. Use 4 players, ante 0.97 → 388 cents → 130 / 129 / 129.
    const h = harness(
      mkConfig({ bombPot: { anteMultiplier: 2, boardCount: 3, anteFixed: 0.97 } }),
      mkPlayers([50, 50, 50, 50])
    );
    h.hc.start();
    checkDown(h);
    const winnersEvt = h.events.find((e) => e.type === 'WINNERS') as any;
    const byBoard: Record<number, number> = { 1: 0, 2: 0, 3: 0 };
    for (const w of winnersEvt.winnersByBoard as Array<{ board: number; amount: number }>) {
      byBoard[w.board] += Math.round(w.amount * 100);
    }
    expect(byBoard[1]).toBe(130);
    expect(byBoard[2]).toBe(129);
    expect(byBoard[3]).toBe(129);
    expect(Math.round(h.stacksSum() * 100)).toBe(20000 - 388 + 388);
  });

  it('conserves chips across 300 randomized triple-board hands', () => {
    for (let i = 0; i < 300; i++) {
      const n = 2 + (i % 5); // 2..6 players
      const stacks = Array.from({ length: n }, (_, j) => 50 + ((i * 7 + j * 13) % 200));
      const total = stacks.reduce((a, b) => a + b, 0);
      const h = harness(
        mkConfig({ handNumber: i + 1, gameVariant: i % 3 === 0 ? 'plo4' : 'nlh' }),
        mkPlayers(stacks),
        (i % n) + 1
      );
      h.hc.start();
      checkDown(h);
      expect(Math.round(h.stacksSum() * 100)).toBe(total * 100);
      expect(h.st().communityCards2).toHaveLength(5);
      expect(h.st().communityCards3).toHaveLength(5);
    }
  });
});

describe('TRIPLE-BOARD BOMB POT - deck feasibility downgrade (3 → 2 → 1)', () => {
  it('7-handed PLO6 (42 hole cards) downgrades three boards to two', () => {
    // 42 + 15 = 57 > 52, but 42 + 10 = 52 ≤ 52: exactly two boards fit.
    const h = harness(
      mkConfig({ gameVariant: 'plo6' }),
      mkPlayers([200, 200, 200, 200, 200, 200, 200])
    );
    h.hc.start();
    const trigger = h.events.find((e) => e.type === 'BOMB_POT_TRIGGERED') as any;
    expect(trigger.boardCount).toBe(2);
    expect(h.hc.getActiveBoardCount()).toBe(2);
    checkDown(h);
    expect(h.st().communityCards2).toHaveLength(5);
    expect(h.st().communityCards3).toHaveLength(0);
  });

  it('9-handed PLO5 (45 hole cards) downgrades all the way to one board', () => {
    // 45 + 10 = 55 > 52 and 45 + 5 = 50 ≤ 52: only a single board fits.
    const h = harness(
      mkConfig({ gameVariant: 'plo5' }),
      mkPlayers([200, 200, 200, 200, 200, 200, 200, 200, 200])
    );
    h.hc.start();
    const trigger = h.events.find((e) => e.type === 'BOMB_POT_TRIGGERED') as any;
    expect(trigger.boardCount).toBe(1);
    expect(trigger.doubleBoard).toBe(false);
    expect(h.hc.isDoubleBoardActive()).toBe(false);
    checkDown(h);
    expect(h.st().communityCards).toHaveLength(5);
    expect(h.st().communityCards2).toHaveLength(0);
    expect(h.st().communityCards3).toHaveLength(0);
  });

  it('legacy doubleBoard flag still maps to two boards when boardCount is absent', () => {
    const h = harness(
      mkConfig({ bombPot: { anteMultiplier: 2, doubleBoard: true } }),
      mkPlayers([100, 100, 100])
    );
    h.hc.start();
    const trigger = h.events.find((e) => e.type === 'BOMB_POT_TRIGGERED') as any;
    expect(trigger.boardCount).toBe(2);
    checkDown(h);
    expect(h.st().communityCards2).toHaveLength(5);
    expect(h.st().communityCards3).toHaveLength(0);
  });
});
