import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ access: vi.fn(), auth: vi.fn(), unsubscribe: vi.fn() }));
vi.mock('../../src/services/ArenaContextService', () => ({ getArenaContext: mocks.access }));
vi.mock('../../src/lib/supabase', () => ({
  supabase: { auth: { onAuthStateChange: mocks.auth } },
}));
import ArenaAccessBoundary from '../../src/components/arena/ArenaAccessBoundary';
const chip = {
  arena: { id: 'chip', kind: 'chip_club', asset: 'chips' },
  member: true,
  automaticMembership: false,
  role: 'player',
};
const diamond = {
  arena: { id: 'diamond', kind: 'diamond_arena', asset: 'diamonds' },
  member: true,
  automaticMembership: true,
  role: 'player',
};
const view = (key: string) => (
  <MemoryRouter>
    <ArenaAccessBoundary clubKey={key}>
      <div>Private Chip Lobby</div>
    </ArenaAccessBoundary>
  </MemoryRouter>
);
beforeEach(() => {
  vi.resetAllMocks();
  mocks.auth.mockReturnValue({ data: { subscription: { unsubscribe: mocks.unsubscribe } } });
});
describe('Arena entry before cached club content mounts', () => {
  it('admits joined chip members to the existing lobby', async () => {
    mocks.access.mockResolvedValue(chip);
    render(view('chip'));
    expect(await screen.findByText('Private Chip Lobby')).toBeTruthy();
  });
  it('requires an explicit join for an unjoined chip club', async () => {
    mocks.access.mockResolvedValue({ ...chip, member: false });
    render(view('chip'));
    expect(await screen.findByRole('link', { name: 'Join This Club' })).toHaveAttribute(
      'href',
      '/invite/chip'
    );
    expect(screen.queryByText('Private Chip Lobby')).toBeNull();
  });
  it('recognizes Diamond membership without mounting chip wallets or a join flow', async () => {
    mocks.access.mockResolvedValue(diamond);
    render(view('diamond'));
    expect(await screen.findByText('You Are Already A Member.')).toBeTruthy();
    expect(screen.queryByText('Private Chip Lobby')).toBeNull();
    expect(screen.queryByRole('link', { name: 'Join This Club' })).toBeNull();
  });
  it('does not show the previous club or accept a late response after switching', async () => {
    let resolveOld: (v: unknown) => void = () => {};
    mocks.access.mockImplementation((key: string) =>
      key === 'old'
        ? new Promise((resolve) => {
            resolveOld = resolve;
          })
        : Promise.resolve(diamond)
    );
    const page = render(view('old'));
    page.rerender(view('diamond'));
    await screen.findByText('You Are Already A Member.');
    await act(async () => {
      resolveOld(chip);
    });
    expect(screen.queryByText('Private Chip Lobby')).toBeNull();
  });
  it('removes private content on sign-out and unsubscribes on unmount', async () => {
    mocks.access.mockResolvedValue(chip);
    const page = render(view('chip'));
    await screen.findByText('Private Chip Lobby');
    act(() => mocks.auth.mock.calls[0][0]('SIGNED_OUT'));
    expect(screen.queryByText('Private Chip Lobby')).toBeNull();
    page.unmount();
    expect(mocks.unsubscribe).toHaveBeenCalled();
  });
  it('refuses unknown identity instead of opening a chip lobby', async () => {
    mocks.access.mockResolvedValue(null);
    render(view('unknown'));
    expect(await screen.findByText('Arena Not Found')).toBeTruthy();
    expect(screen.queryByText('Private Chip Lobby')).toBeNull();
  });
  it('retries a failed access read without treating the failure as a join requirement', async () => {
    mocks.access.mockRejectedValueOnce(new Error('Unavailable')).mockResolvedValueOnce(chip);
    render(view('chip'));
    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
    await screen.findByText('Private Chip Lobby');
    expect(mocks.access).toHaveBeenCalledTimes(2);
  });
  it('removes private content if revalidation fails without navigating the host', async () => {
    mocks.access
      .mockResolvedValueOnce(chip)
      .mockRejectedValueOnce(new Error('Authentication Required'));
    render(view('chip'));
    await screen.findByText('Private Chip Lobby');
    fireEvent.focus(window);
    await waitFor(() => expect(screen.queryByText('Private Chip Lobby')).toBeNull());
    expect(await screen.findByRole('button', { name: 'Retry' })).toBeTruthy();
  });
});
