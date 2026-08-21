/**
 * DOUBLE-BOARD BOMB POT — functional verification (2026-08-20).
 *
 * Drives complete double-board bomb-pot hands through the real HandController:
 * two boards dealt in lockstep, every pot split in integer cents across the
 * boards at showdown, chips conserved to the cent, and the deck-feasibility
 * downgrade for variants that cannot cover two boards.
 *
 * Cards are crypto-random, so assertions are structural (counts, conservation,
 * winner sums), never on which card comes out.
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
    bombPot: { anteMultiplier: 2, doubleBoard: true },
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

describe('DOUBLE-BOARD BOMB POT — dealing', () => {
  it('deals two full boards in lockstep and reports doubleBoard in the trigger', () => {
    const h = harness(mkConfig(), mkPlayers([200, 200, 200, 200]));
    h.hc.start();

    const trigger = h.events.find((e) => e.type === 'BOMB_POT_TRIGGERED') as any;
    expect(trigger).toBeTruthy();
    expect(trigger.doubleBoard).toBe(true);
    expect(trigger.postings).toHaveLength(4);
    expect(trigger.postings.every((p: any) => p.amount === 4)).toBe(true); // 2 x BB

    // Bomb pot opens on the flop: both boards have 3 cards
    expect(h.st().stage).toBe('flop');
    expect(h.st().communityCards).toHaveLength(3);
    expect(h.st().communityCards2).toHaveLength(3);

    checkDown(h);
    expect(h.st().communityCards).toHaveLength(5);
    expect(h.st().communityCards2).toHaveLength(5);

    // Every COMMUNITY_CARDS emit carried a matching cards2
    const ccEvents = h.events.filter((e) => e.type === 'COMMUNITY_CARDS') as any[];
    expect(ccEvents.length).toBeGreaterThanOrEqual(3);
    for (const ev of ccEvents) expect(ev.cards2?.length).toBe(ev.cards.length);

    // No card is shared between the two boards, and no duplicates anywhere
    const all = [...h.st().communityCards, ...h.st().communityCards2].map(
      (c: any) => `${c.rank}${c.suit}`
    );
    expect(new Set(all).size).toBe(10);
  });

  it('conserves chips exactly and splits the pot across both boards', () => {
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

    // Showdown carried a board-2 evaluation for every shown hand
    const showdown = h.events.find((e) => e.type === 'SHOWDOWN') as any;
    expect(showdown).toBeTruthy();
    for (const r of showdown.results) expect(r.hand2).toBeTruthy();

    // The bomb-pot completion beat fired after HAND_COMPLETE
    const types = h.events.map((e) => e.type);
    expect(types.indexOf('BOMB_POT_COMPLETED')).toBeGreaterThan(types.indexOf('HAND_COMPLETE'));
  });

  it('conserves chips across 300 randomized double-board hands', () => {
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
    }
  });
});

describe('DOUBLE-BOARD BOMB POT — deck feasibility downgrade', () => {
  it('9-handed PLO5 (45 hole cards) downgrades to a single board', () => {
    const h = harness(
      mkConfig({ gameVariant: 'plo5' }),
      mkPlayers([200, 200, 200, 200, 200, 200, 200, 200, 200])
    );
    h.hc.start();

    const trigger = h.events.find((e) => e.type === 'BOMB_POT_TRIGGERED') as any;
    expect(trigger.doubleBoard).toBe(false);
    expect(h.hc.isDoubleBoardActive()).toBe(false);
    expect(h.st().communityCards2).toHaveLength(0);

    checkDown(h);
    expect(h.st().communityCards).toHaveLength(5);
    expect(h.st().communityCards2).toHaveLength(0);
  });

  it('single-board bomb pot still works unchanged when doubleBoard is off', () => {
    const h = harness(
      mkConfig({ bombPot: { anteMultiplier: 2 } }),
      mkPlayers([100, 100, 100])
    );
    h.hc.start();
    const trigger = h.events.find((e) => e.type === 'BOMB_POT_TRIGGERED') as any;
    expect(trigger.doubleBoard).toBe(false);
    checkDown(h);
    expect(h.st().communityCards).toHaveLength(5);
    expect(h.st().communityCards2).toHaveLength(0);
    expect(Math.round(h.stacksSum() * 100)).toBe(30000);
  });
});
