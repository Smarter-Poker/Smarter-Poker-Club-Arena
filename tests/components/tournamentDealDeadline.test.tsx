import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ auth: vi.fn(), fetch: vi.fn(), report: vi.fn() }));
vi.mock('../../src/lib/supabase', async () => {
  const { PostgrestClient } = await import('@supabase/postgrest-js');
  return {
    getAuthUser: mocks.auth,
    supabase: new PostgrestClient('https://deal-test.invalid/rest/v1', { fetch: mocks.fetch }),
  };
});
vi.mock('../../src/utils/errorReporter', () => ({ reportError: mocks.report }));
import TournamentDealReview from '../../src/components/tournament/TournamentDealReview';
import { DEFAULT_REQUEST_DEADLINE_MS } from '../../src/utils/requestDeadline';

const actor = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const event = '33333333-3333-4333-8333-333333333333';
const proposalId = '44444444-4444-4444-8444-444444444444';
const reviewId = '55555555-5555-4555-8555-555555555555';
const expiresAt = '2030-01-01T00:00:00Z';
let voted = false;
const heldBodies: ReadableStreamDefaultController<Uint8Array>[] = [];
function response(value: unknown): Response {
  return new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
}
function review() {
  return {
    ok: true,
    actor_id: actor,
    tournament_id: event,
    state: 'reviewing',
    review_id: reviewId,
    expires_at: expiresAt,
    proposal_id: proposalId,
    revision: 'a'.repeat(64),
  };
}
function normalFetch(input: RequestInfo | URL): Response {
  if (String(input).endsWith('/fn_get_tournament_deal_review')) return response(review());
  if (String(input).endsWith('/fn_get_tournament_deal_proposal'))
    return response({
      ...review(),
      state: 'ready',
      pool_cents: '15000',
      deal_cents: '10000',
      voter_ids: voted ? [actor] : [],
      shares: [
        { user_id: actor, place: 1, chips: '6000', amount_cents: '6000' },
        { user_id: other, place: 2, chips: '4000', amount_cents: '4000' },
      ],
    });
  throw new Error('Unexpected RPC In Deadline Test');
}
function stalledBody(): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        heldBodies.push(controller);
      },
    })
  );
}
function voteCalls() {
  return mocks.fetch.mock.calls.filter(([url]) =>
    String(url).endsWith('/fn_cast_tournament_deal_vote')
  );
}
async function openReview() {
  let page!: ReturnType<typeof render>;
  await act(async () => {
    page = render(<TournamentDealReview tournamentId={event} actorId={actor} players={[]} />);
  });
  expect(screen.getByRole('button', { name: 'Agree To This Split' })).toBeTruthy();
  return page;
}
async function advanceDeadline() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(DEFAULT_REQUEST_DEADLINE_MS + 1);
  });
}
beforeEach(() => {
  vi.useFakeTimers();
  voted = false;
  mocks.auth.mockReset().mockResolvedValue({ data: { user: { id: actor } }, error: null });
  mocks.fetch.mockReset().mockImplementation(async (input) => normalFetch(input));
  mocks.report.mockClear();
});
afterEach(async () => {
  cleanup();
  for (const body of heldBodies.splice(0)) body.close();
  await Promise.resolve();
  vi.useRealTimers();
});

describe('Deal review deadlines through the actual PostgREST builder and screen', () => {
  it('recovers a stuck auth preflight and never sends a late mutation when auth eventually returns', async () => {
    let resolveAuth!: (value: unknown) => void;
    mocks.auth.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveAuth = resolve;
        })
    );
    await openReview();
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Agree To This Split' }))
    );
    expect(screen.getByRole('button', { name: 'Recording Your Vote...' })).toBeTruthy();
    await advanceDeadline();
    expect(screen.queryByRole('button', { name: 'Recording Your Vote...' })).toBeNull();
    expect(
      (screen.getByRole('button', { name: 'Agree To This Split' }) as HTMLButtonElement).disabled
    ).toBe(false);
    expect(voteCalls()).toHaveLength(0);
    await act(async () => resolveAuth({ data: { user: { id: actor } }, error: null }));
    expect(voteCalls()).toHaveLength(0);
  });
  it.each(['fetch', 'body'])(
    'recovers a never-resolving mutation %s by reading consent without resubmission',
    async (stage) => {
      let requestSignal: AbortSignal | undefined;
      mocks.fetch.mockImplementation(async (input, init) => {
        if (String(input).endsWith('/fn_cast_tournament_deal_vote')) {
          requestSignal = init.signal;
          voted = true;
          return stage === 'fetch' ? new Promise<Response>(() => {}) : stalledBody();
        }
        return normalFetch(input);
      });
      await openReview();
      await act(async () =>
        fireEvent.click(screen.getByRole('button', { name: 'Agree To This Split' }))
      );
      expect(screen.getByRole('button', { name: 'Recording Your Vote...' })).toBeTruthy();
      await advanceDeadline();
      expect(requestSignal?.aborted).toBe(true);
      expect(screen.getByText('Your Vote Is Recorded For This Split.')).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Recording Your Vote...' })).toBeNull();
      expect(voteCalls()).toHaveLength(1);
    }
  );
  it('bounds a stalled read body and offers an explicit read retry', async () => {
    mocks.fetch.mockImplementation(async () => stalledBody());
    await act(async () => {
      render(<TournamentDealReview tournamentId={event} actorId={actor} players={[]} />);
    });
    await advanceDeadline();
    expect(screen.getByRole('button', { name: 'Retry Deal Review' })).toBeTruthy();
    expect(mocks.auth).not.toHaveBeenCalled();
    expect(voteCalls()).toHaveLength(0);
  });
  it('cancels pending auth on unmount and never starts its mutation afterward', async () => {
    let resolveAuth!: (value: unknown) => void;
    mocks.auth.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveAuth = resolve;
        })
    );
    const page = await openReview();
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Agree To This Split' }))
    );
    page.unmount();
    await act(async () => resolveAuth({ data: { user: { id: actor } }, error: null }));
    expect(voteCalls()).toHaveLength(0);
  });
});
