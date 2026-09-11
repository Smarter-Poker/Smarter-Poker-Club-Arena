import { beforeEach, describe, expect, it, vi } from 'vitest';

const equityWorker = vi.hoisted(() => ({
  estimateEquity: vi.fn(async (hands: unknown[][]) => hands.map(() => 1 / hands.length)),
  estimateLayeredEquity: vi.fn(
    async (
      hands: unknown[][],
      _playerIds: string[],
      _playerSeats: number[],
      _board: unknown[],
      _dead: unknown[],
      _iters: number,
      _variant: string,
      pots: Array<{ amount: number }>,
      _dealer: number,
      totalWinnings: number
    ) => ({
      equities: hands.map(() => 1 / hands.length),
      layerEquities: pots.map(() => hands.map(() => 1 / hands.length)),
      expectedNetReturns: hands.map(() => totalWinnings / hands.length),
      strictLossPcts: hands.map(() => 50),
      pushPcts: hands.map(() => 0),
      seed: 424242,
      exact: true,
      runouts: 1,
    })
  ),
}));

vi.mock('./equity/EquityWorkerPool.js', () => ({
  getEquityPool: () => equityWorker,
}));
import { ServerTableEngine } from './ServerTableEngine.js';

const TABLE = '18181818-1818-4818-8818-181818181818';

function action(userId: string, name: string, stage: string, seat: number) {
  return { seat, userId, action: name, amount: 1, timestamp: 1, stage };
}

function player(userId: string, seat: number) {
  const holdings = [
    [
      { rank: 'A', suit: 'spades' },
      { rank: 'A', suit: 'hearts' },
    ],
    [
      { rank: 'K', suit: 'spades' },
      { rank: 'K', suit: 'hearts' },
    ],
    [
      { rank: 'Q', suit: 'spades' },
      { rank: 'Q', suit: 'hearts' },
    ],
  ];
  return { user_id: userId, seat, cards: holdings[seat - 1] };
}

const FLOP = [
  { rank: '2', suit: 'clubs' },
  { rank: '7', suit: 'diamonds' },
  { rank: 'J', suit: 'hearts' },
];

const PROVENANCE = {
  version: 'layered-settlement-v1',
  exact: true,
  runouts: 1,
  seed: 424242,
  inputHash: 'a'.repeat(64),
};

function harness() {
  const engine = new ServerTableEngine(TABLE) as any;
  engine.handCount = 1234567;
  engine.killForRestart = vi.fn();
  engine.hub = { emitEvent: vi.fn() };
  engine.lifecycleCanMutate = () => true;
  return engine;
}

describe('durable all-in runout evidence', () => {
  beforeEach(() => vi.clearAllMocks());

  it('marks the latest canonical action for every participant, including early shover and cover', () => {
    const engine = harness();
    engine.currentHandActions = [
      action('early', 'all_in', 'preflop', 1),
      action('cover', 'call', 'preflop', 2),
      action('short', 'call', 'preflop', 3),
      action('cover', 'bet', 'flop', 2),
      action('short', 'call', 'flop', 3),
    ];

    engine.recordAllInRunoutObligation(
      [player('early', 1), player('cover', 2), player('short', 3)],
      [FLOP]
    );

    const marked = engine.currentHandActions.filter((entry: any) => entry.allInRunout === true);
    expect(marked).toHaveLength(3);
    expect(
      marked.map((entry: any) => [entry.userId, entry.stage, entry.allInRunoutStreet])
    ).toEqual([
      ['early', 'preflop', 'flop'],
      ['cover', 'flop', 'flop'],
      ['short', 'flop', 'flop'],
    ]);
  });

  it.each(['small_blind', 'big_blind', 'ante', 'bomb_ante'])(
    'uses a forced %s as the canonical action when it put a player all in',
    (forced) => {
      const engine = harness();
      engine.currentHandActions = [
        action('forced', forced, 'preflop', 1),
        action('cover', 'big_blind', 'preflop', 2),
      ];
      engine.recordAllInRunoutObligation([player('forced', 1), player('cover', 2)], [[]]);
      expect(engine.currentHandActions[0]).toMatchObject({
        allInRunout: true,
        allInRunoutStreet: 'preflop',
      });
    }
  );

  it('is idempotent for the same boundary and refuses contradictory evidence', () => {
    const engine = harness();
    engine.currentHandActions = [
      action('a', 'all_in', 'preflop', 1),
      action('b', 'call', 'preflop', 2),
    ];
    const players = [player('a', 1), player('b', 2)];
    engine.recordAllInRunoutObligation(players, [[]]);
    engine.recordAllInRunoutObligation(players, [[]]);
    expect(engine.currentHandActions.filter((entry: any) => entry.allInRunout)).toHaveLength(2);
    expect(() => engine.recordAllInRunoutObligation(players, [FLOP])).toThrow('street_changed');
  });

  it('refuses a participant without a canonical action before payout can continue', () => {
    const engine = harness();
    engine.currentHandActions = [action('a', 'all_in', 'turn', 1)];
    expect(() =>
      engine.recordAllInRunoutObligation(
        [player('a', 1), player('missing', 2)],
        [[...FLOP, { rank: 'Q', suit: 'spades' }]]
      )
    ).toThrow('canonical_action_missing');
    expect(engine.currentHandActions.every((entry: any) => entry.allInRunout === undefined)).toBe(
      true
    );
  });

  it('validates every percentage before writing any participant equity', () => {
    const engine = harness();
    engine.currentHandActions = [
      action('a', 'all_in', 'flop', 1),
      action('b', 'call', 'flop', 2),
      action('c', 'call', 'flop', 3),
    ];
    const players = [player('a', 1), player('b', 2), player('c', 3)];
    engine.recordAllInRunoutObligation(players, [FLOP]);

    expect(() =>
      engine.recordAllInRunoutEquity(players, [60, 40, Number.NaN], [60, 40, 0], PROVENANCE)
    ).toThrow('invalid_percentage');
    expect(engine.currentHandActions.every((entry: any) => entry.allInEquity === undefined)).toBe(
      true
    );
  });

  it('stores first-point equity as fractions on the same durable markers and resolves the join', async () => {
    const engine = harness();
    engine.currentHandActions = [action('a', 'all_in', 'turn', 1), action('b', 'call', 'turn', 2)];
    const players = [player('a', 1), player('b', 2)];
    engine.recordAllInRunoutObligation(players, [[...FLOP, { rank: 'Q', suit: 'spades' }]]);
    const joined = engine.currentHandAllInEquityEvidence;

    engine.emitAllInEquityPayload(
      players,
      [72.4, 27.6],
      [],
      100,
      1,
      true,
      true,
      [72.4, 27.6],
      PROVENANCE
    );
    await joined;
    expect(engine.currentHandActions.map((entry: any) => entry.allInEquity)).toEqual([
      0.724, 0.276,
    ]);
    expect(engine.currentHandActions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          allInEquityVersion: PROVENANCE.version,
          allInEquityExact: true,
          allInEquityRunouts: 1,
          allInEquitySeed: PROVENANCE.seed,
          allInEquityInputHash: PROVENANCE.inputHash,
        }),
      ])
    );

    engine.emitAllInEquityPayload(players, [100, 0], [], 100, 1, false);
    expect(engine.currentHandActions.map((entry: any) => entry.allInEquity)).toEqual([
      0.724, 0.276,
    ]);
  });

  it('refuses a partial participant set instead of completing a partial witness', async () => {
    const engine = harness();
    engine.currentHandActions = [
      action('a', 'all_in', 'flop', 1),
      action('b', 'call', 'flop', 2),
      action('c', 'call', 'flop', 3),
    ];
    const players = [player('a', 1), player('b', 2), player('c', 3)];
    engine.recordAllInRunoutObligation(players, [FLOP]);
    const joined = engine.currentHandAllInEquityEvidence;

    engine.emitAllInEquityPayload(
      players.slice(0, 2),
      [60, 40],
      FLOP,
      100,
      1,
      true,
      true,
      [60, 40],
      PROVENANCE
    );
    await joined;

    expect(engine.currentHandActions.every((entry: any) => entry.allInEquity === undefined)).toBe(
      true
    );
    expect(engine.killForRestart).toHaveBeenCalledWith('all_in_equity_evidence_refused');
  });

  it('defers preflop Pineapple until the first legal post-discard board', async () => {
    const engine = harness();
    engine.tableInfo = { game_variant: 'pineapple' };
    engine.activeHandVariant = () => 'pineapple';
    engine.currentHandActions = [
      action('a', 'all_in', 'preflop', 1),
      action('b', 'call', 'preflop', 2),
    ];
    const players = [
      { ...player('a', 1), cards: [...player('a', 1).cards, { rank: 'T', suit: 'clubs' }] },
      { ...player('b', 2), cards: [...player('b', 2).cards, { rank: '9', suit: 'clubs' }] },
    ];
    engine.recordAllInRunoutObligation(players, [[]]);
    const joined = engine.currentHandAllInEquityEvidence;

    await engine.broadcastAllInEquity(players, [], 100, [], { recordDurable: true });
    expect(engine.currentHandAllInEquityEvidenceClosed).toBe(false);
    expect(engine.currentHandAllInEquityBoundaryKey).toBeNull();
    expect(equityWorker.estimateEquity).not.toHaveBeenCalled();

    const postDiscard = [player('a', 1), player('b', 2)];
    engine.handController = {
      getState: () => ({
        communityCards: FLOP,
        communityCards2: [],
        communityCards3: [],
        dealerSeat: 1,
      }),
      computeLivePots: () => [{ amount: 100, eligiblePlayers: ['a', 'b'] }],
      computeRakeAndBBJ: () => ({ rake: 0, bbjFee: 0 }),
    };
    await engine.broadcastAllInEquity(postDiscard, FLOP, 100);
    await joined;

    expect(engine.currentHandAllInEquityEvidenceClosed).toBe(true);
    expect(engine.currentHandAllInEquityBoundaryKey).not.toBeNull();
    expect(engine.currentHandActions.map((entry: any) => entry.allInEquity)).toEqual([0.5, 0.5]);
    expect(
      engine.currentHandActions.every(
        (entry: any) =>
          entry.allInEquityVersion === 'layered-settlement-v1' &&
          entry.allInEquitySeed === 424242 &&
          /^[a-f0-9]{64}$/.test(entry.allInEquityInputHash)
      )
    ).toBe(true);
  });

  it('fails the whole witness closed when one participant holding is truncated', async () => {
    const engine = harness();
    engine.activeHandVariant = () => 'nlh';
    engine.currentHandActions = [action('a', 'all_in', 'flop', 1), action('b', 'call', 'flop', 2)];
    const players = [player('a', 1), { ...player('b', 2), cards: [{}] }];
    engine.recordAllInRunoutObligation(players, [FLOP]);
    const joined = engine.currentHandAllInEquityEvidence;
    engine.handController = {
      getState: () => ({ communityCards: FLOP, communityCards2: [], communityCards3: [] }),
    };

    await engine.broadcastAllInEquity(players, FLOP, 100, [], { recordDurable: true });
    await joined;

    expect(equityWorker.estimateEquity).not.toHaveBeenCalled();
    expect(engine.currentHandActions.every((entry: any) => entry.allInEquity === undefined)).toBe(
      true
    );
    expect(engine.killForRestart).toHaveBeenCalledWith('all_in_equity_participant_cards_invalid');
  });
});
