/**
 * THE THREE-CARD GAME'S CLIENT, CHECKED AGAINST THE SERVER THAT PAYS IT.
 *
 * Production's wheel v4 pays ord 5 by sealing three cards worth half, double
 * and triple the diamonds risked and writing a PENDING row; nothing is paid
 * until the player picks one. Every value below comes out of
 * tests/sql/diamond-wheel-v4-draw-and-cards.sql, which runs the real
 * fn_wheel_spin_v2 and fn_wheel_diamond_cards_pick in the isolated accounting
 * fixture, so the door this file opens is measured against what Postgres
 * actually answers rather than against an idea of it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import fixture from '../fixtures/diamond-spins/wheel-v4-postgres-receipts.json';
const rpc = vi.hoisted(() => vi.fn());
vi.mock('../../src/lib/supabase', () => ({ supabase: { rpc } }));
import service, {
  CARD_NOT_PICKED,
  clearWheelPendingCard,
  readWheelPendingCard,
  saveWheelPendingCard,
  type WheelCardPick,
  type WheelSpinResult,
} from '../../src/services/DiamondWheelService';
import { assertWheelCardPick } from '../../src/utils/wheelAward';
import { verifyWheelCardPick } from '../../src/utils/wheelFairness';

type Entry = { kind: string; stake: number; value: unknown };
const records = fixture.records as unknown as Entry[];
const by = (kind: string) =>
  JSON.parse(JSON.stringify(records.find((r) => r.kind === kind)!.value));
const PICK = () => by('wheel-v4-card-pick') as WheelCardPick;
const SPIN = () => by('wheel-v4-cards') as WheelSpinResult;
const AWARD = (PICK() as WheelCardPick).award_id;

beforeEach(() => {
  rpc.mockReset();
  localStorage.clear();
});

describe('the pick door', () => {
  it('sends the award and the card the player chose, and answers with the reveal', async () => {
    const body = PICK();
    rpc.mockResolvedValueOnce({ data: body, error: null });
    const answer = await service.pickCard(AWARD, 2);
    expect(rpc).toHaveBeenCalledWith('fn_wheel_diamond_cards_pick', {
      p_award_id: AWARD,
      p_card: 2,
    });
    expect(answer.ok).toBe(true);
    if (!answer.ok) throw new Error('unreachable');
    expect(answer.pick.paid_diamonds).toBe(300);
    expect(answer.pick.cards).toEqual([50, 300, 200]);
    expect(answer.pick.fairness.domain).toBe('wheel-v4-cards');
    expect(answer.pick.balances.diamonds).toBe(90200);
  });

  it('accepts the replay of a pick another tab already made, whatever card this send carried', async () => {
    rpc.mockResolvedValueOnce({ data: by('wheel-v4-card-pick-replay'), error: null });
    const answer = await service.pickCard(AWARD, 1);
    expect(answer.ok).toBe(true);
    if (!answer.ok) throw new Error('unreachable');
    expect(answer.pick.replayed).toBe(true);
    expect(answer.pick.picked).toBe(2);
    expect(answer.pick.paid_diamonds).toBe(300);
  });

  it('refuses a reveal that is not this award, and never pays against it', async () => {
    const body = PICK();
    body.award_id = '00000000-0000-4000-8000-000000000999';
    rpc.mockResolvedValueOnce({ data: body, error: null });
    await expect(service.pickCard(AWARD, 2)).rejects.toThrow(/Could Not Be Confirmed/);
  });

  it('refuses a reveal whose paid diamonds are not the card the player turned over', async () => {
    const body = PICK();
    body.paid_diamonds = 3000;
    rpc.mockResolvedValueOnce({ data: body, error: null });
    await expect(service.pickCard(AWARD, 2)).rejects.toThrow(/Could Not Be Confirmed/);
  });

  it('refuses a reveal whose three values are not half, double and triple the risk', async () => {
    const body = PICK();
    body.cards = [50, 300, 900];
    rpc.mockResolvedValueOnce({ data: body, error: null });
    await expect(service.pickCard(AWARD, 2)).rejects.toThrow(/Could Not Be Confirmed/);
  });

  it('refuses a reveal that answers a card the player did not choose', async () => {
    const body = PICK();
    body.replayed = false;
    rpc.mockResolvedValueOnce({ data: body, error: null });
    await expect(service.pickCard(AWARD, 3)).rejects.toThrow(/Could Not Be Confirmed/);
  });

  it('hands back a refusal the database answered, without inventing a receipt for it', async () => {
    rpc.mockResolvedValueOnce({
      data: { ok: false, error: 'That Card Game Belongs To Another Player' },
      error: null,
    });
    const answer = await service.pickCard(AWARD, 2);
    expect(answer).toEqual({ ok: false, error: 'That Card Game Belongs To Another Player' });
  });

  it('throws a lost answer so the saved pick is sent again, and refuses after the budget', async () => {
    rpc.mockResolvedValue({ data: null, error: new Error('network') });
    await expect(service.pickCard(AWARD, 2)).rejects.toThrow();
    rpc.mockReset();
    rpc.mockResolvedValue({ data: null, error: { code: '40001' } });
    await expect(service.pickCard(AWARD, 2)).rejects.toMatchObject({ code: '40001' });
    await expect(service.pickCard(AWARD, 2)).rejects.toMatchObject({ code: '40001' });
    await expect(service.pickCard(AWARD, 2)).resolves.toEqual({
      ok: false,
      error: CARD_NOT_PICKED,
    });
  });

  it('refuses at once when the database answered with a code that will not change', async () => {
    rpc.mockResolvedValue({ data: null, error: { code: '42883' } });
    await expect(service.pickCard(AWARD, 2)).resolves.toEqual({
      ok: false,
      error: CARD_NOT_PICKED,
    });
  });
});

describe('the pending card the server remembers', () => {
  it('carries an unpicked card off a state read, as its own award', async () => {
    rpc.mockResolvedValueOnce({ data: by('wheel-v4-run-state'), error: null });
    const state = await service.getStateV2('d1000000-0000-4000-8000-000000000003', 100);
    expect(state.pending_cards).toHaveLength(1);
    expect(state.pending_cards![0].status).toBe('pending');
    expect(state.pending_cards![0].risk_diamonds).toBe(100);
    expect(state.pending_cards![0].award_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
  });

  it('carries it off a run close as well, so ending a run never strands one', async () => {
    const ended = by('wheel-v4-run-end');
    rpc.mockResolvedValueOnce({ data: ended, error: null });
    const closed = await service.runEnd(ended.run_id);
    expect(closed.ok).toBe(true);
    expect(closed.pending_cards).toHaveLength(1);
    expect(closed.pending_cards[0].risk_diamonds).toBe(100);
  });

  it('drops a listed card this client cannot act on rather than showing a broken one', async () => {
    const state = by('wheel-v4-run-state');
    state.pending_cards = [{ id: 'not-a-uuid', status: 'pending', risk_diamonds: 100 }];
    rpc.mockResolvedValueOnce({ data: state, error: null });
    const read = await service.getStateV2('d1000000-0000-4000-8000-000000000003', 100);
    expect(read.pending_cards).toEqual([]);
  });

  it('is the same award the spin itself named', () => {
    const spin = SPIN();
    expect(spin.outcome.cards).toEqual({
      award_id: AWARD,
      risk_diamonds: 100,
      status: 'pending',
    });
  });
});

describe('the saved pick', () => {
  const saved = { userId: 'player', clubId: 'club', awardId: AWARD, card: 2 as const };

  it('survives a reload and comes back with the same award and card', () => {
    saveWheelPendingCard(saved);
    expect(readWheelPendingCard('player', 'club')).toEqual(saved);
  });

  it('belongs to one player at one club, and to nobody else', () => {
    saveWheelPendingCard(saved);
    expect(readWheelPendingCard('someone-else', 'club')).toBeNull();
    expect(readWheelPendingCard('player', 'another-club')).toBeNull();
  });

  it('is dropped when it cannot be read back, rather than replaying a shape this build cannot send', () => {
    saveWheelPendingCard(saved);
    localStorage.setItem('diamond-wheel-card:v1:player:club', '{"card":9}');
    expect(readWheelPendingCard('player', 'club')).toBeNull();
    expect(localStorage.getItem('diamond-wheel-card:v1:player:club')).toBeNull();
  });

  it('is cleared only by the pick that owns it', () => {
    saveWheelPendingCard(saved);
    clearWheelPendingCard({ ...saved, awardId: '00000000-0000-4000-8000-000000000999' });
    expect(readWheelPendingCard('player', 'club')).toEqual(saved);
    clearWheelPendingCard(saved);
    expect(readWheelPendingCard('player', 'club')).toBeNull();
  });
});

describe('the seal the player can check', () => {
  it('recomputes the order and the prize from the revealed seed', async () => {
    const verdict = await verifyWheelCardPick(PICK());
    expect(verdict.fair).toBe(true);
    expect(verdict.computedPermutation).toBe(1);
    expect(verdict.computedCards).toEqual([50, 300, 200]);
  });

  it('fails when the order the server published is not the one its own roll gives', async () => {
    const tampered = PICK();
    tampered.fairness.permutation = 4;
    const verdict = await verifyWheelCardPick(tampered);
    expect(verdict.permutationMatches).toBe(false);
    expect(verdict.fair).toBe(false);
  });

  it('holds the validator and the verifier to the same body', () => {
    const pick = PICK();
    expect(() => assertWheelCardPick(pick, pick.award_id, pick.picked)).not.toThrow();
  });
});
