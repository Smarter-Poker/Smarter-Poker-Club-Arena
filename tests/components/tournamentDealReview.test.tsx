import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  vote: vi.fn(),
  legacyVote: vi.fn(),
  request: vi.fn(),
  cancel: vi.fn(),
  report: vi.fn(),
}));
vi.mock('../../src/services/TournamentDealService', async (original) => ({
  ...(await original<typeof import('../../src/services/TournamentDealService')>()),
  getTournamentDealReview: mocks.get,
  requestTournamentDealReview: mocks.request,
  cancelTournamentDealReview: mocks.cancel,
  castTournamentDealVote: mocks.vote,
  castLegacyTournamentDealVote: mocks.legacyVote,
}));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: mocks.report }));
import TournamentDealReview from '../../src/components/tournament/TournamentDealReview';
import type {
  TournamentDealProposal,
  TournamentDealReviewState,
  TournamentDealReviewPhase,
} from '../../src/services/TournamentDealService';
const actor = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const event = '33333333-3333-4333-8333-333333333333';
function proposal(id = 'original', voters: string[] = []): TournamentDealProposal {
  return {
    reviewId: '55555555-5555-4555-8555-555555555555',
    expiresAt: '2026-09-10T05:00:00+00:00',
    actorId: actor,
    tournamentId: event,
    proposalId: id,
    revision: 'a'.repeat(64),
    shares: [
      { userId: actor, place: 1, chips: '6500', amountCents: '6500' },
      { userId: other, place: 2, chips: '3500', amountCents: '3500' },
    ],
    poolCents: '15000',
    dealCents: '10000',
    voterIds: voters,
  };
}
function reviewState(
  state: TournamentDealReviewPhase = 'reviewing',
  p = proposal()
): TournamentDealReviewState {
  return {
    actorId: p.actorId,
    tournamentId: p.tournamentId,
    state,
    reviewId: state === 'none' ? null : p.reviewId,
    expiresAt: state === 'none' ? null : p.expiresAt,
    proposalId: state === 'reviewing' ? p.proposalId : null,
    revision: state === 'reviewing' ? p.revision : null,
    proposal: state === 'reviewing' ? p : null,
  };
}
function mount() {
  return render(
    <TournamentDealReview
      tournamentId={event}
      actorId={actor}
      players={[
        { user_id: actor, username: 'Alice' },
        { user_id: other, username: 'Bob' },
      ]}
    />
  );
}
beforeEach(() => {
  mocks.get.mockReset().mockResolvedValue(reviewState());
  mocks.request.mockReset().mockResolvedValue(undefined);
  mocks.cancel.mockReset().mockResolvedValue(undefined);
  mocks.vote.mockReset().mockResolvedValue(undefined);
  mocks.legacyVote.mockReset().mockResolvedValue(undefined);
  mocks.report.mockClear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('Reviewed final-table deal consent', () => {
  it('shows every server payment and both distinct pools before agreement', async () => {
    mount();
    await screen.findByRole('button', { name: 'Agree To This Split' });
    expect(screen.getByText('Alice (You)')).toBeTruthy();
    expect(screen.getByText('Bob')).toBeTruthy();
    expect(screen.getByText('65')).toBeTruthy();
    expect(screen.getByText('35')).toBeTruthy();
    expect(screen.getByText('150')).toBeTruthy();
    expect(screen.getByText('100')).toBeTruthy();
    expect(mocks.vote).not.toHaveBeenCalled();
  });
  it('single-flights same-frame activation and submits the exact displayed proposal', async () => {
    let finish!: () => void;
    mocks.vote.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        })
    );
    mount();
    const button = await screen.findByRole('button', { name: 'Agree To This Split' });
    act(() => {
      button.click();
      button.click();
    });
    expect(mocks.vote).toHaveBeenCalledTimes(1);
    expect(mocks.vote).toHaveBeenCalledWith(proposal(), expect.any(AbortSignal));
    mocks.get.mockResolvedValue(reviewState('reviewing', proposal('original', [actor])));
    await act(async () => finish());
    await screen.findByText('Your Vote Is Recorded For This Split.');
  });
  it('keeps unavailable authority explicit and never offers an unbound vote', async () => {
    mocks.get.mockRejectedValue(new Error('Deal Review Is Not Available Yet. Please Retry.'));
    mount();
    await screen.findByRole('alert');
    expect(screen.queryByRole('button', { name: 'Agree To This Split' })).toBeNull();
    mocks.get.mockResolvedValue(reviewState());
    fireEvent.click(screen.getByRole('button', { name: 'Retry Deal Review' }));
    await screen.findByRole('button', { name: 'Agree To This Split' });
    expect(mocks.vote).not.toHaveBeenCalled();
  });
  it('refreshes a stale split but requires another click for the replacement', async () => {
    mocks.vote.mockRejectedValue(
      new Error('This Split Changed. Review The Latest Split Before Voting Again.')
    );
    mount();
    await screen.findByRole('button', { name: 'Agree To This Split' });
    mocks.get.mockResolvedValue(reviewState('reviewing', proposal('replacement')));
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Agree To This Split' }))
    );
    await screen.findByText('The Split Changed. Review The Latest Split Before Voting Again.');
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: 'Agree To This Split' }) as HTMLButtonElement).disabled
      ).toBe(false)
    );
    expect(mocks.vote).toHaveBeenCalledTimes(1);
    mocks.vote.mockResolvedValue(undefined);
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Agree To This Split' }))
    );
    expect(mocks.vote).toHaveBeenLastCalledWith(proposal('replacement'), expect.any(AbortSignal));
  });
  it('resolves an ambiguous response by reading consent without resubmitting the vote', async () => {
    mocks.vote.mockRejectedValue(new Error('Response Lost'));
    mount();
    await screen.findByRole('button', { name: 'Agree To This Split' });
    mocks.get.mockResolvedValue(reviewState('reviewing', proposal('original', [actor])));
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Agree To This Split' }))
    );
    await screen.findByText('Your Vote Is Recorded For This Split.');
    expect(mocks.vote).toHaveBeenCalledTimes(1);
  });
  it('does not claim a successful old vote approves a newly refreshed split', async () => {
    mount();
    await screen.findByRole('button', { name: 'Agree To This Split' });
    mocks.get.mockResolvedValue(reviewState('reviewing', proposal('replacement')));
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Agree To This Split' }))
    );
    await screen.findByText('The Split Changed. Review The Latest Split Before Voting Again.');
    expect(screen.queryByText('Your Vote Is Recorded For This Split.')).toBeNull();
  });
  it.each(['resolve', 'reject'])(
    'keeps a changed account and tournament isolated from an old vote that will %s',
    async (outcome) => {
      let resolve!: () => void;
      let reject!: (error: Error) => void;
      mocks.vote.mockImplementationOnce(
        () =>
          new Promise<void>((yes, no) => {
            resolve = yes;
            reject = no;
          })
      );
      const page = mount();
      fireEvent.click(await screen.findByRole('button', { name: 'Agree To This Split' }));
      const next = { ...proposal('new-event'), tournamentId: other, actorId: other };
      mocks.get.mockResolvedValue(reviewState('reviewing', next));
      page.rerender(<TournamentDealReview tournamentId={other} actorId={other} players={[]} />);
      await screen.findByRole('button', { name: 'Agree To This Split' });
      await act(async () =>
        outcome === 'resolve' ? resolve() : reject(new Error('Old Vote Failed'))
      );
      expect(mocks.get).toHaveBeenCalledTimes(2);
      expect(mocks.get).toHaveBeenLastCalledWith(other, other, expect.any(AbortSignal));
      expect(screen.queryByText('Your Vote Was Recorded For The Reviewed Split.')).toBeNull();
      expect(screen.queryByText('Old Vote Failed')).toBeNull();
      mocks.vote.mockResolvedValue(undefined);
      await act(async () =>
        fireEvent.click(screen.getByRole('button', { name: 'Agree To This Split' }))
      );
      expect(mocks.vote).toHaveBeenLastCalledWith(next, expect.any(AbortSignal));
    }
  );
  it('ignores a getter that completes after unmount', async () => {
    let resolve!: (value: TournamentDealReviewState) => void;
    mocks.get.mockImplementation(
      () =>
        new Promise<TournamentDealReviewState>((done) => {
          resolve = done;
        })
    );
    const page = mount();
    page.unmount();
    await act(async () => resolve(reviewState()));
    expect(screen.queryByRole('button', { name: 'Agree To This Split' })).toBeNull();
    expect(mocks.vote).not.toHaveBeenCalled();
  });
});
describe('Explicit deal review pause lifecycle', () => {
  it('does not request a pause when the card mounts', async () => {
    mocks.get.mockResolvedValue(reviewState('none'));
    mount();
    await screen.findByRole('button', { name: 'Request Deal Review' });
    expect(mocks.request).not.toHaveBeenCalled();
    expect(mocks.vote).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Agree To This Split' })).toBeNull();
  });
  it('single-flights explicit review requests and waits for the safe hand boundary', async () => {
    mocks.get.mockResolvedValue(reviewState('none'));
    let finish!: () => void;
    mocks.request.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        })
    );
    mount();
    const button = await screen.findByRole('button', { name: 'Request Deal Review' });
    act(() => {
      button.click();
      button.click();
    });
    expect(mocks.request).toHaveBeenCalledExactlyOnceWith(event, actor, expect.any(AbortSignal));
    mocks.get.mockResolvedValue(reviewState('requested'));
    await act(async () => finish());
    await screen.findByText('Waiting For Play To Pause At A Safe Hand Boundary.');
    expect(screen.queryByRole('button', { name: 'Agree To This Split' })).toBeNull();
    expect(screen.queryByText('Proposed Split')).toBeNull();
  });
  it('resolves an ambiguous request by reading without repeating a pause request', async () => {
    mocks.get.mockResolvedValue(reviewState('none'));
    mocks.request.mockRejectedValue(new Error('Response Lost'));
    mount();
    await screen.findByRole('button', { name: 'Request Deal Review' });
    mocks.get.mockResolvedValue(reviewState('requested'));
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Request Deal Review' }))
    );
    await screen.findByText('Waiting For Play To Pause At A Safe Hand Boundary.');
    expect(mocks.request).toHaveBeenCalledTimes(1);
    expect(mocks.vote).not.toHaveBeenCalled();
  });
  it('displays the authoritative deadline without a client timeout changing review state', async () => {
    const past = { ...proposal(), expiresAt: '2000-01-01T00:00:00Z' };
    mocks.get.mockResolvedValue(reviewState('reviewing', past));
    mount();
    await screen.findByRole('button', { name: 'Agree To This Split' });
    expect(document.querySelector('time')?.getAttribute('datetime')).toBe(past.expiresAt);
    expect(
      screen.getByText('Play Is Paused While Remaining Players Review This Split.')
    ).toBeTruthy();
    expect(mocks.cancel).not.toHaveBeenCalled();
  });
  it.each(['cancelled', 'expired', 'completed'] as const)(
    'shows %s without retaining old consent or auto-requesting a new review',
    async (state) => {
      mocks.get.mockResolvedValue(reviewState(state));
      mount();
      await screen.findByRole('button', { name: 'Request Deal Review' });
      expect(screen.queryByRole('button', { name: 'Agree To This Split' })).toBeNull();
      expect(screen.queryByText('Proposed Split')).toBeNull();
      expect(mocks.request).not.toHaveBeenCalled();
      expect(mocks.vote).not.toHaveBeenCalled();
    }
  );
  it('cancels the exact displayed review and reads the closed state before showing a new request', async () => {
    mount();
    await screen.findByRole('button', { name: 'Cancel Deal Review' });
    mocks.get.mockResolvedValue(reviewState('cancelled'));
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Cancel Deal Review' }))
    );
    await screen.findByText('Deal Review Was Cancelled. Play Resumes When The Table Confirms.');
    expect(mocks.cancel).toHaveBeenCalledExactlyOnceWith(reviewState(), expect.any(AbortSignal));
    expect(mocks.request).not.toHaveBeenCalled();
    expect(mocks.vote).not.toHaveBeenCalled();
  });
});

describe('Authoritative review transitions', () => {
  it('observes requested to reviewing to expired without requesting pause or revoting', async () => {
    vi.useFakeTimers();
    mocks.get.mockResolvedValue(reviewState('requested'));
    await act(async () => {
      mount();
    });
    expect(screen.getByText('Waiting For Play To Pause At A Safe Hand Boundary.')).toBeTruthy();
    mocks.get.mockResolvedValue(reviewState());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(screen.getByRole('button', { name: 'Agree To This Split' })).toBeTruthy();
    mocks.get.mockResolvedValue(reviewState('expired'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(screen.queryByRole('button', { name: 'Agree To This Split' })).toBeNull();
    expect(mocks.request).not.toHaveBeenCalled();
    expect(mocks.vote).not.toHaveBeenCalled();
  });
  it('does not claim cancellation won when the server confirms an already completed review', async () => {
    mount();
    await screen.findByRole('button', { name: 'Cancel Deal Review' });
    mocks.get.mockResolvedValue(reviewState('completed'));
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Cancel Deal Review' }))
    );
    expect(
      screen.getByText('Deal Review Is Closed. Check The Tournament Payment Status.')
    ).toBeTruthy();
    expect(screen.queryByText('The Review Cancellation Was Recorded.')).toBeNull();
    expect(mocks.vote).not.toHaveBeenCalled();
  });
});

describe('Deal rollout compatibility on the screen', () => {
  const legacy = (voterIds: string[] = []): TournamentDealReviewState => ({
    ...reviewState('none'),
    state: 'legacy',
    legacyVoterIds: voterIds,
  });
  it('shows and submits the existing vote only for authoritative inactive state', async () => {
    mocks.get.mockResolvedValue(legacy([other]));
    mount();
    const button = await screen.findByRole('button', { name: 'Vote For Deal' });
    expect(screen.getByText('1/2 Votes')).toBeTruthy();
    mocks.get.mockResolvedValue(legacy([actor, other]));
    fireEvent.click(button);
    await screen.findByText('Your Vote Is In.');
    expect(mocks.legacyVote).toHaveBeenCalledExactlyOnceWith(
      legacy([other]),
      expect.any(AbortSignal)
    );
    expect(mocks.vote).not.toHaveBeenCalled();
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it('switches to exact review when activation wins before a legacy vote', async () => {
    mocks.get.mockResolvedValue(legacy());
    mocks.legacyVote.mockRejectedValue(new Error('Deal Review Changed. Refresh Before Voting.'));
    mount();
    const button = await screen.findByRole('button', { name: 'Vote For Deal' });
    mocks.get.mockResolvedValue(reviewState());
    fireEvent.click(button);
    await screen.findByRole('button', { name: 'Agree To This Split' });
    expect(screen.queryByRole('button', { name: 'Vote For Deal' })).toBeNull();
    expect(screen.queryByText('Your Deal Vote Was Recorded.')).toBeNull();
    expect(mocks.vote).not.toHaveBeenCalled();
  });
  it('never restores legacy voting after this context observed active review authority', async () => {
    mount();
    const button = await screen.findByRole('button', { name: 'Agree To This Split' });
    mocks.vote.mockRejectedValue(new Error('Unavailable'));
    mocks.get.mockResolvedValue(legacy());
    fireEvent.click(button);
    await screen.findByRole('alert');
    expect(screen.queryByRole('button', { name: 'Vote For Deal' })).toBeNull();
    expect(mocks.legacyVote).not.toHaveBeenCalled();
  });
  it('never offers legacy votes for an unknown read outcome', async () => {
    mocks.get.mockRejectedValue(new Error('Request deadline exceeded'));
    mount();
    await screen.findByRole('alert');
    expect(screen.queryByRole('button', { name: 'Vote For Deal' })).toBeNull();
    expect(mocks.legacyVote).not.toHaveBeenCalled();
  });
});
