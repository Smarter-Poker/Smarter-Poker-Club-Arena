// Invoked only by run-diamond-controlled-play.py with an isolated DB seat snapshot.
import { readFileSync, writeFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
vi.mock('../../server/src/services/errorReporter.js', () => ({ reportError: vi.fn() }));
vi.mock('../../server/src/services/financialAlerts.js', () => ({ raiseFinancialAlert: vi.fn() }));
import { HandController } from '../../server/src/engine/HandController.js';
import type { HandEvent, SeatPlayer } from '../../server/src/types.js';

it('plays the actual shared NLH controller with database-funded occupants', () => {
  const input = process.env.DIAMOND_PLAY_INPUT;
  const output = process.env.DIAMOND_PLAY_OUTPUT;
  if (!input || !output) throw new Error('Use The Isolated Controlled-Play Runner');
  const seats = JSON.parse(readFileSync(input, 'utf8'));
  expect(seats).toHaveLength(2);
  const players: SeatPlayer[] = seats.map((s: any) => ({
    seat: s.seat_number,
    user_id: s.user_id,
    username: 'Isolated Player',
    stack: Number(s.stack),
    bet: 0,
    totalInvested: 0,
    cards: [],
    is_folded: false,
    is_all_in: false,
    is_sitting_out: false,
  }));
  const hc = new HandController(
    {
      asset: 'diamonds',
      tableId: seats[0].table_id,
      handNumber: 1000010,
      gameVariant: 'nlh',
      smallBlind: 1,
      bigBlind: 2,
      rakeConfig: { percent: 0, cap: 0, noFlopNoDrop: true },
    },
    players,
    1
  );
  const events: HandEvent[] = [];
  hc.onEvent((event) => events.push(structuredClone(event)));
  hc.start();
  // Both participants commit real, legal all-in actions. Deck, evaluation and
  // resulting awards are real; no result stack or winner is fabricated.
  for (let i = 0; i < 2; i++) {
    expect(hc.performAction(hc.getState().currentPlayerSeat, 'all_in')).toBe(true);
  }
  hc.continueRunout();
  const state = hc.getState();
  expect(state.stage).toBe('showdown');
  expect(events.filter((e) => e.type === 'HAND_COMPLETE')).toHaveLength(1);
  expect(state.players.reduce((n, p) => n + p.stack, 0)).toBe(200);
  const winners = events.filter((e) => e.type === 'WINNERS').flatMap((e) => e.winners);
  const actions: any[] = [];
  for (const event of events) {
    if (event.type === 'FORCED_BETS_POSTED') {
      for (const p of event.postings)
        actions.push({
          seat: p.seat,
          userId: p.userId,
          action: p.kind,
          amount: p.amount,
          dead: p.dead,
          stage: 'preflop',
        });
    } else if (event.type === 'PLAYER_ACTION')
      actions.push({
        seat: event.seat,
        userId: seats.find((s: any) => s.seat_number === event.seat).user_id,
        action: event.action,
        amount: event.amount,
        stage: event.stage,
      });
  }
  const returns = Object.fromEntries(
    events.filter((e) => e.type === 'UNCALLED_BET_RETURNED').map((e) => [e.userId, e.amount])
  );
  const stacks = seats.map((s: any) => ({
    user_id: s.user_id,
    seat_id: s.id,
    seat_joined_at: s.joined_at,
    stack_before: Number(s.stack),
    stack: state.players.find((p) => p.user_id === s.user_id)!.stack,
  }));
  const handRow = {
    table_id: seats[0].table_id,
    hand_number: 1000010,
    game_variant: 'nlh',
    small_blind: 1,
    big_blind: 2,
    pot_size: winners.reduce((n, w) => n + w.amount, 0),
    rake_amount: 0,
    bbj_amount: 0,
    button_seat: 1,
    source: 'engine',
    community_cards: state.communityCards.map((c) => c.rank + c.suit[0]),
    players: state.players.map((p) => ({
      userId: p.user_id,
      seat: p.seat,
      stack: p.stack,
    })),
    winners,
    actions,
    _accepted_post_commit_facts: {
      contributions: Object.fromEntries(state.players.map((p) => [p.user_id, p.totalInvested])),
      returned_uncalled: returns,
      insurance: [],
    },
  };
  writeFileSync(output, JSON.stringify({ stacks, handRow, events }));
});
