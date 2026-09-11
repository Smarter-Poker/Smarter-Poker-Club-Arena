/**
 * PHASE 2 — the felt never shows equity for a hand nobody is allowed to hold.
 *
 * In Crazy Pineapple a player holds THREE cards until the flop lands, and the
 * equity solver has no rule for that:
 *
 *   omaha: false -> evaluateHand scores best-5-of-8, the same illegal
 *                   advantage that was paying impossible flushes at showdown
 *                   until #2072;
 *   omaha: true  -> evaluateOmahaHand falls through its `holeCards.length < 4`
 *                   guard and silently prices the FIRST TWO cards.
 *
 * Both numbers are confident and wrong, and they go on the felt as percentages
 * players trust. There is no honest third number: the real preflop equity
 * depends on a discard that has not happened yet.
 *
 * So the broadcast waits for the flop - which is where Dan's own rule already
 * points ("equity only AFTER the street lands"), and in this variant the flop
 * is the first moment the numbers mean anything at all. The discard resolves
 * as the flop lands, and the per-street refresh prices every street after.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

const estimateLayeredEquity = vi.hoisted(() =>
  vi.fn(async (hands: unknown[][], ...args: unknown[]) => {
    const pots = args[6] as unknown[];
    const totalWinnings = args[8] as number;
    return {
      equities: hands.map(() => 1 / hands.length),
      layerEquities: pots.map(() => hands.map(() => 1 / hands.length)),
      expectedNetReturns: hands.map(() => totalWinnings / hands.length),
      strictLossPcts: hands.map(() => 50),
      pushPcts: hands.map(() => 0),
      seed: 424242,
      exact: true,
      runouts: 1,
    };
  })
);
vi.mock('./equity/EquityWorkerPool.js', () => ({
  getEquityPool: () => ({ estimateLayeredEquity }),
}));

import { ServerTableEngine } from './ServerTableEngine.js';

const TABLE = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
afterEach(() => vi.restoreAllMocks());

function harness(variant: string) {
  const engine = new ServerTableEngine(TABLE) as any;
  engine.tableInfo = { game_variant: variant } as any;
  engine.activeHandVariant = () => variant;
  engine.liveExtraBoards = () => [];
  engine.lifecycleCanMutate = () => true;
  engine.hub = { emitEvent: vi.fn() };
  engine.broadcastEvent = vi.fn();
  return engine;
}

function bindLiveBoard(engine: any, board: Array<{ rank: string; suit: string }>) {
  engine.handController = {
    getState: () => ({
      communityCards: board,
      communityCards2: [],
      communityCards3: [],
      dealerSeat: 1,
    }),
    computeLivePots: () => [{ amount: 100, eligiblePlayers: ['u1', 'u2'] }],
    computeRakeAndBBJ: () => ({ rake: 0, bbjFee: 0 }),
    getVisibleEquityDeadCards: () => [],
  };
}

const SUITS: Record<string, string> = {
  c: 'clubs',
  d: 'diamonds',
  h: 'hearts',
  s: 'spades',
};
const seat = (n: number, cards: string[]) => ({
  seat: n,
  user_id: `u${n}`,
  username: `P${n}`,
  cards: cards.map((s) => ({ rank: s.slice(0, -1), suit: SUITS[s.slice(-1)] })),
});

describe('all-in equity on a pineapple table', () => {
  it('is NOT broadcast while anyone still holds three cards', async () => {
    const engine = harness('pineapple');
    const emitted: unknown[] = [];
    engine.hub.emitEvent = vi.fn((_t: string, e: unknown) => emitted.push(e));

    await engine.broadcastAllInEquity(
      [seat(1, ['Ah', 'Kh', '2c']), seat(2, ['Qs', 'Qd', '7h'])],
      [],
      100
    );

    expect(emitted, 'a three-card hand has no honest equity - say nothing').toHaveLength(0);
  });

  it('one seat still holding three is enough to hold the whole broadcast', async () => {
    // Equity is relative: pricing the two-card seats against a three-card one
    // is wrong for everybody at the table, not just the seat with the extra
    // card.
    const engine = harness('pineapple');
    const emitted: unknown[] = [];
    engine.hub.emitEvent = vi.fn((_t: string, e: unknown) => emitted.push(e));

    await engine.broadcastAllInEquity(
      [seat(1, ['Ah', 'Kh', '2c']), seat(2, ['Qs', 'Qd'])],
      [],
      100
    );

    expect(emitted).toHaveLength(0);
  });

  it('IS broadcast once the discard has resolved and everyone holds two', async () => {
    const engine = harness('pineapple');
    const emitted: any[] = [];
    engine.hub.emitEvent = vi.fn((_t: string, e: unknown) => emitted.push(e));
    const board = [
      { rank: '7', suit: 'hearts' },
      { rank: '8', suit: 'hearts' },
      { rank: '3', suit: 'clubs' },
    ];
    bindLiveBoard(engine, board);

    await engine.broadcastAllInEquity([seat(1, ['Ah', 'Kh']), seat(2, ['Qs', 'Qd'])], board, 100);

    expect(emitted.length, 'a legal two-card hand is priced as normal').toBeGreaterThan(0);
  });

  it('does not touch OMAHA, where four hole cards are the whole point', async () => {
    const engine = harness('plo4');
    const emitted: any[] = [];
    engine.hub.emitEvent = vi.fn((_t: string, e: unknown) => emitted.push(e));
    bindLiveBoard(engine, []);

    await engine.broadcastAllInEquity(
      [seat(1, ['Ah', 'Kh', '2c', '9d']), seat(2, ['Qs', 'Qd', '7h', '4s'])],
      [],
      100
    );

    expect(emitted.length, 'the >2 guard must not swallow Omaha').toBeGreaterThan(0);
  });
});
