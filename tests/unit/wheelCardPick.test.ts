/**
 * THE CARD PICK IS THE SERVER'S (owner ruling 2026-09-21, R15). The client
 * asks fn_wheel_diamond_cards_pick to turn a card over, and shows what came
 * back: the three values by position, which card was picked and what it paid.
 *
 * So what is pinned here is the seam, in both directions:
 *
 *   - the ASK carries a real award and a card in 1..3, and nothing else ever
 *     reaches the server;
 *   - the ANSWER is checked before it is believed. A paid figure that is not
 *     the picked card's value, a card outside the hand, a hand that is not
 *     three cards, or another award's answer is thrown, never shown as a
 *     prize; a refusal keeps its own words for the player to read;
 *   - the STATE carries `pending_cards`, `vip` and `model_version`, and an
 *     older server that carries none of them reads as a player with no picks
 *     waiting rather than as an error;
 *   - the RUN counts a card pick instead of an instant prize, because a
 *     Diamonds spin that sealed three cards has paid nothing yet.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
const rpc = vi.hoisted(() => vi.fn());
vi.mock('../../src/lib/supabase', () => ({ supabase: { rpc } }));
import service, { type WheelSpinResult } from '../../src/services/DiamondWheelService';
import { tallyWheelRun, wheelRunSoFar, type WheelRun } from '../../src/utils/autoRun';
import v3 from '../fixtures/diamond-spins/wheel-v3-postgres-receipts.json';

const CLUB = '10000000-0000-0000-0000-000000000002';
const AWARD = '10000000-0000-0000-0000-000000000041';
const SPIN = '10000000-0000-0000-0000-000000000042';
const twelve = Array.from({ length: 12 }, (_, i) => ({
  ord: i + 1,
  kind:
    i < 4
      ? 'bonus'
      : i === 4
        ? 'upgrade'
        : i < 8
          ? 'chips'
          : ['throwables', 'time_bank', 'rabbit_hunt', 'diamonds'][i - 8],
  game: i < 4 ? ['plinko', 'crash', 'crossing', 'mines'][i] : undefined,
  amount: 1,
  value_chips: 1,
  weight: 1,
  probability: 1 / 12,
  locked: false,
}));
const baseState = {
  ok: true,
  enabled: true,
  contract_version: 2,
  available: true,
  min_entry: 25,
  max_entry: 2500,
  host_id: CLUB,
  host_kind: 'club',
  segments: twelve,
};
const card = {
  id: AWARD,
  spin_id: SPIN,
  risk_diamonds: 100,
  created_at: '2026-09-21T15:01:00Z',
};
const paid = {
  ok: true,
  award_id: AWARD,
  picked: 2,
  cards: [200, 300, 50],
  paid_diamonds: 300,
  balances: { diamonds: 1300 },
  fairness: {
    domain: 'wheel-v4-cards',
    roll: 12345,
    permutation: 4,
    server_seed: 'a'.repeat(64),
    server_seed_hash: 'b'.repeat(64),
    client_seed: 'seed',
    nonce: 7,
  },
};

beforeEach(() => rpc.mockReset());

describe('fn_wheel_diamond_cards_pick', () => {
  it('turns one card over and reads the whole hand back', async () => {
    rpc.mockResolvedValueOnce({ data: paid, error: null });
    await expect(service.pickDiamondCard(AWARD, 2)).resolves.toEqual({
      ok: true,
      award_id: AWARD,
      picked: 2,
      cards: [200, 300, 50],
      paid_diamonds: 300,
      balances: { diamonds: 1300 },
      fairness: {
        domain: 'wheel-v4-cards',
        roll: 12345,
        permutation: 4,
        server_seed: 'a'.repeat(64),
        server_seed_hash: 'b'.repeat(64),
        client_seed: 'seed',
        nonce: 7,
      },
    });
    expect(rpc).toHaveBeenCalledWith('fn_wheel_diamond_cards_pick', {
      p_award_id: AWARD,
      p_card: 2,
    });
  });

  it('reads numbers the database sends as strings, and a reply with no fairness block', async () => {
    rpc.mockResolvedValueOnce({
      data: {
        ok: true,
        award_id: AWARD,
        picked: '3',
        cards: ['200', '300', '50'],
        paid_diamonds: '50',
        balances: { diamonds: '1050' },
      },
      error: null,
    });
    const answer = await service.pickDiamondCard(AWARD, 3);
    expect(answer).toEqual({
      ok: true,
      award_id: AWARD,
      picked: 3,
      cards: [200, 300, 50],
      paid_diamonds: 50,
      balances: { diamonds: 1050 },
    });
  });

  it('keeps a refusal in the server words and pays nothing', async () => {
    rpc.mockResolvedValueOnce({
      data: { ok: false, error: 'This Card Pick Is Already Made' },
      error: null,
    });
    await expect(service.pickDiamondCard(AWARD, 1)).resolves.toEqual({
      ok: false,
      error: 'This Card Pick Is Already Made',
      award_id: AWARD,
      picked: 0,
      cards: [],
      paid_diamonds: 0,
      balances: { diamonds: 0 },
    });
  });

  it('returns the pick the server recorded, even when another card was tapped', async () => {
    rpc.mockResolvedValueOnce({ data: paid, error: null });
    const answer = await service.pickDiamondCard(AWARD, 1);
    expect(answer.picked).toBe(2);
    expect(answer.paid_diamonds).toBe(300);
  });

  it('refuses to send a card that is not one of the three, or an award that is not one', async () => {
    for (const bad of [0, 4, 1.5, Number.NaN])
      await expect(service.pickDiamondCard(AWARD, bad)).rejects.toThrow(
        'The Card Pick Could Not Be Sent'
      );
    await expect(service.pickDiamondCard('not-an-award', 1)).rejects.toThrow(
      'The Card Pick Could Not Be Sent'
    );
    expect(rpc).not.toHaveBeenCalled();
  });

  it('throws on an answer that does not add up, rather than showing a prize', async () => {
    const broken = [
      { ...paid, paid_diamonds: 500 },
      { ...paid, picked: 4 },
      { ...paid, cards: [200, 300] },
      { ...paid, award_id: '10000000-0000-0000-0000-000000000099' },
      { ...paid, balances: {} },
      { ok: true },
      'not an object',
    ];
    for (const data of broken) {
      rpc.mockResolvedValueOnce({ data, error: null });
      await expect(service.pickDiamondCard(AWARD, 2)).rejects.toThrow(
        'The Card Pick Could Not Be Confirmed'
      );
    }
  });

  it('passes a transport error up untouched', async () => {
    rpc.mockResolvedValueOnce({ data: null, error: new Error('PGRST002') });
    await expect(service.pickDiamondCard(AWARD, 2)).rejects.toThrow('PGRST002');
  });
});

describe('fn_wheel_state_v2 carries the picks still waiting', () => {
  it('reads pending_cards, vip and model_version', async () => {
    rpc.mockResolvedValueOnce({
      data: { ...baseState, vip: true, model_version: 'wheel-v4', pending_cards: [card] },
      error: null,
    });
    const state = await service.getStateV2(CLUB, 100);
    expect(state.pending_cards).toEqual([card]);
    expect(state.vip).toBe(true);
    expect(state.model_version).toBe('wheel-v4');
  });

  it('an older server with none of them is a player with no pick waiting', async () => {
    rpc.mockResolvedValueOnce({ data: baseState, error: null });
    const state = await service.getStateV2(CLUB, 100);
    expect(state.pending_cards).toEqual([]);
    expect(state.vip).toBe(false);
    expect(state.model_version).toBeUndefined();
  });

  it('drops a card row that could never be picked, and keeps the ones that can', async () => {
    rpc.mockResolvedValueOnce({
      data: {
        ...baseState,
        pending_cards: [
          { id: 'nope', spin_id: SPIN, risk_diamonds: 100 },
          { id: AWARD, spin_id: SPIN, risk_diamonds: 0 },
          null,
          { id: AWARD, spin_id: SPIN, risk_diamonds: '250' },
        ],
      },
      error: null,
    });
    const state = await service.getStateV2(CLUB, 100);
    expect(state.pending_cards).toEqual([{ id: AWARD, spin_id: SPIN, risk_diamonds: 250 }]);
  });
});

describe('the spin receipt seals the award', () => {
  const diamonds = v3.records
    .filter((r) => r.kind === 'wheel')
    .map((r) => r.value as unknown as WheelSpinResult)
    .find((r) => r.outcome.kind === 'diamonds')!;
  const spin = async (cards: unknown) => {
    rpc.mockResolvedValueOnce({
      data: { ...diamonds, outcome: { ...diamonds.outcome, cards } },
      error: null,
    });
    return service.spinV2({
      clubId: diamonds.club_id,
      commitId: diamonds.fairness.commit_id,
      clientSeed: diamonds.fairness.client_seed,
      entryDiamonds: diamonds.entry_value_diamonds!,
      mode: 'paid',
      ticketId: null,
    });
  };

  it('carries a pending award through to the page', async () => {
    const result = await spin({ award_id: AWARD, risk_diamonds: 100, status: 'pending' });
    expect(result.outcome.cards).toEqual({
      award_id: AWARD,
      risk_diamonds: 100,
      status: 'pending',
    });
  });

  it('keeps a picked award picked, so nothing reopens a finished hand', async () => {
    const result = await spin({ award_id: AWARD, risk_diamonds: 100, status: 'picked' });
    expect(result.outcome.cards?.status).toBe('picked');
  });

  it('is an ordinary Diamonds prize when there is no award, or an unusable one', async () => {
    expect((await spin(undefined)).outcome.cards).toBeUndefined();
    expect((await spin({ award_id: 'nope', risk_diamonds: 100 })).outcome.cards).toBeUndefined();
    expect((await spin({ award_id: AWARD, risk_diamonds: 0 })).outcome.cards).toBeUndefined();
  });
});

describe('a run counts a card pick, not a prize it was never paid', () => {
  const run: WheelRun = { runId: 'run', total: 5, done: 0, prizes: [], games: [], cards: [] };
  const receipt = (outcome: Record<string, unknown>, spinId = SPIN) =>
    ({
      spin_id: spinId,
      outcome: {
        ord: 5,
        kind: 'diamonds',
        amount: 0,
        label: 'Diamonds',
        value_chips: 0,
        ...outcome,
      },
    }) as unknown as WheelSpinResult;
  const title = (prize: WheelSpinResult['outcome']) => prize.label;

  it('puts a sealed Diamonds award on the card queue and leaves the prize list alone', () => {
    const next = tallyWheelRun(
      run,
      receipt({ cards: { award_id: AWARD, risk_diamonds: 100, status: 'pending' } }),
      title
    );
    expect(next.done).toBe(1);
    expect(next.prizes).toEqual([]);
    expect(next.cards).toEqual([{ id: AWARD, spin_id: SPIN, risk_diamonds: 100 }]);
    expect(wheelRunSoFar(next)).toBe('1 Card Pick');
    const two = tallyWheelRun(
      next,
      receipt(
        { cards: { award_id: AWARD, risk_diamonds: 250, status: 'pending' } },
        '10000000-0000-0000-0000-000000000043'
      ),
      title
    );
    expect(two.cards).toHaveLength(2);
    expect(wheelRunSoFar(two)).toBe('2 Card Picks');
  });

  it('still tallies a Diamonds prize that was paid outright, as it always did', () => {
    const next = tallyWheelRun(run, receipt({ amount: 300, value_chips: 3 }), title);
    expect(next.cards).toEqual([]);
    expect(next.prizes).toEqual([
      { spinId: SPIN, kind: 'diamonds', title: 'Diamonds', valueChips: 3, upgraded: false },
    ]);
    expect(wheelRunSoFar(next)).toBe('1 Diamond Prize');
  });

  it('reads a picked award as a finished one, not as another pick to make', () => {
    const next = tallyWheelRun(
      run,
      receipt({
        amount: 300,
        value_chips: 3,
        cards: { award_id: AWARD, risk_diamonds: 100, status: 'picked' },
      }),
      title
    );
    expect(next.cards).toEqual([]);
    expect(next.prizes).toHaveLength(1);
  });
});
