/**
 * THE STAGE TRAVELS WITH THE ACTION (2026-09-01).
 *
 * MEASURED on 2026-08-31's horse_hand_reviews: 517 real play actions - 151
 * check, 127 call, 78 fold, 73 bet, 55 all_in, 33 raise - were persisted with
 * stage 'showdown', spread over 30 hands at roughly 17 actions per hand. Whole
 * hands, not stray actions, and every one of those hands had an empty board.
 *
 * hand_history for one of them, 5e969448-bf2d-4e16-a551-660119e7f37a, holds 23
 * actions: the two blinds correct at 'preflop' (they are stamped literally in
 * ServerTableEngineHandEvents) and all 21 subsequent actions at 'showdown'.
 *
 * CAUSE. HandController stamps its own actionHistory with `this.state.stage`
 * synchronously inside performAction, which is always right. The PERSISTED
 * copy was built elsewhere: the PLAYER_ACTION handler read
 * `this.handController.getState().stage` when the event was HANDLED. Since
 * performAction emits and then calls advanceGame(), any drain that lags the
 * advance sees a stage that has already moved - and a whole hand draining
 * after completion sees the stage the hand ENDED on.
 *
 * WHY IT MATTERS. HorseHandReview keys heroPre, postflopActed and every river
 * detector off that field. On those 30 hands postflopActed was true for a hand
 * that never saw a flop, and a preflop shove read as river aggression - so the
 * leak detectors were being fed hands whose streets were fiction.
 *
 * THE PROPERTY, pinned below: the stage is frozen ONTO the event at the
 * instant of the action, so reading it later - after the hand has advanced,
 * after it has finished - still yields the street the action was taken on.
 */
import { describe, it, expect } from 'vitest';
import { HandController } from './HandController.js';
import type { HandConfig, HandEvent, SeatPlayer } from '../types.js';
import { sliceBetween } from '../testHelpers/sourceWindow.js';

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

const mkConfig = (over: Partial<HandConfig> = {}): HandConfig =>
  ({
    tableId: 't1',
    handNumber: 1,
    gameVariant: 'nlh',
    smallBlind: 1,
    bigBlind: 2,
    rakeConfig: { percent: 5, cap: 100, noFlopNoDrop: true },
    ...over,
  }) as HandConfig;

type ActionEvent = Extract<HandEvent, { type: 'PLAYER_ACTION' }>;

function harness(players: SeatPlayer[], dealerSeat = 1) {
  const events: HandEvent[] = [];
  const hc = new HandController(mkConfig(), players, dealerSeat);
  hc.onEvent((e) => events.push(e));
  const st = () => (hc as unknown as { state: any }).state;
  return {
    hc,
    st,
    actions: () => events.filter((e): e is ActionEvent => e.type === 'PLAYER_ACTION'),
    act: (seat: number, action: string, amount = 0) =>
      hc.performAction(seat, action as never, amount),
  };
}

describe('the stage is carried on PLAYER_ACTION, not read from live state', () => {
  it('a heads-up hand played to the river keeps each action on its own street', () => {
    const h = harness(mkPlayers([200, 200]), 1);
    h.hc.start();

    // Preflop: dealer (seat 1) is SB heads-up and acts first.
    h.act(1, 'call');
    h.act(2, 'check');
    expect(h.st().stage).toBe('flop');
    h.act(2, 'check');
    h.act(1, 'check');
    expect(h.st().stage).toBe('turn');
    h.act(2, 'check');
    h.act(1, 'check');
    expect(h.st().stage).toBe('river');
    h.act(2, 'check');
    h.act(1, 'check');

    // THE HAND IS OVER. Everything below reads the events only now - which is
    // exactly the late drain that produced the corruption.
    const acted = h.actions();
    expect(acted.length).toBeGreaterThanOrEqual(8);
    const stages = acted.map((e) => e.stage);
    expect(stages.every((s) => s !== undefined)).toBe(true);
    // The first two actions were taken preflop and must still say so.
    expect(stages.slice(0, 2)).toEqual(['preflop', 'preflop']);
    expect(stages.slice(2, 4)).toEqual(['flop', 'flop']);
    expect(stages.slice(4, 6)).toEqual(['turn', 'turn']);
    expect(stages.slice(6, 8)).toEqual(['river', 'river']);
    // And the bug's signature is absent: nothing is stamped with the terminal
    // stage just because the hand reached it.
    expect(stages).not.toContain('showdown');
  });

  it('a hand that ends preflop never stamps a play action showdown', () => {
    // The exact shape of the 30 corrupted hands: no board, hand resolves, and
    // every action must still read 'preflop'.
    const h = harness(mkPlayers([200, 200, 200]), 1);
    h.hc.start();
    // dealer=1 -> SB=2, BB=3, first to act is seat 1.
    h.act(1, 'fold');
    h.act(2, 'fold');

    const acted = h.actions();
    expect(acted.length).toBeGreaterThanOrEqual(2);
    expect(h.st().communityCards.length).toBe(0);
    for (const e of acted) {
      expect(e.stage, `${e.action} on seat ${e.seat} must stay preflop`).toBe('preflop');
    }
  });

  it("the event's stage agrees with the controller's own actionHistory", () => {
    // The two records are written from the same value at the same instant, so
    // they can never disagree. That is the whole fix: agreement by
    // construction rather than by how promptly a listener happens to run.
    const h = harness(mkPlayers([200, 200]), 1);
    h.hc.start();
    h.act(1, 'call');
    h.act(2, 'check');
    h.act(2, 'bet', 4);
    h.act(1, 'fold');

    const fromEvents = h.actions().map((e) => `${e.seat}:${e.action}:${e.stage}`);
    const fromHistory = h
      .st()
      .actionHistory.filter((a: { action: string }) => !['sb', 'bb', 'ante'].includes(a.action))
      .map(
        (a: { seat: number; action: string; stage: string }) => `${a.seat}:${a.action}:${a.stage}`
      );
    expect(fromEvents).toEqual(fromHistory);
  });
});

describe('the consumer prefers the event over live state', () => {
  it('ServerTableEngineHandEvents reads event.stage first', () => {
    // Source-level: building a full ServerTableEngine to assert one field
    // would need a table, a hub and a database. The property is a single
    // expression and worth pinning literally, because reverting it silently
    // reintroduces the corruption with no test anywhere else to catch it.
    const src = require('node:fs').readFileSync(
      require('node:path').join(__dirname, 'ServerTableEngineHandEvents.ts'),
      'utf8'
    );
    // Bounded by the NEXT case in the same switch, not by 4000 bytes. The
    // negative assertion below is why it matters: a fixed forward window can
    // run out of this case and into another one, and then it either matches
    // something that is not this branch or drifts off the code entirely and
    // passes while watching nothing.
    const body = sliceBetween(src, "case 'PLAYER_ACTION':", "case 'COMMUNITY_CARDS':").replace(
      /\/\*[\s\S]*?\*\//g,
      ''
    );
    expect(body.length).toBeGreaterThan(0);
    expect(body).toContain('event.stage ??');
    // The bare live-state read must not be what feeds the persisted record.
    expect(body).not.toMatch(/const stage = hcState\?\.stage \|\| 'preflop';/);
  });
});
