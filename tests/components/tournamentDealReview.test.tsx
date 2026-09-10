import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ get: vi.fn(), vote: vi.fn(), report: vi.fn() }));
vi.mock('../../src/services/TournamentDealService', async (original) => ({
  ...(await original<typeof import('../../src/services/TournamentDealService')>()),
  getTournamentDealProposal: mocks.get,
  castTournamentDealVote: mocks.vote,
}));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: mocks.report }));
import TournamentDealReview from '../../src/components/tournament/TournamentDealReview';
import type { TournamentDealProposal } from '../../src/services/TournamentDealService';
const actor = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const event = '33333333-3333-4333-8333-333333333333';
function proposal(id = 'original', voters: string[] = []): TournamentDealProposal {
  return {
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
  mocks.get.mockReset().mockResolvedValue(proposal());
  mocks.vote.mockReset().mockResolvedValue(undefined);
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
    expect(mocks.vote).toHaveBeenCalledWith(proposal());
    mocks.get.mockResolvedValue(proposal('original', [actor]));
    await act(async () => finish());
    await screen.findByText('Your Vote Is Recorded For This Split.');
  });
  it('keeps unavailable authority explicit and never offers an unbound vote', async () => {
    mocks.get.mockRejectedValue(new Error('Deal Review Is Not Available Yet. Please Retry.'));
    mount();
    await screen.findByRole('alert');
    expect(screen.queryByRole('button', { name: 'Agree To This Split' })).toBeNull();
    mocks.get.mockResolvedValue(proposal());
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
    mocks.get.mockResolvedValue(proposal('replacement'));
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
    expect(mocks.vote).toHaveBeenLastCalledWith(proposal('replacement'));
  });
  it('resolves an ambiguous response by reading consent without resubmitting the vote', async () => {
    mocks.vote.mockRejectedValue(new Error('Response Lost'));
    mount();
    await screen.findByRole('button', { name: 'Agree To This Split' });
    mocks.get.mockResolvedValue(proposal('original', [actor]));
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Agree To This Split' }))
    );
    await screen.findByText('Your Vote Is Recorded For This Split.');
    expect(mocks.vote).toHaveBeenCalledTimes(1);
  });
  it('does not claim a successful old vote approves a newly refreshed split', async () => {
    mount();
    await screen.findByRole('button', { name: 'Agree To This Split' });
    mocks.get.mockResolvedValue(proposal('replacement'));
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
      mocks.get.mockResolvedValue(next);
      page.rerender(<TournamentDealReview tournamentId={other} actorId={other} players={[]} />);
      await screen.findByRole('button', { name: 'Agree To This Split' });
      await act(async () =>
        outcome === 'resolve' ? resolve() : reject(new Error('Old Vote Failed'))
      );
      expect(mocks.get).toHaveBeenCalledTimes(2);
      expect(mocks.get).toHaveBeenLastCalledWith(other, other);
      expect(screen.queryByText('Your Vote Was Recorded For The Reviewed Split.')).toBeNull();
      expect(screen.queryByText('Old Vote Failed')).toBeNull();
      mocks.vote.mockResolvedValue(undefined);
      await act(async () =>
        fireEvent.click(screen.getByRole('button', { name: 'Agree To This Split' }))
      );
      expect(mocks.vote).toHaveBeenLastCalledWith(next);
    }
  );
  it('ignores a getter that completes after unmount', async () => {
    let resolve!: (value: TournamentDealProposal) => void;
    mocks.get.mockImplementation(
      () =>
        new Promise<TournamentDealProposal>((done) => {
          resolve = done;
        })
    );
    const page = mount();
    page.unmount();
    await act(async () => resolve(proposal()));
    expect(screen.queryByRole('button', { name: 'Agree To This Split' })).toBeNull();
    expect(mocks.vote).not.toHaveBeenCalled();
  });
});
