import { describe, expect, it, vi } from 'vitest';
import { HandController } from './HandController.js';
import { captureHorsePublicActionNode } from './HorsePublicActionNode.js';
import type {
  AuthoritativeActionState,
  GameState,
  HandConfig,
  HandEvent,
  SeatPlayer,
} from '../types.js';

type ActionEvent = Extract<HandEvent, { type: 'PLAYER_ACTION' }>;
function harness(overrides: Partial<HandConfig> = {}, count = 3) {
  const config: HandConfig = {
    tableId: 'public-node',
    handNumber: 1,
    gameVariant: 'nlh',
    smallBlind: 1,
    bigBlind: 2,
    rakeConfig: { percent: 0, cap: 0, noFlopNoDrop: true },
    ...overrides,
  };
  const players: SeatPlayer[] = Array.from({ length: count }, (_, i) => ({
    seat: i + 1,
    user_id: `u${i + 1}`,
    username: `private-name-${i}`,
    stack: 200,
    bet: 0,
    totalInvested: 0,
    cards: [],
    is_folded: false,
    is_all_in: false,
    is_sitting_out: false,
  }));
  const controller = new HandController(config, players, 1);
  const events: ActionEvent[] = [];
  controller.onEvent((event) => {
    if (event.type === 'PLAYER_ACTION') events.push(event);
  });
  controller.start();
  const facts = () => {
    const state = controller.getState();
    return {
      state,
      rights: controller.getAuthoritativeActionState(`u${state.currentPlayerSeat}`)!,
    };
  };
  return { controller, config, events, facts };
}
function checkOrCall(controller: HandController) {
  const state = controller.getState();
  const player = state.players.find((p) => p.seat === state.currentPlayerSeat)!;
  expect(
    controller.performAction(player.seat, state.currentBet > player.bet ? 'call' : 'check')
  ).toBe(true);
}

describe('public action nodes belong to the accepted action, before its mutation', () => {
  it('captures the original price, board, position and contribution without any private source read', () => {
    const h = harness();
    const { state, rights } = h.facts();
    for (const p of state.players)
      Object.defineProperty(p, 'cards', {
        get() {
          throw Error('private cards read');
        },
      });
    Object.defineProperty(state, 'deck', {
      get() {
        throw Error('private deck read');
      },
    });
    const expected = captureHorsePublicActionNode(h.config, state, rights, 1);
    expect(expected).toMatchObject({
      status: 'captured',
      pot: 3,
      currentBet: 2,
      toCall: 2,
      actorSeat: 1,
      boards: [''],
      minRaiseTo: 4,
    });
    expect(h.controller.performAction(1, 'raise', 6)).toBe(true);
    expect(h.events[0].publicNode).toEqual(expected);
    const serialized = JSON.stringify(expected);
    expect(serialized).not.toMatch(/private-name|user_id|username|hole|cards|deck/);
    for (let i = 0; i < 6; i++) checkOrCall(h.controller);
    expect(h.events[0].publicNode).toEqual(expected);
    expect(h.controller.getState().pot).toBeGreaterThan(3);
    if (expected.status !== 'captured') throw Error('capture missing');
    for (const value of [
      expected,
      expected.boards,
      expected.legalActions,
      expected.seats,
      ...expected.seats,
    ])
      expect(Object.isFrozen(value)).toBe(true);
    expect(h.controller.getState().actionHistory.every((a) => a.publicNode === undefined)).toBe(
      true
    );
  });

  it.each(['nlh', 'short_deck', 'flh', 'plo4', 'plo5', 'plo6', 'plo8', 'flo8'] as const)(
    'captures actual %s legality through every betting street',
    (gameVariant) => {
      const h = harness({ gameVariant });
      const stages = new Set<string>();
      for (
        let i = 0;
        i < 20 && !['showdown', 'complete'].includes(h.controller.getState().stage);
        i++
      ) {
        const { state, rights } = h.facts();
        const before = h.events.length;
        checkOrCall(h.controller);
        expect(h.events.length).toBe(before + 1);
        const node = h.events.at(-1)!.publicNode;
        expect(node).toMatchObject({
          status: 'captured',
          variant: gameVariant,
          street: state.stage,
          toCall: rights.toCall,
          structure: rights.structure,
          minRaiseTo: rights.minRaiseTo,
          maxRaiseTo: rights.maxRaiseTo,
          fixedBetSize: rights.fixedBetSize,
        });
        stages.add(state.stage);
      }
      expect([...stages]).toEqual(['preflop', 'flop', 'turn', 'river']);
    }
  );

  it.each([
    [3, 3, 'nlh', 3],
    [3, 2, 'plo6', 7],
    [3, 1, 'plo5', 9],
  ] as const)(
    'records actual board downgrade requested=%s actual=%s variant=%s seats=%s',
    (requested, actual, gameVariant, count) => {
      const h = harness(
        { gameVariant, bombPot: { anteMultiplier: 1, boardCount: requested } },
        count
      );
      expect(h.controller.getActiveBoardCount()).toBe(actual);
      checkOrCall(h.controller);
      const node = h.events[0].publicNode;
      expect(node).toMatchObject({
        status: 'captured',
        boardCount: actual,
        bombPot: true,
        street: 'flop',
      });
      if (node?.status !== 'captured') throw Error('missing bomb node');
      expect(node.boards).toHaveLength(actual);
      expect(node.boards.every((board) => board.length === 6)).toBe(true);
    }
  );

  it.each([{ isTournament: true }, { asset: 'diamonds' as const }, {}])(
    'preserves the hand funding unit %j',
    (overrides) => {
      const h = harness(overrides);
      checkOrCall(h.controller);
      const { asset, chipUnit } = h.controller.getChipRulesSnapshot();
      expect(h.events[0].publicNode).toMatchObject({ asset, chipUnit });
    }
  );

  it('metadata failure cannot reject a legal action or enter the public UI history', () => {
    const h = harness();
    const spy = vi.spyOn(h.controller, 'getAuthoritativeActionState').mockImplementation(() => {
      throw Error('metadata unavailable');
    });
    expect(h.controller.performAction(1, 'call')).toBe(true);
    expect(h.events[0].publicNode).toEqual({
      version: 1,
      status: 'unavailable',
      reason: 'invalid_public_state',
    });
    expect(h.controller.getState().actionHistory[0]).not.toHaveProperty('publicNode');
    spy.mockRestore();
  });

  it('marks forced all-in Pineapple discards without recording a private choice', () => {
    const h = harness({ gameVariant: 'pineapple' });
    const internal = h.controller as unknown as { state: GameState };
    for (const p of internal.state.players) p.is_all_in = true;
    const snapshot = h.controller.getPineappleRunoutDiscardSnapshot()!;
    expect(
      h.controller.preparePineappleRunoutDiscards(
        snapshot.flop,
        new Map(snapshot.players.map((p) => [p.seat, 1]))
      )
    ).toBe(true);
    h.controller.dealNextStreet();
    expect(h.events).toHaveLength(3);
    expect(h.events.map((e) => e.publicNode)).toEqual(
      Array.from({ length: 3 }, () => ({
        version: 1,
        status: 'unavailable',
        reason: 'forced_discard',
      }))
    );
  });
});

describe('malformed or incompatible public evidence is excluded', () => {
  const corruptions: Array<
    [string, (state: GameState, rights: AuthoritativeActionState, config: HandConfig) => void]
  > = [
    [
      'actor mismatch',
      (_s, r) => {
        r.heroSeat = 9;
      },
    ],
    [
      'duplicate seat',
      (s) => {
        s.players[1].seat = s.players[0].seat;
      },
    ],
    [
      'negative stack',
      (s) => {
        s.players[0].stack = -1;
      },
    ],
    [
      'nonfinite pot',
      (s) => {
        s.pot = NaN;
      },
    ],
    [
      'missing rights',
      (_s, r) => {
        r.canAct = false;
      },
    ],
    [
      'inverted bounds',
      (_s, r) => {
        r.minRaiseTo = 300;
      },
    ],
    [
      'duplicate legal action',
      (_s, r) => {
        r.legalActions.push(r.legalActions[0]);
      },
    ],
    [
      'unsupported variant',
      (_s, _r, c) => {
        c.gameVariant = 'bad' as HandConfig['gameVariant'];
      },
    ],
    [
      'unexpected board',
      (s) => {
        s.communityCards2 = [{ rank: 'A', suit: 'spades' }];
      },
    ],
    [
      'unknown asset',
      (_s, _r, c) => {
        c.asset = 'cash' as HandConfig['asset'];
      },
    ],
  ];
  it.each(corruptions)('%s', (_label, corrupt) => {
    const h = harness(),
      { state, rights } = h.facts();
    corrupt(state, rights, h.config);
    expect(captureHorsePublicActionNode(h.config, state, rights, 1)).toEqual({
      version: 1,
      status: 'unavailable',
      reason: 'invalid_public_state',
    });
  });
  it('excludes duplicate cards across independently dealt betting boards', () => {
    const h = harness({ bombPot: { anteMultiplier: 1, boardCount: 2 } }),
      { state, rights } = h.facts();
    state.communityCards2[0] = state.communityCards[0];
    expect(captureHorsePublicActionNode(h.config, state, rights, 2)).toMatchObject({
      status: 'unavailable',
    });
  });
  it('excludes non-betting stages and impossible Short Deck cards', () => {
    const h = harness({ gameVariant: 'short_deck', bombPot: { anteMultiplier: 1 } }),
      { state, rights } = h.facts();
    state.communityCards[0] = { rank: '2', suit: 'spades' };
    expect(captureHorsePublicActionNode(h.config, state, rights, 1)).toMatchObject({
      status: 'unavailable',
      reason: 'invalid_public_state',
    });
    state.stage = 'pineapple_discard';
    expect(captureHorsePublicActionNode(h.config, state, rights, 1)).toMatchObject({
      status: 'unavailable',
      reason: 'non_betting_action',
    });
  });
});
