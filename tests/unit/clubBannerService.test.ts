import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  storage: vi.fn(),
  upload: vi.fn(),
  emit: vi.fn(),
}));
vi.mock('../../src/lib/supabase', () => ({
  supabase: { from: mocks.from, storage: { from: mocks.storage } },
}));
vi.mock('../../src/core/MasterBus', () => ({ masterBus: { emit: mocks.emit } }));
import {
  readClubBanner,
  saveClubBanner,
  saveClubAdVisibility,
  uploadClubBannerImage,
  validateClubBanner,
} from '../../src/services/ClubBannerService';
function query(result: unknown) {
  const q: Record<string, any> = {};
  for (const key of ['select', 'update', 'eq', 'is']) q[key] = vi.fn(() => q);
  q.maybeSingle = vi.fn().mockResolvedValue(result);
  return q;
}
const club = { id: 'club', name: 'Club', owner_id: 'owner', banner_url: '/new.png' };
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('VITE_SUPABASE_URL', 'https://test.supabase.co');
});
afterEach(() => vi.unstubAllEnvs());

function expectPresentationNotification(clubId: string) {
  // CLUB_UPDATED revalidates membership and unmounts the active editor. A
  // presentation save must refresh its lobby consumer without discarding a
  // draft or interrupting the next banner upload.
  expect(mocks.emit.mock.calls).toEqual([['CLUB_SETTINGS_UPDATED', { clubId }]]);
}
describe('club banner persistence', () => {
  it('uses the granted immutable storage namespace and the actual 2 MB limit', async () => {
    mocks.storage.mockReturnValue({
      upload: mocks.upload,
      getPublicUrl: () => ({ data: { publicUrl: '/image.png' } }),
    });
    mocks.upload.mockResolvedValue({ data: { path: 'stored' }, error: null });
    await expect(
      uploadClubBannerImage('club', new File(['x'], 'not-an-extension.exe', { type: 'image/png' }))
    ).resolves.toBe('/image.png');
    expect(mocks.upload).toHaveBeenCalledWith(
      expect.stringMatching(/^club-cards\/club-banner-.*\.png$/),
      expect.any(File),
      expect.objectContaining({ upsert: false })
    );
    expect(() => validateClubBanner({ type: 'image/png', size: 2097153 } as File)).toThrow('2 MB');
    expect(() => validateClubBanner({ type: 'image/svg+xml', size: 1 } as File)).toThrow('JPEG');
  });
  it('checks club, owner and previous banner, returning the persisted row', async () => {
    const q = query({ data: club, error: null });
    mocks.from.mockReturnValue(q);
    await expect(saveClubBanner('club', 'owner', '/old.png', '/new.png')).resolves.toEqual(club);
    expect(q.update).toHaveBeenCalledWith({ banner_url: '/new.png' });
    expect(q.eq.mock.calls).toEqual([
      ['id', 'club'],
      ['owner_id', 'owner'],
      ['banner_url', '/old.png'],
    ]);
    expectPresentationNotification('club');
  });
  it('uses SQL null semantics for the initial default banner', async () => {
    const q = query({ data: club, error: null });
    mocks.from.mockReturnValue(q);
    await saveClubBanner('club', 'owner', null, '/new.png');
    expect(q.is).toHaveBeenCalledWith('banner_url', null);
  });
  it('refuses a zero-row write when the banner was concurrently changed', async () => {
    mocks.from
      .mockReturnValueOnce(query({ data: null, error: null }))
      .mockReturnValueOnce(
        query({ data: { ...club, banner_url: '/someone-else.png' }, error: null })
      );
    await expect(saveClubBanner('club', 'owner', '/old.png', '/new.png')).rejects.toThrow('Reload');
    expect(mocks.emit).not.toHaveBeenCalled();
  });
  it('recovers the durable result of an already completed save', async () => {
    mocks.from
      .mockReturnValueOnce(query({ data: null, error: null }))
      .mockReturnValueOnce(query({ data: club, error: null }));
    await expect(saveClubBanner('club', 'owner', '/old.png', '/new.png')).resolves.toEqual(club);
    expectPresentationNotification('club');
  });
  it('propagates database refusal and never emits success', async () => {
    mocks.from.mockReturnValue(query({ data: null, error: new Error('denied') }));
    await expect(saveClubBanner('club', 'owner', null, '/new.png')).rejects.toThrow('denied');
    await expect(readClubBanner('club')).rejects.toThrow('denied');
    expect(mocks.emit).not.toHaveBeenCalled();
  });
});

describe('platform ad visibility persistence', () => {
  const expected = { unrelated: 'preserved', rotating_banners: [{ title: 'Legacy' }] };
  const saved = {
    ...club,
    union_id: 'union',
    settings: { ...expected, show_smarter_poker_ads: false },
  };
  it('changes only visibility with owner RLS and complete settings CAS, including union clubs', async () => {
    const q = query({ data: saved, error: null });
    mocks.from.mockReturnValue(q);
    await expect(saveClubAdVisibility('club', 'owner', expected, false)).resolves.toEqual(saved);
    expect(q.update).toHaveBeenCalledWith({ settings: saved.settings });
    expect(q.eq.mock.calls).toEqual([
      ['id', 'club'],
      ['owner_id', 'owner'],
      ['settings', JSON.stringify(expected)],
    ]);
    expectPresentationNotification('club');
    expect(mocks.upload).not.toHaveBeenCalled();
  });
  it('uses SQL null semantics when settings have never been saved', async () => {
    const q = query({ data: saved, error: null });
    mocks.from.mockReturnValue(q);
    await saveClubAdVisibility('club', 'owner', null, false);
    expect(q.is).toHaveBeenCalledWith('settings', null);
  });
  it('recovers an already committed flag while preserving later unrelated settings', async () => {
    const current = { ...saved, settings: { ...saved.settings, unrelated: 'newer' } };
    mocks.from
      .mockReturnValueOnce(query({ data: null, error: null }))
      .mockReturnValueOnce(query({ data: current, error: null }));
    await expect(saveClubAdVisibility('club', 'owner', expected, false)).resolves.toEqual(current);
    expectPresentationNotification('club');
  });
  it.each([
    { ...saved, settings: { show_smarter_poker_ads: true } },
    { ...saved, owner_id: 'another-owner' },
  ])(
    'refuses changed visibility or revoked ownership without success notification',
    async (current) => {
      mocks.from
        .mockReturnValueOnce(query({ data: null, error: null }))
        .mockReturnValueOnce(query({ data: current, error: null }));
      await expect(saveClubAdVisibility('club', 'owner', expected, false)).rejects.toThrow(
        'Reload'
      );
      expect(mocks.emit).not.toHaveBeenCalled();
    }
  );
  it('propagates database refusal without reporting a successful save', async () => {
    mocks.from.mockReturnValue(query({ data: null, error: new Error('denied') }));
    await expect(saveClubAdVisibility('club', 'owner', expected, false)).rejects.toThrow('denied');
    expect(mocks.emit).not.toHaveBeenCalled();
  });
});
