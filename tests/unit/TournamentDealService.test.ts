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
  parseTournamentDealReview,
  getTournamentDealReview,
  requestTournamentDealReview,
  cancelTournamentDealReview,
  type TournamentDealReviewState,
} from '../../src/services/TournamentDealService';
const actor = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const event = '33333333-3333-4333-8333-333333333333';
const proposal = '44444444-4444-4444-8444-444444444444';
const reviewId = '55555555-5555-4555-8555-555555555555';
const expiresAt = '2026-09-10T05:00:00+00:00';
function reviewPayload(state = 'reviewing') {
  return {
    ok: true,
    actor_id: actor,
    tournament_id: event,
    state,
    review_id: state === 'none' ? null : reviewId,
    expires_at: state === 'none' ? null : expiresAt,
    proposal_id: state === 'reviewing' ? proposal : null,
    revision: state === 'reviewing' ? 'a'.repeat(64) : null,
  };
}
function review(): TournamentDealReviewState {
  return parseTournamentDealReview(reviewPayload(), event, actor);
}
function payload() {
  return {
    ok: true,
    actor_id: actor,
    tournament_id: event,
    review_id: reviewId,
    expires_at: expiresAt,
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
    const result = await getTournamentDealProposal(event, actor, review());
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
    expect(() =>
      parseTournamentDealProposal({ ...payload(), ...patch }, event, actor, review())
    ).toThrow();
  });
  it('rejects duplicate participants and malformed share amounts', () => {
    const raw = payload();
    raw.shares[1].user_id = actor;
    expect(() => parseTournamentDealProposal(raw, event, actor, review())).toThrow();
    raw.shares[1].user_id = other;
    raw.shares[1].amount_cents = 'NaN';
    expect(() => parseTournamentDealProposal(raw, event, actor, review())).toThrow();
  });
  it.each(['0', '0.00', '-1', 'NaN', 'Infinity', '1e3'])(
    'rejects an invalid or nonpositive stack %s',
    (chips) => {
      const raw = payload();
      raw.shares[0].chips = chips;
      expect(() => parseTournamentDealProposal(raw, event, actor, review())).toThrow();
    }
  );
  it('refuses a zero award even when the totals agree', () => {
    const raw = payload();
    raw.shares[0].amount_cents = '0';
    raw.deal_cents = '3500';
    expect(() => parseTournamentDealProposal(raw, event, actor, review())).toThrow();
  });
  it('verifies the exact share sum beyond the safe floating-point range', () => {
    const raw = payload();
    raw.shares[0].amount_cents = '900719925474099301';
    raw.pool_cents = '900719925474102801';
    raw.deal_cents = raw.pool_cents;
    expect(parseTournamentDealProposal(raw, event, actor, review()).dealCents).toBe(raw.deal_cents);
    raw.deal_cents = '900719925474102800';
    expect(() => parseTournamentDealProposal(raw, event, actor, review())).toThrow();
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
    await expect(getTournamentDealProposal(event, actor, review())).rejects.toThrow(
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
    await castTournamentDealVote(parseTournamentDealProposal(payload(), event, actor, review()));
    expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith('fn_cast_tournament_deal_vote', {
      p_tournament_id: event,
      p_proposal_id: proposal,
      p_expected_actor_id: actor,
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
        castTournamentDealVote(parseTournamentDealProposal(payload(), event, actor, review()))
      ).rejects.toThrow();
    }
  );
  it('does not submit a vote after the auth account changes', async () => {
    mocks.auth.mockResolvedValue({ data: { user: { id: other } }, error: null });
    await expect(
      castTournamentDealVote(parseTournamentDealProposal(payload(), event, actor, review()))
    ).rejects.toThrow('Your Account Changed');
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it('returns stale-plan refusal without submitting a replacement vote', async () => {
    mocks.rpc.mockResolvedValue({ data: { ok: false, reason: 'proposal_stale' }, error: null });
    await expect(
      castTournamentDealVote(parseTournamentDealProposal(payload(), event, actor, review()))
    ).rejects.toThrow('This Split Changed');
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
  });
});
describe('Explicit bounded deal review lifecycle', () => {
  it('reads an idle review without requesting a pause or proposal', async () => {
    mocks.rpc.mockResolvedValue({ data: reviewPayload('none'), error: null });
    expect((await getTournamentDealReview(event, actor)).state).toBe('none');
    expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith('fn_get_tournament_deal_review', {
      p_tournament_id: event,
    });
  });
  it('loads exact shares only after a server-confirmed reviewing state', async () => {
    mocks.rpc
      .mockResolvedValueOnce({ data: reviewPayload(), error: null })
      .mockResolvedValueOnce({ data: payload(), error: null });
    const result = await getTournamentDealReview(event, actor);
    expect(result.proposal?.reviewId).toBe(reviewId);
    expect(result.proposal?.expiresAt).toBe(expiresAt);
    expect(mocks.rpc).toHaveBeenCalledTimes(2);
  });
  it.each(['requested', 'completed', 'cancelled', 'expired'])(
    'never retrieves or offers a proposal for %s',
    async (state) => {
      mocks.rpc.mockResolvedValue({ data: reviewPayload(state), error: null });
      expect((await getTournamentDealReview(event, actor)).proposal).toBeNull();
      expect(mocks.rpc).toHaveBeenCalledTimes(1);
    }
  );
  it.each([
    ['wrong actor', { actor_id: other }],
    ['wrong tournament', { tournament_id: other }],
    ['unknown state', { state: 'waiting' }],
    ['missing review identity', { review_id: null }],
    ['invalid deadline', { expires_at: 'tomorrow' }],
    ['missing proposal identity', { proposal_id: null }],
    ['invalid revision', { revision: 'a' }],
  ])('rejects %s in review metadata', (_name, patch) => {
    expect(() =>
      parseTournamentDealReview({ ...reviewPayload(), ...patch }, event, actor)
    ).toThrow();
  });
  it.each([
    ['review_id', '66666666-6666-4666-8666-666666666666'],
    ['expires_at', '2026-09-10T05:01:00+00:00'],
  ])('rejects a proposal with different %s from the locked review', (field, value) => {
    expect(() =>
      parseTournamentDealProposal({ ...payload(), [field]: value }, event, actor, review())
    ).toThrow();
  });
  it('requests only on an explicit call and verifies the active review response', async () => {
    mocks.rpc.mockResolvedValue({ data: reviewPayload('requested'), error: null });
    await requestTournamentDealReview(event, actor);
    expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith('fn_request_tournament_deal_review', {
      p_tournament_id: event,
      p_expected_actor_id: actor,
    });
  });
  it('cancels only the displayed review identity', async () => {
    mocks.rpc.mockResolvedValue({ data: reviewPayload('cancelled'), error: null });
    await cancelTournamentDealReview(review());
    expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith('fn_cancel_tournament_deal_review', {
      p_tournament_id: event,
      p_review_id: reviewId,
      p_expected_actor_id: actor,
    });
  });
  it('refuses cancellation acknowledgment for a different review', async () => {
    mocks.rpc.mockResolvedValue({
      data: { ...reviewPayload('cancelled'), review_id: other },
      error: null,
    });
    await expect(cancelTournamentDealReview(review())).rejects.toThrow();
  });
  it.each(['request', 'cancel'])(
    'refuses %s after the authenticated actor changes',
    async (action) => {
      mocks.auth.mockResolvedValue({ data: { user: { id: other } }, error: null });
      await expect(
        action === 'request'
          ? requestTournamentDealReview(event, actor)
          : cancelTournamentDealReview(review())
      ).rejects.toThrow('Your Account Changed');
      expect(mocks.rpc).not.toHaveBeenCalled();
    }
  );
});

describe('Closed review cancellation readback', () => {
  it.each(['completed', 'expired'])(
    'accepts authoritative %s without replacing review identity',
    async (state) => {
      mocks.rpc.mockResolvedValue({ data: reviewPayload(state), error: null });
      await cancelTournamentDealReview(review());
      expect(mocks.rpc).toHaveBeenCalledTimes(1);
    }
  );
});

describe('Review mutation actor identity across token acquisition', () => {
  it.each(['request', 'cancel', 'vote'])(
    'binds the displayed actor before %s can record a side effect',
    async (action) => {
      let tokenActor = actor;
      const recorded: string[] = [];
      mocks.auth.mockImplementation(async () => {
        const checked = tokenActor;
        tokenActor = other;
        return { data: { user: { id: checked } }, error: null };
      });
      mocks.rpc.mockImplementation(async (_name, args: Record<string, unknown>) => {
        // The old contract accepts its current authenticated actor. The new expected-actor
        // input lets the server refuse before writing, even after client preflight succeeded.
        if ('p_expected_actor_id' in args && args.p_expected_actor_id !== tokenActor)
          return { data: { ok: false, reason: 'actor_mismatch' }, error: null };
        recorded.push(tokenActor);
        return {
          data:
            action === 'vote'
              ? {
                  ok: true,
                  actor_id: tokenActor,
                  proposal_id: proposal,
                  revision: 'a'.repeat(64),
                  voted: true,
                  already: false,
                }
              : {
                  ...reviewPayload(action === 'request' ? 'requested' : 'cancelled'),
                  actor_id: tokenActor,
                },
          error: null,
        };
      });
      const run =
        action === 'request'
          ? requestTournamentDealReview(event, actor)
          : action === 'cancel'
            ? cancelTournamentDealReview(review())
            : castTournamentDealVote(
                parseTournamentDealProposal(payload(), event, actor, review())
              );
      await expect(run).rejects.toThrow();
      expect(recorded).toEqual([]);
      expect(mocks.rpc.mock.calls[0][1].p_expected_actor_id).toBe(actor);
    }
  );
});
