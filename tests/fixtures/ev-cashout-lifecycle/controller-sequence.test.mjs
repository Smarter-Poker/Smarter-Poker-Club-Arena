import assert from 'node:assert/strict';
import { test } from 'node:test';
// This process never has production configuration or database access.
process.env.SUPABASE_URL = 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'isolated-no-network';
process.env.VITEST = '1';
const { HandController } = await import('../../../server/dist/engine/HandController.js');
const { Deck } = await import('../../../server/dist/engine/PokerEngine.js');
const { channelHub } = await import('../../../server/dist/hub/ChannelHub.js');
test('actual EV deck and passive actions reach the all-in turn; owned hub closes', () => {
  try {
    const card = (t) => ({
      rank: t[0],
      suit: { s: 'spades', h: 'hearts', d: 'diamonds', c: 'clubs' }[t[1]],
    });
    const holes = [
      ['As', 'Ah'],
      ['7c', '8c'],
    ].map((x) => x.map(card));
    const board = ['Ac', 'Kc', '2d', '9h', '3c'].map(card);
    const known = new Set([...holes.flat(), ...board].map((c) => `${c.rank}:${c.suit}`));
    const rest = [];
    for (const suit of ['spades', 'hearts', 'diamonds', 'clubs'])
      for (const rank of ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'])
        if (!known.has(`${rank}:${suit}`)) rest.push({ rank, suit });
    const original = Deck.prototype.shuffle;
    let controller;
    try {
      Deck.prototype.shuffle = function () {
        this.cards = structuredClone([...holes.flat(), ...board, ...rest]);
      };
      controller = new HandController(
        {
          tableId: 'isolated-sequence',
          handNumber: 1000901,
          gameVariant: 'nlh',
          smallBlind: 1,
          bigBlind: 2,
          asset: 'chips',
        },
        [1, 2].map((i) => ({
          user_id: `actor${i}`,
          seat: i,
          username: `Actor ${i}`,
          stack: 150,
          bet: 0,
          totalInvested: 0,
          cards: [],
          is_folded: false,
          is_all_in: false,
          is_sitting_out: false,
        })),
        1
      );
    } finally {
      Deck.prototype.shuffle = original;
    }
    const events = [];
    controller.onEvent((e) => events.push(e.type));
    controller.start();
    assert.deepEqual(
      controller.getState().players.map((p) => p.cards),
      holes
    );
    let actions = 0;
    while (controller.getState().stage !== 'turn') {
      assert.ok(++actions <= 8);
      const state = controller.getState(),
        player = state.players.find((p) => p.seat === state.currentPlayerSeat);
      assert.ok(player);
      assert.equal(
        controller.performAction(player.seat, state.currentBet > player.bet ? 'call' : 'check'),
        true
      );
    }
    assert.equal(actions, 4);
    for (let i = 0; i < 2; i++)
      assert.equal(
        controller.performAction(controller.getState().currentPlayerSeat, 'all_in'),
        true
      );
    assert.ok(events.includes('ALL_IN_RUNOUT'));
  } finally {
    channelHub.close();
  }
});

test('real structured insurance worker prices the actor board and shuts down', async () => {
  const { startEquityWorkerPool, getEquityPool, stopEquityWorkerPool } =
    await import('../../../server/dist/engine/equity/EquityWorkerPool.js');
  const card = (t) => ({
    rank: t[0],
    suit: { s: 'spades', h: 'hearts', d: 'diamonds', c: 'clubs' }[t[1]],
  });
  try {
    const status = await startEquityWorkerPool();
    assert.equal(status.acceptingWork, true);
    const result = await getEquityPool().estimateInsurance(
      [
        ['As', 'Ah'],
        ['7c', '8c'],
      ].map((xs) => xs.map(card)),
      ['Ac', 'Kc', '2d', '9h'].map(card),
      'nlh',
      false
    );
    assert.equal(result.length, 2);
    assert.equal(result[0].exact, true);
    assert.ok(result[0].equity > 50 && result[0].strictLossPct > 0);
  } finally {
    await stopEquityWorkerPool();
  }
});
