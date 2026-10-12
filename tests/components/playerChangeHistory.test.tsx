import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { HistoryEntry, HistoryPage } from '../../src/services/PlayerHistoryService';

const state = vi.hoisted(() => ({
  read: vi.fn(),
  channel: null as any,
  channels: new Map<string, any>(),
}));
vi.mock('../../src/services/PlayerHistoryService', () => ({
  default: { getPlayerHistory: state.read },
}));
vi.mock('../../src/hooks/useMasterBusBroadcastChannel', () => ({
  useMasterBusBroadcastChannel: (options: any) => {
    state.channel = options;
    state.channels.set(options.channelName, options);
  },
}));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
import PlayerChangeHistory from '../../src/components/club/PlayerChangeHistory';

const props = { clubId: 'club-a', viewerId: 'viewer-a', enabled: true };
function entry(id: string, actorName = id): HistoryEntry {
  return {
    id,
    actorName,
    createdAt: '2026-10-12T12:00:00.000Z',
    clubId: 'club-a',
    targetUserId: 'player-a',
    actorId: 'actor-a',
    actorRole: 'admin',
    action: 'set_member_role',
    kind: 'roles',
    before: { role: 'player' },
    after: { role: 'admin' },
  };
}
function page(rows: HistoryEntry[] = [], more = false): HistoryPage {
  return {
    rows,
    scopeClubIds: ['club-a'],
    hasMore: more,
    nextCursor: more ? { createdAt: rows.at(-1)!.createdAt, id: rows.at(-1)!.id } : null,
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function toggle(container: HTMLElement, open = true) {
  const node = container.querySelector('details')!;
  act(() => {
    node.open = open;
    fireEvent(node, new Event('toggle'));
  });
}
async function open() {
  const view = render(<PlayerChangeHistory {...props} />);
  toggle(view.container);
  await waitFor(() => expect(state.read).toHaveBeenCalledTimes(1));
  return view;
}
async function settle(read: ReturnType<typeof deferred<HistoryPage>>, value: HistoryPage) {
  await act(async () => {
    read.resolve(value);
    await read.promise;
  });
}
beforeEach(() => {
  state.read.mockReset().mockResolvedValue(page());
  state.channel = null;
  state.channels.clear();
});
afterEach(cleanup);

it('does not read or subscribe until the disclosure is opened', async () => {
  const view = render(<PlayerChangeHistory {...props} />);
  expect(state.read).not.toHaveBeenCalled();
  expect(state.channel.enabled).toBe(false);
  toggle(view.container);
  await screen.findByText('No Recorded Changes Match This Scope.');
  expect(state.channel.event).toBe('history_changed');
  expect(state.channel.channelName).toBe('player-history:club-a');
  expect(state.channel.private).toBe(true);
});
it('distinguishes a failed read from true empty and retries only on explicit refresh', async () => {
  state.read.mockRejectedValueOnce(new Error('denied'));
  await open();
  await screen.findByRole('alert');
  expect(screen.queryByText('No Recorded Changes Match This Scope.')).not.toBeInTheDocument();
  expect(state.read).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: 'Refresh History' }));
  await screen.findByText('No Recorded Changes Match This Scope.');
  expect(state.read).toHaveBeenCalledTimes(2);
});
it('keeps draft dates out of requests until applied and rejects reversed dates', async () => {
  await open();
  await screen.findByText('No Recorded Changes Match This Scope.');
  fireEvent.change(screen.getByLabelText('History From'), { target: { value: '2026-10-10' } });
  fireEvent.change(screen.getByLabelText('History To'), { target: { value: '2026-10-09' } });
  expect(screen.getByRole('button', { name: 'Apply Dates' })).toBeDisabled();
  expect(screen.getByRole('note')).toHaveTextContent('All Recorded Dates');
  expect(state.read).toHaveBeenCalledTimes(1);
  fireEvent.change(screen.getByLabelText('History To'), { target: { value: '2026-10-12' } });
  fireEvent.click(screen.getByRole('button', { name: 'Apply Dates' }));
  await waitFor(() => expect(state.read).toHaveBeenCalledTimes(2));
  expect(state.read.mock.calls[1][1]).toMatchObject({
    dateFrom: '2026-10-10',
    dateTo: '2026-10-12',
  });
  expect(screen.getByRole('note')).toHaveTextContent('2026-10-10 To 2026-10-12');
});
it('applies history kind and keeps club exports out of a player record', async () => {
  const view = render(<PlayerChangeHistory {...props} playerId="player-a" />);
  toggle(view.container);
  await waitFor(() => expect(state.read).toHaveBeenCalledTimes(1));
  expect(screen.queryByRole('option', { name: 'Exports' })).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('History Type'), { target: { value: 'notes' } });
  await waitFor(() => expect(state.read).toHaveBeenCalledTimes(2));
  expect(state.read.mock.calls[1][1]).toMatchObject({ playerId: 'player-a', kind: 'notes' });
});
it('uses the acknowledged cursor and appends older rows without duplicating retained records', async () => {
  const first = page([entry('first')], true);
  const older = deferred<HistoryPage>();
  state.read.mockResolvedValueOnce(first).mockReturnValueOnce(older.promise);
  await open();
  await screen.findByText('By First (Admin)');
  fireEvent.click(screen.getByRole('button', { name: 'Show Older Changes' }));
  expect(state.read.mock.calls[1][1].cursor).toEqual(first.nextCursor);
  expect(screen.getByRole('button', { name: 'Loading Older Changes...' })).toBeDisabled();
  await settle(older, page([entry('first'), entry('second')]));
  expect(screen.getAllByText('By First (Admin)')).toHaveLength(1);
  expect(screen.getByText('By Second (Admin)')).toBeInTheDocument();
});
for (const scope of ['viewerId', 'clubId', 'playerId'] as const) {
  it(`rejects delayed abandoned ${scope} reads across an A to B to A transition`, async () => {
    const abandoned = deferred<HistoryPage>();
    const current = deferred<HistoryPage>();
    state.read
      .mockReturnValueOnce(abandoned.promise)
      .mockResolvedValueOnce(page([entry('other')]))
      .mockReturnValueOnce(current.promise);
    const initial = { ...props, playerId: 'player-a' };
    const view = render(<PlayerChangeHistory {...initial} />);
    toggle(view.container);
    await waitFor(() => expect(state.read).toHaveBeenCalledTimes(1));
    const signal = state.read.mock.calls[0][2];
    view.rerender(<PlayerChangeHistory {...initial} {...{ [scope]: 'scope-b' }} />);
    await waitFor(() => expect(state.read).toHaveBeenCalledTimes(2));
    expect(signal.aborted).toBe(true);
    view.rerender(<PlayerChangeHistory {...initial} />);
    await waitFor(() => expect(state.read).toHaveBeenCalledTimes(3));
    await settle(abandoned, page([entry('abandoned')]));
    expect(screen.queryByText('By Abandoned (Admin)')).not.toBeInTheDocument();
    await settle(current, page([entry('current')]));
    expect(screen.getByText('By Current (Admin)')).toBeInTheDocument();
  });
}
it('aborts on unmount and ignores completion', async () => {
  const pending = deferred<HistoryPage>();
  state.read.mockReturnValueOnce(pending.promise);
  const view = await open();
  const signal = state.read.mock.calls[0][2];
  view.unmount();
  expect(signal.aborted).toBe(true);
  await settle(pending, page([entry('abandoned')]));
  expect(screen.queryByText('By Abandoned (Admin)')).not.toBeInTheDocument();
});
it('hides and aborts history immediately when local authority is revoked', async () => {
  const pending = deferred<HistoryPage>();
  state.read.mockResolvedValueOnce(page([entry('private')])).mockReturnValueOnce(pending.promise);
  const view = await open();
  await screen.findByText('By Private (Admin)');
  fireEvent.click(screen.getByRole('button', { name: 'Refresh History' }));
  const signal = state.read.mock.calls[1][2];
  view.rerender(<PlayerChangeHistory {...props} enabled={false} />);
  expect(signal.aborted).toBe(true);
  expect(view.container).toBeEmptyDOMElement();
  await settle(pending, page([entry('late-private')]));
  expect(view.container).toBeEmptyDOMElement();
});
it('clears retained rows after a denied pagination read instead of presenting an empty history', async () => {
  state.read
    .mockResolvedValueOnce(page([entry('private')], true))
    .mockRejectedValueOnce(new Error('permission_denied'));
  await open();
  await screen.findByText('By Private (Admin)');
  fireEvent.click(screen.getByRole('button', { name: 'Show Older Changes' }));
  await screen.findByRole('alert');
  expect(screen.queryByText('By Private (Admin)')).not.toBeInTheDocument();
  expect(screen.queryByText('No Recorded Changes Match This Scope.')).not.toBeInTheDocument();
});
it('limits new-change notices to the subscribed club and selected player', async () => {
  const view = render(<PlayerChangeHistory {...props} playerId="player-a" />);
  toggle(view.container);
  await screen.findByText('No Recorded Changes Match This Scope.');
  act(() => {
    state.channel.onPayload({
      payload: { club_id: 'other', action: 'set_member_role', target_id: 'player-a' },
    });
    state.channel.onPayload({
      payload: { club_id: 'club-a', action: 'unrelated', target_id: 'player-a' },
    });
    state.channel.onPayload({
      payload: { club_id: 'club-a', action: 'set_member_role', target_id: 'player-b' },
    });
  });
  expect(screen.queryByText(/New Changes Are Available/)).not.toBeInTheDocument();
  act(() =>
    state.channel.onPayload({
      payload: { club_id: 'club-a', action: 'set_member_role', target_id: 'player-a' },
    })
  );
  expect(screen.getByText(/New Changes Are Available/)).toBeInTheDocument();
  expect(state.read).toHaveBeenCalledTimes(1);
});
it('retires private rows and the active read on a viewer authority event, then rechecks access', async () => {
  const old = deferred<HistoryPage>();
  const authorized = deferred<HistoryPage>();
  state.read
    .mockResolvedValueOnce(page([entry('private')]))
    .mockReturnValueOnce(old.promise)
    .mockReturnValueOnce(authorized.promise);
  await open();
  await screen.findByText('By Private (Admin)');
  fireEvent.click(screen.getByRole('button', { name: 'Refresh History' }));
  const signal = state.read.mock.calls[1][2];
  act(() =>
    state.channel.onPayload({
      payload: { club_id: 'club-a', action: 'set_member_role', target_id: 'viewer-a' },
    })
  );
  await waitFor(() => expect(state.read).toHaveBeenCalledTimes(3));
  expect(signal.aborted).toBe(true);
  expect(screen.queryByText('By Private (Admin)')).not.toBeInTheDocument();
  await settle(old, page([entry('obsolete')]));
  expect(screen.queryByText('By Obsolete (Admin)')).not.toBeInTheDocument();
  await act(async () => authorized.reject(new Error('denied')));
  await screen.findByRole('alert');
});
it('retains a new-change notice when a refresh answer finishes after the event', async () => {
  const old = deferred<HistoryPage>();
  state.read.mockResolvedValueOnce(page()).mockReturnValueOnce(old.promise);
  await open();
  await screen.findByText('No Recorded Changes Match This Scope.');
  fireEvent.click(screen.getByRole('button', { name: 'Refresh History' }));
  act(() =>
    state.channel.onPayload({
      payload: { club_id: 'club-a', action: 'set_member_status', target_id: 'player-a' },
    })
  );
  await settle(old, page([entry('snapshot')]));
  expect(screen.getByText(/New Changes Are Available/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Refresh History' }));
  await waitFor(() => expect(state.read).toHaveBeenCalledTimes(3));
  await waitFor(() =>
    expect(screen.queryByText(/New Changes Are Available/)).not.toBeInTheDocument()
  );
});

it('does not let an abandoned subscription mutate a new viewer history', async () => {
  state.read
    .mockResolvedValueOnce(page([entry('first-viewer', 'First Viewer')]))
    .mockResolvedValueOnce(page([entry('new-viewer', 'New Viewer')]));
  const view = await open();
  await screen.findByText('By First Viewer (Admin)');
  const oldChannel = state.channel;
  view.rerender(<PlayerChangeHistory {...props} viewerId="viewer-b" />);
  await screen.findByText('By New Viewer (Admin)');
  const count = state.read.mock.calls.length;
  act(() =>
    oldChannel.onPayload({
      payload: { club_id: 'club-a', action: 'set_member_role', target_id: 'viewer-a' },
    })
  );
  expect(screen.getByText('By New Viewer (Admin)')).toBeInTheDocument();
  expect(state.read).toHaveBeenCalledTimes(count);
  act(() => {
    oldChannel.onSubscriptionError(new Error('abandoned transport'));
    oldChannel.onSubscriptionStatus('SUBSCRIBED');
    oldChannel.onSubscriptionStatus('SUBSCRIBED');
  });
  expect(screen.queryByText(/Live Changes Could Not Be Confirmed/)).not.toBeInTheDocument();
  expect(screen.queryByText(/New Changes Are Available/)).not.toBeInTheDocument();
});
it('does not revive old private records when authority is regranted before the fresh read finishes', async () => {
  const fresh = deferred<HistoryPage>();
  state.read.mockResolvedValueOnce(page([entry('private')])).mockReturnValueOnce(fresh.promise);
  const view = await open();
  await screen.findByText('By Private (Admin)');
  view.rerender(<PlayerChangeHistory {...props} enabled={false} />);
  expect(view.container).toBeEmptyDOMElement();
  view.rerender(<PlayerChangeHistory {...props} />);
  await waitFor(() => expect(state.read).toHaveBeenCalledTimes(2));
  expect(screen.queryByText('By Private (Admin)')).not.toBeInTheDocument();
  await settle(fresh, page());
  await screen.findByText('No Recorded Changes Match This Scope.');
});
it('reports lost live transport and marks records potentially newer after rejoining', async () => {
  await open();
  await screen.findByText('No Recorded Changes Match This Scope.');
  act(() => state.channel.onSubscriptionStatus('SUBSCRIBED'));
  expect(screen.queryByText(/New Changes Are Available/)).not.toBeInTheDocument();
  act(() => state.channel.onSubscriptionError(new Error('disconnected')));
  expect(screen.getByText(/Live Changes Could Not Be Confirmed/)).toBeInTheDocument();
  act(() => state.channel.onSubscriptionStatus('SUBSCRIBED'));
  expect(screen.queryByText(/Live Changes Could Not Be Confirmed/)).not.toBeInTheDocument();
  expect(screen.getByText(/New Changes Are Available/)).toBeInTheDocument();
  expect(state.read).toHaveBeenCalledTimes(1);
});

it('renders note-presence changes without retaining or printing private note text', async () => {
  const notes: HistoryEntry = {
    ...entry('notes'),
    kind: 'notes',
    action: 'update_member_notes',
    before: { nickname_present: true, nickname_length: 4, remark_present: false, remark_length: 0 },
    after: { nickname_present: false, nickname_length: 0, remark_present: true, remark_length: 11 },
  };
  state.read.mockResolvedValueOnce(page([notes]));
  await open();
  await screen.findByText('Notes Updated');
  expect(
    screen.getByText(/Nickname: Present \(4 Characters\) To Not Set \(0 Characters\)/)
  ).toBeInTheDocument();
  expect(
    screen.getByText(/Remark: Not Set \(0 Characters\) To Present \(11 Characters\)/)
  ).toBeInTheDocument();
  expect(screen.getByText(/Note Text Is Not Stored In This History/)).toBeInTheDocument();
});

it('does not resurrect a previously loaded account cache during a return to that account', async () => {
  const other = deferred<HistoryPage>();
  const fresh = deferred<HistoryPage>();
  state.read
    .mockResolvedValueOnce(page([entry('old-private')]))
    .mockReturnValueOnce(other.promise)
    .mockReturnValueOnce(fresh.promise);
  const view = await open();
  await screen.findByText('By Old-Private (Admin)');
  view.rerender(<PlayerChangeHistory {...props} viewerId="viewer-b" />);
  await waitFor(() => expect(state.read).toHaveBeenCalledTimes(2));
  view.rerender(<PlayerChangeHistory {...props} />);
  await waitFor(() => expect(state.read).toHaveBeenCalledTimes(3));
  expect(screen.queryByText('By Old-Private (Admin)')).not.toBeInTheDocument();
  await settle(other, page([entry('other-private')]));
  expect(screen.queryByText('By Other-Private (Admin)')).not.toBeInTheDocument();
  await settle(fresh, page());
  await screen.findByText('No Recorded Changes Match This Scope.');
});

it('ignores a callback from the retired disclosure subscription after closing and reopening', async () => {
  state.read
    .mockResolvedValueOnce(page([entry('initial')]))
    .mockResolvedValueOnce(page([entry('reopened')]));
  const view = await open();
  await screen.findByText('By Initial (Admin)');
  const retired = state.channel;
  toggle(view.container, false);
  toggle(view.container, true);
  await screen.findByText('By Reopened (Admin)');
  const count = state.read.mock.calls.length;
  act(() =>
    retired.onPayload({
      payload: { club_id: 'club-a', action: 'set_member_role', target_id: 'viewer-a' },
    })
  );
  expect(screen.getByText('By Reopened (Admin)')).toBeInTheDocument();
  expect(state.read).toHaveBeenCalledTimes(count);
});

it('subscribes to exact authorized union clubs and accepts their changes while rejecting outsiders', async () => {
  state.read.mockResolvedValueOnce({
    ...page([entry('union-record')]),
    scopeClubIds: ['club-a', 'club-b'],
  });
  await open();
  await screen.findByText('By Union-Record (Admin)');
  expect(screen.getByText('Includes 2 Authorized Clubs.')).toBeInTheDocument();
  expect(screen.getByText(/Club Reference: club-a/)).toBeInTheDocument();
  const child = state.channels.get('player-history:club-b');
  expect(child).toMatchObject({
    channelName: 'player-history:club-b',
    event: 'history_changed',
    private: true,
    enabled: true,
  });
  expect(state.channels.get('player-history:club-a').enabled).toBe(true);
  expect(state.channels.has('player-history:club-outside')).toBe(false);
  act(() =>
    child.onPayload({
      payload: { club_id: 'club-outside', action: 'set_member_role', target_id: 'player-a' },
    })
  );
  expect(screen.queryByText(/New Changes Are Available/)).not.toBeInTheDocument();
  act(() =>
    child.onPayload({
      payload: { club_id: 'club-b', action: 'set_member_role', target_id: 'player-a' },
    })
  );
  expect(screen.getByText(/New Changes Are Available/)).toBeInTheDocument();
  expect(state.read).toHaveBeenCalledTimes(1);
});

it('does not hide a failed union child channel when another authorized channel rejoins', async () => {
  state.read.mockResolvedValueOnce({ ...page(), scopeClubIds: ['club-a', 'club-b'] });
  await open();
  await screen.findByText('No Recorded Changes Match This Scope.');
  const parent = state.channels.get('player-history:club-a');
  const child = state.channels.get('player-history:club-b');
  act(() => {
    parent.onSubscriptionStatus('SUBSCRIBED');
    child.onSubscriptionStatus('SUBSCRIBED');
  });
  act(() => child.onSubscriptionError(new Error('child disconnected')));
  expect(screen.getByText(/Live Changes Could Not Be Confirmed/)).toBeInTheDocument();
  act(() => parent.onSubscriptionStatus('SUBSCRIBED'));
  expect(screen.getByText(/Live Changes Could Not Be Confirmed/)).toBeInTheDocument();
  act(() => child.onSubscriptionStatus('SUBSCRIBED'));
  expect(screen.queryByText(/Live Changes Could Not Be Confirmed/)).not.toBeInTheDocument();
  expect(screen.getByText(/New Changes Are Available/)).toBeInTheDocument();
  expect(state.read).toHaveBeenCalledTimes(1);
});

it('retires prior child-club rows when a continuation withdraws that authorized scope', async () => {
  const privateRow = { ...entry('child-private'), clubId: 'club-b' };
  state.read
    .mockResolvedValueOnce({
      ...page([entry('kept'), privateRow], true),
      scopeClubIds: ['club-a', 'club-b'],
    })
    .mockResolvedValueOnce(page([entry('older')]));
  await open();
  await screen.findByText('By Child-Private (Admin)');
  const retiredChild = state.channels.get('player-history:club-b');
  fireEvent.click(screen.getByRole('button', { name: 'Show Older Changes' }));
  await screen.findByText('By Older (Admin)');
  expect(screen.queryByText('By Child-Private (Admin)')).not.toBeInTheDocument();
  expect(screen.getByText('By Kept (Admin)')).toBeInTheDocument();
  const calls = state.read.mock.calls.length;
  act(() => {
    retiredChild.onPayload({
      payload: { club_id: 'club-b', action: 'set_member_role', target_id: 'viewer-a' },
    });
    retiredChild.onSubscriptionError('CLOSED');
    retiredChild.onSubscriptionStatus('SUBSCRIBED');
  });
  expect(screen.getByText('By Kept (Admin)')).toBeInTheDocument();
  expect(state.read).toHaveBeenCalledTimes(calls);
  expect(
    screen.queryByText(/Live Changes Could Not Be Confirmed|New Changes Are Available/)
  ).not.toBeInTheDocument();
});
it('subscribes with canonical route UUID casing', async () => {
  const view = render(<PlayerChangeHistory {...props} clubId="CLUB-A" />);
  toggle(view.container);
  await waitFor(() => expect(state.read).toHaveBeenCalledTimes(1));
  await screen.findByText('No Recorded Changes Match This Scope.');
  expect(state.read.mock.calls[0][0]).toBe('club-a');
  expect(state.channels.get('player-history:club-a').enabled).toBe(true);
});

it('waits for authorized child scope before joining private union topics', async () => {
  const permission = deferred<HistoryPage>();
  state.read.mockReturnValueOnce(permission.promise);
  const view = await open();
  expect(state.channel.enabled).toBe(false);
  await settle(permission, { ...page(), scopeClubIds: ['club-b'] });
  expect(state.channels.get('player-history:club-b').enabled).toBe(true);
  expect(state.channels.get('player-history:club-a')).toBeUndefined();
  view.unmount();
});
