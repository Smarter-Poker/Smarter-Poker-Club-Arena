import { it, expect } from 'vitest';
import { HorseMind } from './HorseMind.js';
import f from './fixtures/horse-plo5-small-flush-45855223.json';
import type { SeatPlayer, ActionRecord } from '../types.js';
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
  const history = f.actions.slice(3, ordinal).map(({ publicNode, ...a }) => a) as ActionRecord[];
  return { players, history, pot: n.pot };
}
it('reconstructs actual live-style missing-post history at all three river decisions', () => {
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
  const players = s.players.map((p, i) =>
    i === 0 ? { ...p, returnedUncalled: 0.5, totalInvested: p.totalInvested - 0.5 } : p
  );
  expect(HorseMind.initialPublicMoney(players, s.history, s.pot - 0.5)).toBeNull();
});
