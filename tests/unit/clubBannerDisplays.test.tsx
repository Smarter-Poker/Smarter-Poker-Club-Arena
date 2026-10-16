// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ClubBannerDisplaysPage from '../../src/pages/ClubBannerDisplaysPage';
import { getClubArenaNavigation } from '../../src/config/clubArenaNavigation';

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  save: vi.fn(),
  saveRotating: vi.fn(),
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
  saveClubRotatingBanners: mocks.saveRotating,
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

it('preserves independently saved rotating banners when the top banner response arrives later', async () => {
  vi.stubEnv('VITE_SUPABASE_URL', 'https://test.supabase.co');
  const banner = {
    id: 'original',
    title: 'Before',
    enabled: true,
    imageUrl:
      'https://test.supabase.co/storage/v1/object/public/club-assets/club-cards/club-uuid-banner-abc123.png',
  };
  const initial = { ...record, settings: { rotating_banners: [banner] } };
  mocks.read.mockResolvedValue(initial);
  let finishTop!: (value: unknown) => void;
  mocks.save.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishTop = resolve;
      })
  );
  mocks.saveRotating.mockResolvedValue({
    ...initial,
    settings: { rotating_banners: [{ ...banner, title: 'Updated Promotion' }] },
  });
  open();
  fireEvent.click(await screen.findByRole('button', { name: 'Use Default Banner' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save Banner' }));
  fireEvent.change(screen.getByLabelText('Banner Title 1'), {
    target: { value: 'Updated Promotion' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save Rotating Banners' }));
  await waitFor(() => expect(mocks.success).toHaveBeenCalledWith('Rotating Banners Saved'));
  finishTop({ ...initial, banner_url: null });
  await waitFor(() => expect(mocks.success).toHaveBeenCalledWith('Banner Display Saved'));
  expect((screen.getByLabelText('Banner Title 1') as HTMLInputElement).value).toBe(
    'Updated Promotion'
  );
});

it('preserves the saved top banner when the rotating-banner response arrives later', async () => {
  vi.stubEnv('VITE_SUPABASE_URL', 'https://test.supabase.co');
  const banner = {
    id: 'original',
    title: 'Before',
    enabled: true,
    imageUrl:
      'https://test.supabase.co/storage/v1/object/public/club-assets/club-cards/club-uuid-banner-abc123.png',
  };
  const initial = { ...record, settings: { rotating_banners: [banner] } };
  mocks.read.mockResolvedValue(initial);
  let finishRotating!: (value: unknown) => void;
  mocks.saveRotating.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishRotating = resolve;
      })
  );
  open();
  fireEvent.change(await screen.findByLabelText('Banner Title 1'), {
    target: { value: 'Updated Promotion' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save Rotating Banners' }));
  fireEvent.click(screen.getByRole('button', { name: 'Use Default Banner' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save Banner' }));
  await waitFor(() => expect(mocks.success).toHaveBeenCalledWith('Banner Display Saved'));
  finishRotating({
    ...initial,
    settings: { rotating_banners: [{ ...banner, title: 'Updated Promotion' }] },
  });
  await waitFor(() => expect(mocks.success).toHaveBeenCalledWith('Rotating Banners Saved'));
  expect(screen.getByAltText('Club Lobby Banner Preview').getAttribute('src')).toContain(
    'shark-club-championship'
  );
  expect((screen.getByLabelText('Banner Title 1') as HTMLInputElement).value).toBe(
    'Updated Promotion'
  );
});
