import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { HorseLogic } from './HorseLogic.js';
import { HorseMind, readScopeOf } from './HorseMind.js';
import { riverTripleCheckRaiseIncrements } from './HorseRiverPositionRead.js';
import { encodeHorseDecisionReads, decodeHorseDecisionReads } from './HorseDecisionReadFrame.js';
import { freshExploitCounters } from './HorseOpponentExploit.js';
import { seedFastRandom } from './HorseEval.js';
import { ploPairedBoardMustFold } from './HorsePloPairedBoardFold.js';
import { HandController } from './HandController.js';
import { Deck } from './PokerEngine.js';
import { controllerDecisionState } from './remainingVariants/RemainingVariantControllerSpots.test-support.js';
import type { RemainingPolicyVariant } from './remainingVariants/RemainingVariantPolicyPack.js';
import type { Card, SeatPlayer, HandConfig, ActionRecord } from '../types.js';
const c = (rank: string, suit: string) => ({ rank, suit }) as Card;
const a = (userId: string, action: string, amount = 0) => ({
  userId,
  action,
  amount,
  stage: 'river',
});
const line = (response = 'fold') => [
  a('hero', 'check'),
  a('wide', 'bet', 10),
  a('hero', 'raise', 30),
  a('wide', response, response === 'fold' ? 0 : 20),
];
afterEach(() => HorseMind.reset());
function reads(variant: string) {
  const sandbox = HorseMind.createSandbox(),
    scope = readScopeOf(variant, 2);
  HorseMind.runInSandbox(sandbox, () => {
    HorseMind.setDecisionScope(scope, variant, 'cash');
    for (let h = 1; h <= 100; h++) {
      const actions = line().map((x, i) => ({
        ...x,
        seat: x.userId === 'hero' ? 2 : 1,
        timestamp: 1793000000000 + h * 1000 + i,
      })) as ActionRecord[];
      const identity = {
        version: 1 as const,
        tableId: '11111111-1111-4111-8111-111111111111',
        handNumber: 1000000 + h,
      };
      HorseMind.observe(actions, [], identity, 2);
      HorseMind.observe(actions, [], identity, 2);
    }
  });
  sandbox.exploit.set(scope + '|wide', {
    ...freshExploitCounters(),
    hands: 1000,
    vpip: 999,
    betCheckedToOpp: 1000,
    betCheckedTo: 200,
  });
  return sandbox;
}
describe('Same-size public check-raise response read', () => {
  it('counts folds and defenses only after the exact response arrives', () => {
    expect([...riverTripleCheckRaiseIncrements(line(), 2)]).toEqual([
      ['wide', { opportunities: 1, folds: 1 }],
    ]);
    expect([...riverTripleCheckRaiseIncrements(line('call'), 2)]).toEqual([
      ['wide', { opportunities: 1, folds: 0 }],
    ]);
    const reraised = line('raise');
    reraised[3].amount = 70;
    for (const answer of ['fold', 'call', 'all_in'])
      expect([
        ...riverTripleCheckRaiseIncrements(
          [...reraised, a('hero', answer, answer === 'fold' ? 0 : 40)],
          2
        ),
      ]).toEqual([['wide', { opportunities: 1, folds: 0 }]]);
    expect(riverTripleCheckRaiseIncrements(line().slice(0, 3), 2).size).toBe(0);
    const malformed = line();
    malformed[2].amount = Number.NaN;
    expect(riverTripleCheckRaiseIncrements(malformed, 2).size).toBe(0);
    expect(
      riverTripleCheckRaiseIncrements(
        line().map((x, i) => (i === 2 ? { ...x, amount: '30' } : x)),
        2
      ).size
    ).toBe(0);
    expect(riverTripleCheckRaiseIncrements([a('hero', 'bet', 10), a('wide', 'fold')], 2).size).toBe(
      0
    );
    const otherSize = line();
    otherSize[2].amount = 25;
    expect(riverTripleCheckRaiseIncrements(otherSize, 2).size).toBe(0);
    expect(riverTripleCheckRaiseIncrements(line(), 3).size).toBe(0);
    const allIn = line();
    allIn[1].action = 'all_in';
    expect(riverTripleCheckRaiseIncrements(allIn, 2).size).toBe(0);
  });
  it('dedupes completed history and transports v8 without redefining v7', () => {
    const sandbox = reads('plo5'),
      players = [{ user_id: 'hero' }, { user_id: 'wide' }] as SeatPlayer[];
    const view = HorseMind.runInSandbox(sandbox, () =>
      HorseMind.snapshotDecisionReads(players, null)
    );
    const frame = encodeHorseDecisionReads(view, players, null);
    expect(frame.version).toBe('horse-decision-reads-v8');
    const forged = JSON.parse(frame.json);
    forged.riverCalls.find((r: [string, number[]]) => r[0] === 'wide')[1][5] = 101;
    const json = JSON.stringify(forged);
    expect(() =>
      decodeHorseDecisionReads(
        {
          ...frame,
          json,
          bytes: Buffer.byteLength(json),
          sha256: createHash('sha256').update(json).digest('hex'),
        },
        players,
        null
      )
    ).toThrow();
    const restored = decodeHorseDecisionReads(frame, players, null);
    HorseMind.runInSandbox(restored, () => {
      HorseMind.setDecisionScope(readScopeOf('plo5', 2), 'plo5', 'cash');
      expect(HorseMind.riverTripleCheckRaiseRead('wide')).toMatchObject({
        opportunities: 100,
        folds: 100,
      });
    });
    for (const map of [view.stats, view.scoped])
      for (const row of map.values()) {
        row.riverTripleCheckRaiseOpps = 0;
        row.riverTripleCheckRaiseFolds = 0;
      }
    const v7 = encodeHorseDecisionReads(view, players, null);
    expect(v7.version).toBe('horse-decision-reads-v7');
    expect(
      encodeHorseDecisionReads(decodeHorseDecisionReads(v7, players, null), players, null)
    ).toEqual(v7);
  });
});
function spot(variant: string, paired = false) {
  const hole = paired
    ? [
        c('J', 'diamonds'),
        c('A', 'clubs'),
        c('4', 'hearts'),
        c('5', 'spades'),
        ...(variant === 'plo5' || variant === 'plo6' ? [c('3', 'clubs')] : []),
        ...(variant === 'plo6' ? [c('8', 'spades')] : []),
      ]
    : [
        c('A', 'diamonds'),
        c('4', 'clubs'),
        ...(variant === 'nlh' ? [] : [c('5', 'hearts'), c('6', 'spades')]),
        ...(variant === 'plo5' || variant === 'plo6' ? [c('3', 'clubs')] : []),
        ...(variant === 'plo6' ? [c('8', 'spades')] : []),
      ];
  const board = paired
    ? [c('J', 'clubs'), c('J', 'hearts'), c('9', 'spades'), c('6', 'diamonds'), c('2', 'hearts')]
    : [
        c('K', 'diamonds'),
        c('Q', 'diamonds'),
        c('7', 'diamonds'),
        c('2', 'clubs'),
        c('9', 'hearts'),
      ];
  const key = (x: Card) => x.rank + ':' + x.suit,
    known = new Set([...hole, ...board].map(key)),
    shuffle = Deck.prototype.shuffle;
  Deck.prototype.shuffle = function () {
    const d = this as unknown as { cards: Card[] };
    const spare = d.cards.filter((x) => !known.has(key(x)));
    d.cards = [...spare.slice(0, hole.length), ...hole, ...board, ...spare.slice(hole.length)];
  };
  const player = (seat: number, id: string) =>
    ({
      seat,
      user_id: id,
      username: id,
      stack: paired && id === 'hero' ? 35 : 400,
      bet: 0,
      totalInvested: 0,
      cards: [],
      is_folded: false,
      is_all_in: false,
      is_sitting_out: false,
      is_horse: id === 'hero',
    }) as SeatPlayer;
  const config = {
    tableId: '40000000-0000-4000-8000-0000000000ab',
    handNumber: 1000101,
    gameVariant: variant,
    smallBlind: 1,
    bigBlind: 2,
    ante: 0,
    isTournament: false,
    rakeConfig: { percent: 5, cap: 6, noFlopNoDrop: true },
  } as HandConfig;
  let controller: HandController;
  let complete: { rake?: number; bbjFee?: number } | null = null;
  try {
    controller = new HandController(config, [player(1, 'wide'), player(2, 'hero')], 1);
    controller.onEvent((e) => {
      if (e.type === 'HAND_COMPLETE') complete = e;
    });
    controller.start();
  } finally {
    Deck.prototype.shuffle = shuffle;
  }
  expect(controller.performAction(1, 'raise', 6)).toBe(true);
  expect(controller.performAction(2, 'call')).toBe(true);
  for (let street = 0; street < 2; street++) {
    expect(controller.performAction(2, 'check')).toBe(true);
    expect(controller.performAction(1, 'check')).toBe(true);
  }
  expect(controller.performAction(2, 'check')).toBe(true);
  expect(controller.performAction(1, 'bet', paired ? 8 : 10)).toBe(true);
  const captured = controllerDecisionState(
    controller,
    variant as RemainingPolicyVariant,
    'cash',
    config
  )!;
  expect(captured.hero.user_id).toBe('hero');
  expect(captured.state.stage).toBe('river');
  return { ...captured, controller, getComplete: () => complete };
}
describe('River bluff check-raise is executable in the real controller', () => {
  it.each(['nlh', 'plo4', 'plo5', 'plo6'])(
    '%s prices a permitted raise and preserves chip conservation',
    (variant) => {
      const { hero, state, controller, getComplete } = spot(variant),
        sandbox = reads(variant);
      const decision = HorseMind.runInSandbox(sandbox, () => {
        HorseMind.setDecisionScope(readScopeOf(variant, 2), variant, 'cash');
        return HorseLogic.__testables.riverBluffCheckRaise(
          { action: 'fold', thinkTime: 0 },
          hero,
          state,
          { riverBluffCheckRaise: true }
        );
      });
      expect(decision.action).toBe('raise');
      expect(decision.amount).toBe(30);
      expect(controller.performAction(hero.seat, decision.action, decision.amount)).toBe(true);
      expect(controller.performAction(1, 'fold')).toBe(true);
      const done = getComplete();
      expect(done).not.toBeNull();
      expect(
        controller.getState().players.reduce((sum, p) => sum + p.stack, 0) +
          (done?.rake ?? 0) +
          (done?.bbjFee ?? 0)
      ).toBeCloseTo(800, 6);
    }
  );
  it.each(['nlh', 'plo4', 'plo5', 'plo6'])(
    '%s reaches the signed wager owner from the complete brain',
    (variant) => {
      let changed = 0;
      for (let seed = 1; seed <= 12; seed++) {
        const { hero, state, controller } = spot(variant);
        const decide = (on: boolean) => {
          seedFastRandom(seed);
          return HorseMind.runInSandbox(reads(variant), () =>
            HorseLogic.decide(
              hero,
              state,
              'balanced',
              {},
              { observeMind: false, decisionTimeMs: 1793001000000, riverBluffCheckRaise: on }
            )
          );
        };
        const off = decide(false),
          on = decide(true);
        if (off.action === 'fold' && on.action === 'raise') {
          changed++;
          expect(on.amount).toBe(30);
          expect(on.policyGraph).toBeDefined();
          expect(controller.performAction(hero.seat, on.action, on.amount)).toBe(true);
        }
      }
      expect(changed).toBeGreaterThan(0);
    }
  );
  it.each(['plo4', 'plo5', 'plo6'])(
    '%s keeps paired-board call-off protection while admitting a priced bluff raise',
    (variant) => {
      const { hero, state, controller, getComplete } = spot(variant, true);
      expect(
        ploPairedBoardMustFold({
          gameVariant: variant,
          hiLo: false,
          multiBoard: false,
          board: state.communityCards,
          hero,
          players: state.players,
          currentBet: state.currentBet,
          toCall: state.toCall,
          pot: state.pot,
        })
      ).toBe(true);
      const decide = (on: boolean) => {
        seedFastRandom(1);
        return HorseMind.runInSandbox(reads(variant), () =>
          HorseLogic.decide(
            hero,
            state,
            'balanced',
            {},
            { observeMind: false, decisionTimeMs: 1793001000000, riverBluffCheckRaise: on }
          )
        );
      };
      expect(decide(false).action).toBe('fold');
      const on = decide(true);
      expect(on.action).toBe('raise');
      expect(on.amount).toBe(24);
      expect(on.policyGraph).toBeDefined();
      expect(controller.performAction(hero.seat, on.action, on.amount)).toBe(true);
      expect(controller.performAction(1, 'fold')).toBe(true);
      const done = getComplete();
      expect(done).not.toBeNull();
      expect(
        controller.getState().players.reduce((sum, p) => sum + p.stack, 0) +
          (done?.rake ?? 0) +
          (done?.bbjFee ?? 0)
      ).toBeCloseTo(435, 6);
    }
  );
  it('retains the reference for ordinary bet folds, unknown fees, committed bettors and calls', () => {
    const { hero, state } = spot('plo5'),
      sandbox = reads('plo5'),
      original = { action: 'fold' as const, thinkTime: 0 };
    HorseMind.runInSandbox(sandbox, () => {
      HorseMind.setDecisionScope(readScopeOf('plo5', 2), 'plo5', 'cash');
      const run = (gs = state) =>
        HorseLogic.__testables.riverBluffCheckRaise(original, hero, gs, {
          riverBluffCheckRaise: true,
        });
      expect(run({ ...state, rakeConfig: undefined })).toEqual(original);
      // Preserve the exact 3x read: a near-pot target would be rounded by the owner rule.
      const nearPot = {
        ...state,
        pot: 11,
        players: state.players.map((p) => ({
          ...p,
          totalInvested: p.user_id === 'hero' ? 0.5 : 10.5,
        })),
      };
      expect(run(nearPot)).toEqual(original);
      expect(run({ ...state, maxRaiseTo: 29 })).toEqual(original);
      expect(
        run({
          ...state,
          players: state.players.map((p) => (p.user_id === 'wide' ? { ...p, is_all_in: true } : p)),
        })
      ).toEqual(original);
      expect(
        HorseLogic.__testables.riverBluffCheckRaise(
          { action: 'call', amount: 10, thinkTime: 0 },
          hero,
          state,
          { riverBluffCheckRaise: true }
        ).action
      ).toBe('call');
      for (const map of [sandbox.stats, sandbox.scoped])
        for (const row of map.values()) {
          row.riverTripleCheckRaiseOpps = 0;
          row.riverTripleCheckRaiseFolds = 0;
          row.riverBetOpps = 100;
          row.riverBetFolds = 100;
        }
      expect(run()).toEqual(original);
    });
  });
  it('supports physical paired/trips and straight blockers, refuses an unblocked pair', () => {
    const test = HorseLogic.__testables.riverBluffBlocker,
      paired = [
        c('J', 'clubs'),
        c('J', 'hearts'),
        c('9', 'spades'),
        c('6', 'diamonds'),
        c('2', 'hearts'),
      ];
    expect(
      test([c('J', 'diamonds'), c('A', 'clubs'), c('4', 'hearts'), c('5', 'spades')], paired, true)
    ).toBe(true);
    expect(
      test([c('Q', 'diamonds'), c('A', 'clubs'), c('4', 'hearts'), c('5', 'spades')], paired, true)
    ).toBe(false);
    expect(
      test(
        [c('A', 'diamonds'), c('K', 'clubs')],
        [c('J', 'clubs'), c('J', 'hearts'), c('J', 'spades'), c('6', 'diamonds'), c('2', 'hearts')],
        false
      )
    ).toBe(true);
    expect(
      test(
        [c('A', 'diamonds'), c('4', 'clubs')],
        [c('K', 'clubs'), c('Q', 'hearts'), c('J', 'spades'), c('6', 'diamonds'), c('2', 'hearts')],
        false
      )
    ).toBe(true);
  });
});
