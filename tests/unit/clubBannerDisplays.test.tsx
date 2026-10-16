// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ClubBannerDisplaysPage from '../../src/pages/ClubBannerDisplaysPage';
import { getClubArenaNavigation } from '../../src/config/clubArenaNavigation';

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  save: vi.fn(),
  saveVisibility: vi.fn(),
  upload: vi.fn(),
  success: vi.fn(),
}));
vi.mock('../../src/hooks/useAuthUser', () => ({ useAuthUser: () => ({ user: { id: 'owner' } }) }));
vi.mock('../../src/components/common/Toast', () => ({
  useToast: () => ({ success: mocks.success }),
}));
vi.mock('../../src/utils/clubIdResolver', () => ({
  resolveClubUUIDStrict: async () => 'club-uuid',
}));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
vi.mock('../../src/services/ClubBannerService', async (original) => ({
  ...(await original<typeof import('../../src/services/ClubBannerService')>()),
  readClubBanner: mocks.read,
  saveClubBanner: mocks.save,
  saveClubAdVisibility: mocks.saveVisibility,
  uploadClubBannerImage: mocks.upload,
}));
const record = {
  id: 'club-uuid',
  name: 'Union Member Club',
  owner_id: 'owner',
  banner_url: '/old.png',
  union_id: 'union',
};
function open() {
  return render(
    <MemoryRouter initialEntries={['/clubs/union-member/banner-displays']}>
      <Routes>
        <Route path="/clubs/:clubId/banner-displays" element={<ClubBannerDisplaysPage />} />
      </Routes>
    </MemoryRouter>
  );
}
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});
beforeEach(() => {
  vi.clearAllMocks();
  mocks.read.mockResolvedValue(record);
  mocks.upload.mockResolvedValue('/new.png');
  mocks.save.mockImplementation(async (_id, _owner, _expected, next) => ({
    ...record,
    banner_url: next,
  }));
  URL.createObjectURL = vi.fn(() => 'blob:preview');
  URL.revokeObjectURL = vi.fn();
});
describe('club banner displays', () => {
  it('gives the owner an independent hamburger door without game-management authority', () => {
    const links = getClubArenaNavigation({
      clubId: 'union-member',
      clubRole: 'owner',
      canManageGames: false,
    }).flatMap((g) => g.items);
    expect(links.find((i) => i.label === 'Banner Displays')?.path).toBe(
      '/clubs/union-member/banner-displays'
    );
    for (const role of ['member', 'agent', 'admin', 'co_owner', null])
      expect(
        getClubArenaNavigation({ clubId: 'union-member', clubRole: role })
          .flatMap((g) => g.items)
          .some((i) => i.label === 'Banner Displays')
      ).toBe(false);
  });
  it('loads a union club and resets only its own persisted banner', async () => {
    open();
    fireEvent.click(await screen.findByRole('button', { name: 'Use Default Banner' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save Banner' }));
    await waitFor(() =>
      expect(mocks.save).toHaveBeenCalledWith('club-uuid', 'owner', '/old.png', null)
    );
    expect(mocks.upload).not.toHaveBeenCalled();
    await waitFor(() => expect(mocks.success).toHaveBeenCalledWith('Banner Display Saved'));
  });
  it('refuses a direct visit from another club member', async () => {
    mocks.read.mockResolvedValue({ ...record, owner_id: 'another-owner' });
    open();
    await screen.findByText('Only The Club Owner Can Change Banner Displays.');
    expect(screen.queryByLabelText('Choose Banner Image')).toBeNull();
    expect(screen.getByRole('button', { name: 'Save Banner' })).toHaveProperty('disabled', true);
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it('shows a load failure with recovery, rather than an empty editor', async () => {
    mocks.read.mockRejectedValue(new Error('Unavailable'));
    open();
    await screen.findByRole('alert');
    expect(screen.queryByLabelText('Choose Banner Image')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    await waitFor(() => expect(mocks.read).toHaveBeenCalledTimes(2));
  });
  it('validates and previews an image before saving and retains its upload after a conflict', async () => {
    open();
    const input = await screen.findByLabelText('Choose Banner Image');
    fireEvent.change(input, {
      target: { files: [new File(['image'], 'banner.png', { type: 'image/png' })] },
    });
    await waitFor(() =>
      expect(screen.getByAltText('Club Lobby Banner Preview').getAttribute('src')).toBe(
        'blob:preview'
      )
    );
    expect(screen.getByRole('button', { name: 'Save Banner' })).toHaveProperty('disabled', true);
    fireEvent.load(screen.getByAltText('Club Lobby Banner Preview'));
    mocks.save.mockRejectedValueOnce(new Error('Banner Changed. Reload Before Saving.'));
    fireEvent.click(screen.getByRole('button', { name: 'Save Banner' }));
    await screen.findByRole('alert');
    expect(mocks.success).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Save Banner' }));
    await waitFor(() => expect(mocks.success).toHaveBeenCalledOnce());
    expect(mocks.upload).toHaveBeenCalledOnce();
  });
  it('rejects invalid file types without an upload', async () => {
    open();
    fireEvent.change(await screen.findByLabelText('Choose Banner Image'), {
      target: { files: [new File(['bad'], 'bad.svg', { type: 'image/svg+xml' })] },
    });
    await screen.findByRole('alert');
    expect(mocks.upload).not.toHaveBeenCalled();
  });
});

it('offers union owners show/hide only, independently of the top banner uploader', async () => {
  open();
  expect(
    await screen.findByRole('switch', { name: 'Show Smarter.Poker Rotating Ads' })
  ).toBeChecked();
  expect(screen.getAllByLabelText('Choose Banner Image')).toHaveLength(1);
  expect(screen.queryByLabelText('Add Rotating Banner Image')).toBeNull();
  expect(screen.queryByLabelText(/Banner Title/)).toBeNull();
  expect(
    screen.queryByRole('button', { name: /Save Rotating Banners|Move Banner|Remove Banner/ })
  ).toBeNull();
});

it('preserves saved ad visibility when the top banner response arrives later', async () => {
  const initial = { ...record, settings: { show_smarter_poker_ads: true, other: 1 } };
  mocks.read.mockResolvedValue(initial);
  let finishTop!: (value: unknown) => void;
  mocks.save.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishTop = resolve;
      })
  );
  mocks.saveVisibility.mockResolvedValue({
    ...initial,
    settings: { ...initial.settings, show_smarter_poker_ads: false },
  });
  open();
  fireEvent.click(await screen.findByRole('button', { name: 'Use Default Banner' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save Banner' }));
  fireEvent.click(screen.getByRole('switch', { name: 'Show Smarter.Poker Rotating Ads' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save Ad Visibility' }));
  await waitFor(() => expect(mocks.saveVisibility).toHaveBeenCalledOnce());
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Save Ad Visibility' })).toBeDisabled()
  );
  finishTop({ ...initial, banner_url: null });
  await waitFor(() => expect(mocks.success).toHaveBeenCalledWith('Banner Display Saved'));
  expect(screen.getByRole('switch', { name: 'Show Smarter.Poker Rotating Ads' })).not.toBeChecked();
});

it('preserves the saved top banner when the visibility response arrives later', async () => {
  const initial = { ...record, settings: { show_smarter_poker_ads: true, other: 1 } };
  mocks.read.mockResolvedValue(initial);
  let finishVisibility!: (value: unknown) => void;
  mocks.saveVisibility.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishVisibility = resolve;
      })
  );
  open();
  fireEvent.click(await screen.findByRole('switch', { name: 'Show Smarter.Poker Rotating Ads' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save Ad Visibility' }));
  fireEvent.click(screen.getByRole('button', { name: 'Use Default Banner' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save Banner' }));
  await waitFor(() => expect(mocks.success).toHaveBeenCalledWith('Banner Display Saved'));
  finishVisibility({
    ...initial,
    settings: { ...initial.settings, show_smarter_poker_ads: false },
  });
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Save Ad Visibility' })).toBeDisabled()
  );
  expect(screen.getByAltText('Club Lobby Banner Preview').getAttribute('src')).toContain(
    'shark-club-championship'
  );
  expect(screen.getByRole('switch', { name: 'Show Smarter.Poker Rotating Ads' })).not.toBeChecked();
});
