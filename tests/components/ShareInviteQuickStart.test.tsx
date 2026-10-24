import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  link: vi.fn(),
  stats: vi.fn(),
  share: vi.fn(),
  copy: vi.fn(),
  clubStats: vi.fn(),
  accountId: 'account-1',
}));
vi.mock('../../src/services/ClubInviteService', () => ({
  getMyInviteLink: mocks.link,
  getMyInviteStats: mocks.stats,
  getClubInviteStats: mocks.clubStats,
  inviteShareText: () => 'Join River Kings',
}));
vi.mock('../../src/stores/useUserStore', () => ({
  useUserStore: (selector: (state: { user: { id: string } }) => unknown) =>
    selector({ user: { id: mocks.accountId } }),
}));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
import { ShareInviteSheet } from '../../src/components/club/ShareInviteSheet';
beforeEach(() => {
  vi.resetAllMocks();
  mocks.accountId = 'account-1';
  mocks.clubStats.mockResolvedValue({ allowed: true, scope: 'club', rows: [] });
  mocks.link.mockResolvedValue({ shortUrl: 'https://smarter.poker/i/ABC2345' });
  mocks.stats.mockResolvedValue({ opened: 0, signedUp: 0, verified: 0, joined: 0 });
  Object.defineProperty(navigator, 'share', { configurable: true, value: mocks.share });
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: mocks.copy },
  });
});
const mount = () =>
  render(
    <ShareInviteSheet
      isOpen
      quickStart
      onClose={vi.fn()}
      clubId="club-1"
      clubName="River Kings"
      clubNumber={123}
      inviterAlias="Owner"
      canSeeClubStats
    />
  );
describe('new club send link', () => {
  it('shows the owner link with one primary send action and no setup or stats decisions', async () => {
    mount();
    const send = await screen.findByRole('button', { name: 'Send Link' });
    await waitFor(() => expect(send).toBeEnabled());
    expect(screen.queryByLabelText('Invite QR Code')).not.toBeInTheDocument();
    expect(screen.queryByText('View Invite Stats')).not.toBeInTheDocument();
    fireEvent.click(send);
    await waitFor(() =>
      expect(mocks.share).toHaveBeenCalledWith({
        title: 'River Kings',
        text: 'Join River Kings',
        url: 'https://smarter.poker/i/ABC2345',
      })
    );
  });
  it('copies the link when native sharing is unavailable', async () => {
    Object.defineProperty(navigator, 'share', { configurable: true, value: undefined });
    mount();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send Link' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Send Link' }));
    await waitFor(() =>
      expect(mocks.copy).toHaveBeenCalledWith('Join River Kings\n\nhttps://smarter.poker/i/ABC2345')
    );
    expect(await screen.findByRole('button', { name: 'Link Copied' })).toBeVisible();
  });
  it('keeps link failure visible and lets the owner explicitly retry', async () => {
    mocks.link.mockRejectedValueOnce(new Error('Offline'));
    mount();
    expect(await screen.findByRole('alert')).toHaveTextContent('Could Not Be Created');
    expect(screen.getByRole('button', { name: 'Send Link' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Retry Link' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send Link' })).toBeEnabled());
    expect(mocks.link).toHaveBeenCalledTimes(2);
  });
});

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const sheet = (props: Partial<React.ComponentProps<typeof ShareInviteSheet>> = {}) => (
  <ShareInviteSheet
    isOpen
    quickStart
    onClose={vi.fn()}
    clubId="club-1"
    clubName="River Kings"
    clubNumber={123}
    inviterAlias="Owner"
    canSeeClubStats
    {...props}
  />
);
const waitForLink = () =>
  waitFor(() =>
    expect(screen.getByLabelText('Your Invite Link')).toHaveValue('https://smarter.poker/i/ABC2345')
  );

describe('invite asynchronous scope', () => {
  it('discards the previous account link while the same club remains open', async () => {
    const old = deferred<{ shortUrl: string }>();
    const fresh = deferred<{ shortUrl: string }>();
    mocks.link.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
    const view = render(sheet());
    mocks.accountId = 'account-2';
    view.rerender(sheet());
    await act(async () => old.resolve({ shortUrl: 'https://smarter.poker/i/OLD2345' }));
    expect(screen.getByLabelText('Your Invite Link')).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Send Link' })).toBeDisabled();
    await act(async () => fresh.resolve({ shortUrl: 'https://smarter.poker/i/NEW2345' }));
    expect(screen.getByLabelText('Your Invite Link')).toHaveValue(
      'https://smarter.poker/i/NEW2345'
    );
    expect(screen.getByRole('button', { name: 'Send Link' })).toBeEnabled();
  });

  it('ignores an old club statistics response after changing clubs', async () => {
    const old = deferred<{
      allowed: boolean;
      scope: string;
      rows: Array<{ inviterId: string; alias: string }>;
    }>();
    mocks.clubStats.mockReturnValueOnce(old.promise);
    const view = render(sheet({ quickStart: false }));
    await waitForLink();
    fireEvent.click(screen.getByRole('button', { name: 'View Invite Stats' }));
    view.rerender(sheet({ quickStart: false, clubId: 'club-2', clubName: 'New Club' }));
    await waitForLink();
    fireEvent.click(screen.getByRole('button', { name: 'View Invite Stats' }));
    await act(async () =>
      old.resolve({
        allowed: true,
        scope: 'club',
        rows: [{ inviterId: 'old', alias: 'Old Club Inviter' }],
      })
    );
    expect(screen.queryByText('Old Club Inviter')).not.toBeInTheDocument();
    expect(mocks.clubStats).toHaveBeenLastCalledWith('club-2');
  });
  it('shows a statistics failure and permits an explicit retry', async () => {
    mocks.clubStats.mockRejectedValueOnce(new Error('Offline'));
    render(sheet({ quickStart: false }));
    await waitForLink();
    fireEvent.click(screen.getByRole('button', { name: 'View Invite Stats' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Invite Stats Could Not Be Loaded');
    expect(screen.queryByText('No Invites Yet.')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry Invite Stats' }));
    expect(await screen.findByText('No Invites Yet.')).toBeVisible();
    expect(mocks.clubStats).toHaveBeenCalledTimes(2);
  });
  it('does not mark a reopened sheet copied when the previous copy finishes', async () => {
    const old = deferred<void>();
    mocks.copy.mockReturnValueOnce(old.promise);
    const view = render(sheet());
    await waitForLink();
    fireEvent.click(screen.getByRole('button', { name: 'Copy', exact: true }));
    view.rerender(sheet({ isOpen: false }));
    view.rerender(sheet());
    await waitForLink();
    await act(async () => old.resolve());
    expect(screen.queryByRole('button', { name: 'Link Copied' })).not.toBeInTheDocument();
  });
  it('ignores the old account copy completion while the same club remains open', async () => {
    const old = deferred<void>();
    mocks.copy.mockReturnValueOnce(old.promise);
    const view = render(sheet());
    await waitForLink();
    fireEvent.click(screen.getByRole('button', { name: 'Copy', exact: true }));
    mocks.accountId = 'account-2';
    view.rerender(sheet());
    await waitForLink();
    await act(async () => old.resolve());
    expect(screen.queryByRole('button', { name: 'Link Copied' })).not.toBeInTheDocument();
    expect(mocks.link).toHaveBeenCalledTimes(2);
  });
  it('ignores a share rejection from the previous account and refreshes its link', async () => {
    const old = deferred<void>();
    mocks.share.mockReturnValueOnce(old.promise);
    const view = render(sheet());
    await waitForLink();
    fireEvent.click(screen.getByRole('button', { name: 'Send Link' }));
    await waitFor(() => expect(mocks.share).toHaveBeenCalledOnce());
    mocks.accountId = 'account-2';
    view.rerender(sheet());
    await waitForLink();
    await act(async () => old.reject(new Error('Old Account Failure')));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(mocks.link).toHaveBeenCalledTimes(2);
  });
});
