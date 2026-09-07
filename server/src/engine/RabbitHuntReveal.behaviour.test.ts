/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  RABBIT HUNT — THE REVEAL, DRIVEN RATHER THAN GREPPED
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * The existing rabbit-hunt suite (tests/unit/rabbitHuntIsPaidFor.test.ts) is
 * thirty SOURCE-TEXT guards. They are good at what they do — they pin the shape
 * of a security hole so it cannot be reopened by an edit that looks innocent —
 * but every one of them passes on code that does not run. Rewrite
 * revealRabbitHunt with different wording and they all still go green while the
 * paywall is gone.
 *
 * So this file calls the real method. `revealRabbitHunt` is public and reads
 * only fields on the engine, so it can be exercised against a bare object with
 * the right shape — no table, no database, no hand. The one external call
 * (the billing RPC) is stubbed, which is the point: what is under test is the
 * ORDER of the gates and what is returned, not what Postgres does.
 *
 * Everything asserted here is a rule Dan stated:
 *   - only the player who paid sees the cards
 *   - VIP gets 100 a month free, then 5 diamonds
 *   - the offer follows the hand, not the table
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// The RPC is the only thing revealRabbitHunt reaches outside itself.
const rpc = vi.fn();
const revealInsert = vi.fn();
vi.mock('../services/supabase.js', () => ({
  supabase: {
    rpc: (...args: unknown[]) => rpc(...args),
    from: (table: string) => ({
      insert: (payload: unknown) => revealInsert(table, payload),
    }),
  },
  loadTable: vi.fn(),
  syncStacks: vi.fn(),
  syncTournamentChips: vi.fn(),
  updateTableStatus: vi.fn(),
  autoRebuyHorse: vi.fn(),
  markSeatAsLeft: vi.fn(),
  processLeavePending: vi.fn(),
  logBBJCollection: vi.fn(),
  logInsuranceSettlement: vi.fn(),
  logHandHistory: vi.fn(),
  processBBJPayout: vi.fn(),
  completeHandSnapshot: vi.fn(),
}));
vi.mock('../services/errorReporter.js', () => ({ reportError: vi.fn() }));

const { ServerTableEngineSettlement } = await import('./ServerTableEngineSettlement.js');

const HERO = 'hero-user-id';
const VILLAIN = 'villain-user-id';
const HAND = 1_000_042;

type Reveal = Awaited<
  ReturnType<InstanceType<typeof ServerTableEngineSettlement>['revealRabbitHunt']>
>;

/**
 * A minimal stand-in carrying only what revealRabbitHunt touches. Built from the
 * real prototype so the method under test is the shipped one.
 */
function makeEngine(overrides: Record<string, unknown> = {}) {
  const offer = {
    cards: [
      { rank: 'A', suit: 'hearts' },
      { rank: 'K', suit: 'spades' },
      { rank: 'Q', suit: 'clubs' },
      { rank: 'J', suit: 'diamonds' },
      { rank: 'T', suit: 'hearts' },
    ],
    boardLength: 0,
    eligible: new Set([HERO, VILLAIN]),
    revealed: new Set<string>(),
    purchaseRequestIds: new Map<string, string>(),
    offeredAt: Date.now(),
  };
  const engine = Object.create(ServerTableEngineSettlement.prototype) as Record<string, unknown>;
  Object.assign(engine, {
    tableId: 'table-1',
    handCount: HAND,
    tableInfo: { allow_rabbit_hunt: true },
    rabbitHuntOffers: new Map([[HAND, offer]]),
    rabbitHuntInFlight: new Set<string>(),
    ...overrides,
  });
  return {
    engine,
    offer,
    reveal: (userId = HERO, hand?: number): Promise<Reveal> =>
      (engine as unknown as InstanceType<typeof ServerTableEngineSettlement>).revealRabbitHunt(
        userId,
        hand
      ),
  };
}

beforeEach(() => {
  rpc.mockReset();
  revealInsert.mockReset();
  revealInsert.mockResolvedValue({ error: null });
  rpc.mockResolvedValue({
    data: { success: true, source: 'vip_monthly', vip_remaining: 99, diamonds_spent: 0 },
    error: null,
  });
});

describe('who may buy a reveal', () => {
  it('a player who was dealt in gets the cards', async () => {
    const { reveal } = makeEngine();
    const r = await reveal();
    expect(r.success).toBe(true);
    expect(r.cards).toHaveLength(5);
  });

  it('a spectator is refused, and is never charged', async () => {
    const { reveal } = makeEngine();
    const r = await reveal('someone-who-was-watching');
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/not dealt into/i);
    expect(r.cards).toBeUndefined();
    expect(rpc).not.toHaveBeenCalled();
  });

  it('a hand the engine no longer holds is refused, and is never charged', async () => {
    const { reveal } = makeEngine();
    const r = await reveal(HERO, HAND - 5);
    expect(r.success).toBe(false);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('a table with rabbit hunt switched off refuses everyone', async () => {
    const { reveal } = makeEngine({ tableInfo: { allow_rabbit_hunt: false } });
    const r = await reveal();
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/disabled/i);
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe('how many cards, and which', () => {
  it('a pre-flop fold reveals the whole board', async () => {
    const { reveal } = makeEngine();
    expect((await reveal()).cards).toHaveLength(5);
  });

  it('a turn fold reveals only the river', async () => {
    const { engine, reveal } = makeEngine();
    (engine.rabbitHuntOffers as Map<number, { boardLength: number }>).get(HAND)!.boardLength = 4;
    const r = await reveal();
    expect(r.cards).toHaveLength(1);
    expect(r.board_length).toBe(4);
  });

  it('a hand that ran to the river has nothing to sell', async () => {
    const { engine, reveal } = makeEngine();
    (engine.rabbitHuntOffers as Map<number, { boardLength: number }>).get(HAND)!.boardLength = 5;
    const r = await reveal();
    expect(r.success).toBe(false);
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe('the charge', () => {
  it('a VIP inside the monthly pool pays nothing and is told what is left', async () => {
    const { reveal } = makeEngine();
    const r = await reveal();
    expect(rpc).toHaveBeenCalledWith('fn_consume_rabbit_hunt_v2', {
      p_user_id: HERO,
      p_request_id: expect.any(String),
    });
    expect(r.source).toBe('vip_monthly');
    expect(r.diamonds_spent).toBe(0);
    expect(r.vip_remaining).toBe(99);
  });

  it('past the pool it costs diamonds, and the balance comes back a number', async () => {
    rpc.mockResolvedValue({
      data: { success: true, source: 'diamonds', diamonds_spent: 5, diamonds_remaining: 120 },
      error: null,
    });
    const { reveal } = makeEngine();
    const r = await reveal();
    expect(r.diamonds_spent).toBe(5);
    expect(r.diamonds_remaining).toBe(120);
    expect(typeof r.diamonds_remaining).toBe('number');
  });

  it('records one metadata-only reveal after payment and never stores the cards', async () => {
    rpc.mockResolvedValue({
      data: { success: true, source: 'diamonds', diamonds_spent: 5, diamonds_remaining: 120 },
      error: null,
    });
    const { reveal } = makeEngine();
    const result = await reveal();

    expect(result.success).toBe(true);
    expect(revealInsert).toHaveBeenCalledTimes(1);
    expect(revealInsert).toHaveBeenCalledWith('rabbit_hunt_reveals', {
      user_id: HERO,
      table_id: 'table-1',
      hand_number: HAND,
      charged: 5,
    });
    expect(JSON.stringify(revealInsert.mock.calls)).not.toMatch(/\"cards\"/);
  });

  it('returns paid cards when the metadata ledger is temporarily unavailable', async () => {
    revealInsert.mockResolvedValue({ error: new Error('ledger unavailable') });
    const result = await makeEngine().reveal();
    expect(result.success).toBe(true);
    expect(result.cards).toHaveLength(5);
  });

  it('a purchased pack reports what is left of it', async () => {
    rpc.mockResolvedValue({
      data: { success: true, source: 'purchased', diamonds_spent: 0, uses_remaining: 7 },
      error: null,
    });
    const r = await makeEngine().reveal();
    expect(r.source).toBe('purchased');
    expect(r.uses_remaining).toBe(7);
  });

  it('A REFUSED CHARGE REVEALS NOTHING', async () => {
    // The whole point of the paywall.
    rpc.mockResolvedValue({
      data: { success: false, error: 'insufficient_diamonds', cost: 5, diamonds_remaining: 2 },
      error: null,
    });
    const r = await makeEngine().reveal();
    expect(r.success).toBe(false);
    expect(r.cards).toBeUndefined();
    expect(r.error).toMatch(/not enough diamonds/i);
    expect(revealInsert).not.toHaveBeenCalled();
  });

  it('an RPC that throws reveals nothing either', async () => {
    rpc.mockRejectedValue(new Error('connection reset'));
    const r = await makeEngine().reveal();
    expect(r.success).toBe(false);
    expect(r.cards).toBeUndefined();
  });

  it('an unknown account is named, not lumped in with a shortfall', async () => {
    rpc.mockResolvedValue({ data: { success: false, error: 'unknown user' }, error: null });
    const r = await makeEngine().reveal();
    expect(r.success).toBe(false);
    expect(r.error).not.toMatch(/not enough diamonds/i);
  });
});

describe('paying twice for one reveal is impossible', () => {
  it('a second click returns the same cards and charges nothing', async () => {
    const { reveal } = makeEngine();
    const first = await reveal();
    expect(first.success).toBe(true);
    expect(rpc).toHaveBeenCalledTimes(1);

    const second = await reveal();
    expect(second.success).toBe(true);
    expect(second.cards).toEqual(first.cards);
    expect(second.source).toBe('already_revealed');
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('two clicks racing the RPC bill once', async () => {
    // `revealed` is only written after the charge returns, so both callers pass
    // that check. Without the in-flight guard both would be billed.
    let release!: () => void;
    rpc.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve({
              data: { success: true, source: 'diamonds', diamonds_spent: 5 },
              error: null,
            });
        })
    );
    const { reveal } = makeEngine();
    const a = reveal();
    const b = reveal();
    release();
    const [ra, rb] = await Promise.all([a, b]);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect([ra.success, rb.success].filter(Boolean)).toHaveLength(1);
  });

  it('a failed charge does not lock the player out forever', async () => {
    // The in-flight marker is released in a finally. If it were not, a single
    // network blip would end rabbit hunt for that player until the engine
    // restarted.
    rpc.mockRejectedValueOnce(new Error('blip'));
    const { engine, reveal } = makeEngine();
    await reveal();
    expect((engine.rabbitHuntInFlight as Set<string>).has(HERO)).toBe(false);

    rpc.mockResolvedValue({
      data: { success: true, source: 'diamonds', diamonds_spent: 5 },
      error: null,
    });
    expect((await reveal()).success).toBe(true);
  });

  it('reuses the same purchase identity after a committed response is lost', async () => {
    const committedReceipts = new Map<string, Record<string, unknown>>();
    rpc.mockImplementation(
      async (_functionName: string, args: { p_user_id: string; p_request_id: string }) => {
        const existing = committedReceipts.get(args.p_request_id);
        if (existing) {
          return { data: { ...existing, idempotent: true }, error: null };
        }

        committedReceipts.set(args.p_request_id, {
          success: true,
          source: 'diamonds',
          diamonds_spent: 5,
          diamonds_remaining: 120,
        });
        // This is the ambiguous window: the database mutation committed, but
        // the engine never received its response and therefore did not mark the
        // cards revealed in memory.
        throw new Error('response lost after commit');
      }
    );

    const { offer, reveal } = makeEngine();
    const first = await reveal();
    expect(first.success).toBe(false);
    expect(first.cards).toBeUndefined();
    expect(offer.revealed.has(HERO)).toBe(false);

    const second = await reveal();
    expect(second.success).toBe(true);
    expect(second.cards).toHaveLength(5);
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc.mock.calls[0]?.[1]?.p_request_id).toBe(rpc.mock.calls[1]?.[1]?.p_request_id);
    expect(committedReceipts.size).toBe(1);
  });
});

describe('an offer goes stale', () => {
  it('an old hand is refused rather than sold', async () => {
    const { engine, reveal } = makeEngine();
    (engine.rabbitHuntOffers as Map<number, { offeredAt: number }>).get(HAND)!.offeredAt =
      Date.now() - 10 * 60 * 1000;
    const r = await reveal();
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/too old/i);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('a fresh offer is not', async () => {
    const { engine, reveal } = makeEngine();
    (engine.rabbitHuntOffers as Map<number, { offeredAt: number }>).get(HAND)!.offeredAt =
      Date.now() - 1000;
    expect((await reveal()).success).toBe(true);
  });
});
