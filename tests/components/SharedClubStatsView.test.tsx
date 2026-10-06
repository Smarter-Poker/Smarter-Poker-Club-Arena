import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const service = vi.hoisted(() => ({
  listClubs: vi.fn(),
  getOverview: vi.fn(),
  reportError: vi.fn(),
}));

vi.mock('../../src/services/SharedClubStatsService', () => ({
  SharedClubStatsService: {
    listClubs: service.listClubs,
    getOverview: service.getOverview,
  },
}));

vi.mock('../../src/utils/errorReporter', () => ({
  reportError: service.reportError,
}));

import SharedClubStatsView from '../../src/pages/stats/SharedClubStatsView';

const CLUBS = [
  { id: 'club-a', name: 'Alpha Club' },
  { id: 'club-b', name: 'Bravo Club' },
];

const overview = (hands: number) => ({
  overview: {
    hands,
    hands_won: Math.floor(hands / 2),
    bb_per_100: 4.2,
    vpip: 0.25,
    pfr: 0.18,
  },
  tournaments: { entries: 5, cashes: 2, wins: 1 },
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function view(initialClubId: string | null, onClubChange = vi.fn(), targetUserId = 'player-1') {
  return (
    <SharedClubStatsView
      targetUserId={targetUserId}
      asset="chips"
      timezone="America/Chicago"
      rangeKey="30d"
      windowDays={30}
      initialClubId={initialClubId}
      onClubChange={onClubChange}
      onRangeChange={vi.fn()}
    />
  );
}

beforeEach(() => {
  service.listClubs.mockReset();
  service.getOverview.mockReset();
  service.reportError.mockReset();
});

describe('SharedClubStatsView request coordination', () => {
  it('follows A to B to A Back and B Forward URL changes without rewriting valid history', async () => {
    const onClubChange = vi.fn();
    service.listClubs.mockResolvedValue(CLUBS);
    service.getOverview.mockImplementation(async (_targetUserId: string, clubId: string) =>
      overview(clubId === 'club-a' ? 101 : 202)
    );

    const { rerender } = render(view('club-a', onClubChange));

    expect(await screen.findByRole('cell', { name: '101' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Alpha Club' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );

    fireEvent.click(screen.getByRole('button', { name: 'Bravo Club' }));
    rerender(view('club-b', onClubChange));
    expect(await screen.findByRole('cell', { name: '202' })).toBeInTheDocument();
    expect(onClubChange).toHaveBeenCalledWith('club-b');

    onClubChange.mockClear();
    rerender(view('club-a', onClubChange));
    expect(await screen.findByRole('cell', { name: '101' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Alpha Club' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    expect(onClubChange).not.toHaveBeenCalled();

    rerender(view('club-b', onClubChange));
    expect(await screen.findByRole('cell', { name: '202' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Bravo Club' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    expect(onClubChange).not.toHaveBeenCalled();
  });

  it('canonicalizes a missing or invalid club with history replacement', async () => {
    const onClubChange = vi.fn();
    service.listClubs.mockResolvedValue(CLUBS);
    service.getOverview.mockResolvedValue(overview(111));

    const { rerender } = render(view(null, onClubChange));
    expect(await screen.findByRole('cell', { name: '111' })).toBeInTheDocument();
    expect(onClubChange).toHaveBeenCalledWith('club-a', true);

    onClubChange.mockClear();
    rerender(view('not-a-shared-club', onClubChange));
    await waitFor(() => expect(onClubChange).toHaveBeenCalledWith('club-a', true));
    expect(onClubChange).not.toHaveBeenCalledWith('club-a', false);
  });

  it('ignores a late club-list reply from the previous player scope', async () => {
    const oldList = deferred<typeof CLUBS>();
    const newList = deferred<typeof CLUBS>();
    service.listClubs.mockImplementation((targetUserId: string) =>
      targetUserId === 'player-old' ? oldList.promise : newList.promise
    );
    service.getOverview.mockResolvedValue(overview(222));

    const { rerender } = render(view('club-a', vi.fn(), 'player-old'));
    await waitFor(() => expect(service.listClubs).toHaveBeenCalledTimes(1));

    rerender(view('club-b', vi.fn(), 'player-new'));
    await waitFor(() => expect(service.listClubs).toHaveBeenCalledTimes(2));

    await act(async () => {
      newList.resolve([CLUBS[1]]);
      await newList.promise;
    });
    expect(await screen.findByRole('cell', { name: '222' })).toBeInTheDocument();

    await act(async () => {
      oldList.resolve([CLUBS[0]]);
      await oldList.promise;
    });
    expect(screen.getByRole('button', { name: 'Bravo Club' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Alpha Club' })).not.toBeInTheDocument();
    expect(screen.getByRole('cell', { name: '222' })).toBeInTheDocument();
  });

  it('ignores a late overview after the URL selects a different club', async () => {
    const alphaOverview = deferred<ReturnType<typeof overview>>();
    const bravoOverview = deferred<ReturnType<typeof overview>>();
    service.listClubs.mockResolvedValue(CLUBS);
    service.getOverview.mockImplementation((_targetUserId: string, clubId: string) =>
      clubId === 'club-a' ? alphaOverview.promise : bravoOverview.promise
    );

    const { rerender } = render(view('club-a'));
    await waitFor(() => expect(service.getOverview).toHaveBeenCalledTimes(1));

    rerender(view('club-b'));
    await waitFor(() => expect(service.getOverview).toHaveBeenCalledTimes(2));

    await act(async () => {
      bravoOverview.resolve(overview(202));
      await bravoOverview.promise;
    });
    expect(await screen.findByRole('cell', { name: '202' })).toBeInTheDocument();

    await act(async () => {
      alphaOverview.resolve(overview(101));
      await alphaOverview.promise;
    });
    expect(screen.getAllByRole('cell')[0]).toHaveTextContent('202');
  });

  it('never paints the prior club readout during a committed URL scope change', async () => {
    const bravoOverview = deferred<ReturnType<typeof overview>>();
    service.listClubs.mockResolvedValue(CLUBS);
    service.getOverview.mockImplementation((_targetUserId: string, clubId: string) =>
      clubId === 'club-a' ? Promise.resolve(overview(101)) : bravoOverview.promise
    );

    const { rerender } = render(view('club-a'));
    expect(await screen.findByRole('cell', { name: '101' })).toBeInTheDocument();

    rerender(view('club-b'));
    expect(screen.queryByRole('cell', { name: '101' })).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Opening Shared Readout');
    expect(screen.getByRole('button', { name: 'Bravo Club' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );

    await act(async () => {
      bravoOverview.resolve(overview(202));
      await bravoOverview.promise;
    });
    expect(await screen.findByRole('cell', { name: '202' })).toBeInTheDocument();
  });

  it('reports a club-list failure and retries club access', async () => {
    const listError = new Error('club list unavailable');
    service.listClubs.mockRejectedValueOnce(listError).mockResolvedValueOnce(CLUBS);
    service.getOverview.mockResolvedValue(overview(303));

    render(view('club-a'));

    expect(await screen.findByRole('alert')).toHaveTextContent('Club Access Could Not Be Verified');
    expect(service.reportError).toHaveBeenCalledWith(listError, 'SharedClubStatsView.listClubs');

    fireEvent.click(screen.getByRole('button', { name: 'Retry Club Access' }));

    expect(await screen.findByRole('cell', { name: '303' })).toBeInTheDocument();
    expect(service.listClubs).toHaveBeenCalledTimes(2);
    expect(service.getOverview).toHaveBeenCalledTimes(1);
  });

  it('reports an overview failure and retries only the selected overview', async () => {
    const overviewError = new Error('overview unavailable');
    service.listClubs.mockResolvedValue(CLUBS);
    service.getOverview.mockRejectedValueOnce(overviewError).mockResolvedValueOnce(overview(404));

    render(view('club-a'));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The Selected Club Readout Could Not Be Opened'
    );
    expect(service.reportError).toHaveBeenCalledWith(
      overviewError,
      'SharedClubStatsView.getOverview'
    );

    fireEvent.click(screen.getByRole('button', { name: 'Retry Shared Readout' }));

    expect(await screen.findByRole('cell', { name: '404' })).toBeInTheDocument();
    expect(service.listClubs).toHaveBeenCalledTimes(1);
    expect(service.getOverview).toHaveBeenCalledTimes(2);
  });
});
