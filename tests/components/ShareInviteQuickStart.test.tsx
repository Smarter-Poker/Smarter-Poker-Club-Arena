import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ link: vi.fn(), stats: vi.fn(), share: vi.fn(), copy: vi.fn() }));
vi.mock('../../src/services/ClubInviteService', () => ({
  getMyInviteLink: mocks.link,
  getMyInviteStats: mocks.stats,
  getClubInviteStats: vi.fn(),
  inviteShareText: () => 'Join River Kings',
}));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
import { ShareInviteSheet } from '../../src/components/club/ShareInviteSheet';
beforeEach(() => {
  vi.clearAllMocks();
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
