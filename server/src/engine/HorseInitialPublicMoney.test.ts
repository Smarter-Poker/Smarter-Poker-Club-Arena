import { it, expect } from 'vitest';
import { HorseMind } from './HorseMind.js';
import { HandController } from './HandController.js';
import f from './fixtures/horse-plo5-small-flush-45855223.json';
import type { SeatPlayer, ActionRecord, HandConfig } from '../types.js';
import type { OppPostflopRead } from './HorseEval.js';
function snapshot(ordinal: number) {
  const n = f.actions[ordinal].publicNode!;
  const ids = new Map(f.actions.map((a) => [a.seat, a.userId]));
  const players = n.seats.map(([seat, stack, bet, totalInvested, deadInvested]) => ({
    seat,
    user_id: ids.get(seat)!,
    username: `Seat ${seat}`,
    is_folded: false,
    is_all_in: false,
    is_sitting_out: false,
    stack,
    bet,
    totalInvested,
    deadInvested,
    cards: [],
  })) as SeatPlayer[];
  const history = f.actions.slice(3, ordinal) as ActionRecord[];
  return { players, history, pot: n.pot };
}
it('reconstructs captured initial posts and mixed controller amounts at all three river decisions', () => {
  for (const ordinal of [19, 21, 22]) {
    const s = snapshot(ordinal);
    const money = HorseMind.initialPublicMoney(s.players, s.history, s.pot)!;
    expect(money.pot).toBe(5);
    expect(money.streetBets.find(([uid]) => uid === f.actions[0].userId)![1]).toBe(1);
    expect(money.streetBets.find(([uid]) => uid === f.actions[1].userId)![1]).toBe(2);
  }
});
it('feeds exact reconstructed public money through opponent range reads', () => {
  const s = snapshot(21);
  const money = HorseMind.initialPublicMoney(s.players, s.history, s.pot)!;
  const reads: Array<OppPostflopRead | null> = [];
  HorseMind.reset();
  HorseMind.bandsForOpponents(5, s.players, s.history, 2, true, null, reads, money);
  const out: OppPostflopRead = { aggrW: 0, checked: 0 };
  HorseMind.bandFor(f.actions[20].userId, s.history, 2, true, null, out, money);
  expect(out.lastFrac).toBeCloseTo(181.75 / 428);
  expect(out.raised).toBe(true);
});
it('fails closed on inconsistent, partial, duplicate and non-cent ledgers', () => {
  const s = snapshot(21);
  expect(HorseMind.initialPublicMoney(s.players, s.history, s.pot + 1)).toBeNull();
  expect(HorseMind.initialPublicMoney(s.players, s.history.slice(1), s.pot)).not.toBeNull(); // cannot infer missing paid actions solely from conservation
  const unknown = [
    ...s.history,
    { ...s.history[0], userId: 'not-seated', amount: 1, action: 'call' },
  ] as ActionRecord[];
  expect(HorseMind.initialPublicMoney(s.players, unknown, s.pot)).toBeNull();
  expect(HorseMind.initialPublicMoney([...s.players, s.players[0]], s.history, s.pot)).toBeNull();
  expect(
    HorseMind.initialPublicMoney(
      s.players,
      [...s.history, { ...s.history[0], action: 'call', amount: 0.001 }] as ActionRecord[],
      s.pot
    )
  ).toBeNull();
});

it('refuses unknown chip movements instead of absorbing a returned bet into postings', () => {
  const s = snapshot(21);
  for (const action of ['return', 'uncalled', 'refund']) {
    const history = [
      ...s.history,
      { ...s.history[0], action, amount: 0 },
    ] as unknown as ActionRecord[];
    expect(HorseMind.initialPublicMoney(s.players, history, s.pot)).toBeNull();
  }
});

it('does not reinterpret a returned uncalled bet as smaller forced money', () => {
  const s = snapshot(21);
  for (const returnedUncalled of [NaN, Infinity, -1, 0.001]) {
    const invalid = s.players.map((p, i) => (i === 0 ? { ...p, returnedUncalled } : p));
    expect(HorseMind.initialPublicMoney(invalid, s.history, s.pot)).toBeNull();
  }
  const zero = s.players.map((p) => ({ ...p, returnedUncalled: 0 }));
  expect(HorseMind.initialPublicMoney(zero, s.history, s.pot)).toEqual(
    HorseMind.initialPublicMoney(s.players, s.history, s.pot)
  );
  const players = s.players.map((p, i) =>
    i === 0 ? { ...p, returnedUncalled: 0.5, totalInvested: p.totalInvested - 0.5 } : p
  );
  expect(HorseMind.initialPublicMoney(players, s.history, s.pot - 0.5)).toBeNull();
});

it('retains exact initial blind/ante money when the small blind raises to a street total', () => {
  const config: HandConfig = {
    tableId: 'money-abi',
    handNumber: 1,
    gameVariant: 'nlh',
    smallBlind: 1,
    bigBlind: 2,
    ante: 2,
    bigBlindAnte: true,
    rakeConfig: { percent: 0, cap: 0, noFlopNoDrop: true },
  };
  const players = [1, 2, 3].map((seat) => ({
    seat,
    user_id: `u${seat}`,
    username: `Seat ${seat}`,
    stack: 100,
    bet: 0,
    totalInvested: 0,
    cards: [],
    is_folded: false,
    is_all_in: false,
    is_sitting_out: false,
  })) as SeatPlayer[];
  const controller = new HandController(config, players, 1);
  controller.start();
  expect(controller.performAction(1, 'call')).toBe(true);
  expect(controller.performAction(2, 'raise', 6)).toBe(true);
  expect(controller.performAction(3, 'call')).toBe(true);
  const state = controller.getState();
  expect(state.actionHistory[1]).toMatchObject({ action: 'raise', amount: 6 });
  expect(state.actionHistory[1].publicNode).toMatchObject({ status: 'captured' });
  const money = HorseMind.initialPublicMoney(state.players, state.actionHistory, state.pot)!;
  expect(money.pot).toBe(5);
  expect(new Map(money.streetBets)).toEqual(
    new Map([
      ['u1', 0],
      ['u2', 1],
      ['u3', 2],
    ])
  );
  const absent = state.actionHistory.map(({ publicNode, ...action }) => action);
  expect(HorseMind.initialPublicMoney(state.players, absent, state.pot)).toBeNull();
});

it('retains actual bomb-pot forced antes without inventing street wagers', () => {
  const config: HandConfig = {
    tableId: 'bomb-money-abi',
    handNumber: 1,
    gameVariant: 'plo5',
    smallBlind: 1,
    bigBlind: 2,
    bombPot: { anteMultiplier: 3, boardCount: 1 },
    rakeConfig: { percent: 0, cap: 0, noFlopNoDrop: true },
  };
  const players = [1, 2, 3, 4, 5, 6].map((seat) => ({
    seat,
    user_id: `bomb${seat}`,
    username: `Seat ${seat}`,
    stack: 100,
    bet: 0,
    totalInvested: 0,
    cards: [],
    is_folded: false,
    is_all_in: false,
    is_sitting_out: false,
  })) as SeatPlayer[];
  const controller = new HandController(config, players, 1);
  controller.start();
  let state = controller.getState();
  expect(state.stage).toBe('flop');
  expect(controller.performAction(state.currentPlayerSeat!, 'check')).toBe(true);
  state = controller.getState();
  expect(state.actionHistory[0].publicNode).toMatchObject({
    status: 'captured',
    street: 'flop',
    bombPot: true,
    pot: 36,
  });
  expect(HorseMind.initialPublicMoney(state.players, state.actionHistory, state.pot)).toEqual({
    pot: 36,
    streetBets: players.map((p) => [p.user_id, 0]),
  });
  for (const stage of ['flop', 'turn'] as const) {
    const history = state.actionHistory.map((a) => ({
      ...a,
      stage,
      publicNode:
        a.publicNode?.status === 'captured'
          ? { ...a.publicNode, street: stage, bombPot: false }
          : a.publicNode,
    }));
    expect(HorseMind.initialPublicMoney(state.players, history, state.pot)).toBeNull();
  }
});

it('retains actual per-player antes separately from initial live blinds', () => {
  const config: HandConfig = {
    tableId: 'ante-money-abi',
    handNumber: 1,
    gameVariant: 'nlh',
    smallBlind: 1,
    bigBlind: 2,
    ante: 2,
    rakeConfig: { percent: 0, cap: 0, noFlopNoDrop: true },
  };
  const players = [1, 2, 3].map((seat) => ({
    seat,
    user_id: `ante${seat}`,
    username: `Seat ${seat}`,
    stack: 100,
    bet: 0,
    totalInvested: 0,
    cards: [],
    is_folded: false,
    is_all_in: false,
    is_sitting_out: false,
  })) as SeatPlayer[];
  const controller = new HandController(config, players, 1);
  controller.start();
  expect(controller.performAction(1, 'call')).toBe(true);
  const state = controller.getState();
  const money = HorseMind.initialPublicMoney(state.players, state.actionHistory, state.pot);
  expect(money).toEqual({
    pot: 9,
    streetBets: [
      ['ante1', 0],
      ['ante2', 1],
      ['ante3', 2],
    ],
  });
});
