import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ rpc: vi.fn(), auth: vi.fn() }));
vi.mock('../../src/lib/supabase', () => ({
  supabase: { rpc: mocks.rpc },
  getAuthUser: mocks.auth,
}));
import {
  castTournamentDealVote,
  formatDealCents,
  getTournamentDealProposal,
  parseTournamentDealProposal,
} from '../../src/services/TournamentDealService';
const actor = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const event = '33333333-3333-4333-8333-333333333333';
const proposal = '44444444-4444-4444-8444-444444444444';
function payload() {
  return {
    ok: true,
    actor_id: actor,
    tournament_id: event,
    proposal_id: proposal,
    revision: 'a'.repeat(64),
    state: 'ready',
    pool_cents: '15000',
    deal_cents: '10000',
    voter_ids: [],
    shares: [
      { user_id: actor, place: 1, chips: '6500.00', amount_cents: '6500' },
      { user_id: other, place: 2, chips: '3500', amount_cents: '3500' },
    ],
  };
}
beforeEach(() => {
  mocks.rpc.mockReset();
  mocks.auth.mockReset().mockResolvedValue({ data: { user: { id: actor } }, error: null });
});

describe('Exact tournament deal response contract', () => {
  it('reads the exact server allocation, preserving decimal strings and recipients', async () => {
    mocks.rpc.mockResolvedValue({ data: payload(), error: null });
    const result = await getTournamentDealProposal(event, actor);
    expect(mocks.rpc).toHaveBeenCalledWith('fn_get_tournament_deal_proposal', {
      p_tournament_id: event,
    });
    expect(result.shares.map((s) => [s.userId, s.amountCents])).toEqual([
      [actor, '6500'],
      [other, '3500'],
    ]);
    expect(result.dealCents).toBe('10000');
  });
  it.each([
    ['wrong actor', { actor_id: other }],
    ['wrong event', { tournament_id: other }],
    ['missing revision', { revision: null }],
    ['malformed proposal', { proposal_id: 'invented' }],
    ['numeric cents', { deal_cents: 10000 }],
    ['fractional cents', { pool_cents: '15000.5' }],
    ['mismatched share total', { deal_cents: '10001' }],
    ['deal exceeds finalized pool', { pool_cents: '9999' }],
    ['unknown voter', { voter_ids: [proposal] }],
    ['duplicate voter', { voter_ids: [actor, actor] }],
  ])('rejects %s', (_name, patch) => {
    expect(() => parseTournamentDealProposal({ ...payload(), ...patch }, event, actor)).toThrow();
  });
  it('rejects duplicate participants and malformed share amounts', () => {
    const raw = payload();
    raw.shares[1].user_id = actor;
    expect(() => parseTournamentDealProposal(raw, event, actor)).toThrow();
    raw.shares[1].user_id = other;
    raw.shares[1].amount_cents = 'NaN';
    expect(() => parseTournamentDealProposal(raw, event, actor)).toThrow();
  });
  it.each(['0', '0.00', '-1', 'NaN', 'Infinity', '1e3'])(
    'rejects an invalid or nonpositive stack %s',
    (chips) => {
      const raw = payload();
      raw.shares[0].chips = chips;
      expect(() => parseTournamentDealProposal(raw, event, actor)).toThrow();
    }
  );
  it('refuses a zero award even when the totals agree', () => {
    const raw = payload();
    raw.shares[0].amount_cents = '0';
    raw.deal_cents = '3500';
    expect(() => parseTournamentDealProposal(raw, event, actor)).toThrow();
  });
  it('verifies the exact share sum beyond the safe floating-point range', () => {
    const raw = payload();
    raw.shares[0].amount_cents = '900719925474099301';
    raw.pool_cents = '900719925474102801';
    raw.deal_cents = raw.pool_cents;
    expect(parseTournamentDealProposal(raw, event, actor).dealCents).toBe(raw.deal_cents);
    raw.deal_cents = '900719925474102800';
    expect(() => parseTournamentDealProposal(raw, event, actor)).toThrow();
  });
  it('formats server cents exactly beyond the safe floating-point range', () => {
    expect(formatDealCents('900719925474099301')).toBe('9,007,199,254,740,993.01');
    expect(formatDealCents('1')).toBe('0.01');
    expect(formatDealCents('0')).toBe('0');
  });
  it('shows an activation refusal without trying the old voting contract', async () => {
    mocks.rpc.mockResolvedValue({
      data: { ok: false, reason: 'proposal_authority_not_active' },
      error: null,
    });
    await expect(getTournamentDealProposal(event, actor)).rejects.toThrow(
      'Deal Review Is Not Available Yet'
    );
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
  });
});

describe('Exact tournament deal consent', () => {
  it('submits only the reviewed proposal and checks its returned identity', async () => {
    mocks.rpc.mockResolvedValue({
      data: {
        ok: true,
        actor_id: actor,
        proposal_id: proposal,
        revision: 'a'.repeat(64),
        voted: true,
        already: false,
        wake_id: 12,
      },
      error: null,
    });
    await castTournamentDealVote(parseTournamentDealProposal(payload(), event, actor));
    expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith('fn_cast_tournament_deal_vote', {
      p_tournament_id: event,
      p_proposal_id: proposal,
    });
  });
  it.each(['actor_id', 'proposal_id', 'revision'])(
    'rejects a different returned %s',
    async (key) => {
      mocks.rpc.mockResolvedValue({
        data: {
          ok: true,
          actor_id: actor,
          proposal_id: proposal,
          revision: 'a'.repeat(64),
          voted: true,
          already: true,
          [key]: 'wrong',
        },
        error: null,
      });
      await expect(
        castTournamentDealVote(parseTournamentDealProposal(payload(), event, actor))
      ).rejects.toThrow();
    }
  );
  it('does not submit a vote after the auth account changes', async () => {
    mocks.auth.mockResolvedValue({ data: { user: { id: other } }, error: null });
    await expect(
      castTournamentDealVote(parseTournamentDealProposal(payload(), event, actor))
    ).rejects.toThrow('Your Account Changed');
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it('returns stale-plan refusal without submitting a replacement vote', async () => {
    mocks.rpc.mockResolvedValue({ data: { ok: false, reason: 'proposal_stale' }, error: null });
    await expect(
      castTournamentDealVote(parseTournamentDealProposal(payload(), event, actor))
    ).rejects.toThrow('This Split Changed');
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
  });
});
