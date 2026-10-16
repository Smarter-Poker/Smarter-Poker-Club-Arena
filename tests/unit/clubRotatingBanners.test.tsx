// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  emit: vi.fn(),
  resolve: vi.fn(),
  impression: vi.fn(),
  viewable: vi.fn(),
  click: vi.fn(),
  dismiss: vi.fn(),
  success: vi.fn(),
}));
vi.mock('../../src/lib/supabase', () => ({ supabase: { from: mocks.from } }));
vi.mock('../../src/core/MasterBus', () => ({ masterBus: { emit: mocks.emit } }));
vi.mock('../../src/components/common/Toast', () => ({
  useToast: () => ({ success: mocks.success }),
}));
vi.mock('../../src/services/AdService', async (original) => ({
  ...(await original<typeof import('../../src/services/AdService')>()),
  AdService: {
    resolve: mocks.resolve,
    logImpression: mocks.impression,
    logViewable: mocks.viewable,
    logClick: mocks.click,
    logDismiss: mocks.dismiss,
  },
}));
import {
  isClubRotatingImage,
  readRotatingBanners,
  validateRotatingBanners,
} from '../../src/utils/clubRotatingBanners';
import { saveClubRotatingBanners } from '../../src/services/ClubBannerService';
import ClubRotatingBannerEditor from '../../src/components/club/ClubRotatingBannerEditor';
import HouseAdRotator from '../../src/components/ads/HouseAdRotator';
const clubId = 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4';
const imageUrl = `https://test.supabase.co/storage/v1/object/public/club-assets/club-cards/${clubId}-banner-abc123.png`;
const banner = { id: 'first', title: 'First Banner', imageUrl, enabled: true };
const second = { ...banner, id: 'second', title: 'Second Banner' };
function query(result: unknown) {
  const q: any = {};
  for (const method of ['update', 'eq', 'is', 'select']) q[method] = vi.fn(() => q);
  q.maybeSingle = vi.fn().mockResolvedValue(result);
  return q;
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('VITE_SUPABASE_URL', 'https://test.supabase.co');
  mocks.resolve.mockResolvedValue([]);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});
describe('owner rotating banner persistence', () => {
  it('allows only this club storage images, never third party or other club tracking pixels', () => {
    expect(isClubRotatingImage(imageUrl, clubId)).toBe(true);
    for (const url of [
      imageUrl.replace('test.supabase.co', 'evil.example'),
      imageUrl + '?tracking=1',
      imageUrl.replace(clubId, 'other-club'),
      '//evil.example/a.png',
    ])
      expect(isClubRotatingImage(url, clubId)).toBe(false);
    expect(() => validateRotatingBanners([banner, banner], clubId)).toThrow();
    expect(() =>
      validateRotatingBanners(
        [banner, second, { ...banner, id: '3' }, { ...banner, id: '4' }],
        clubId
      )
    ).toThrow('Three');
    expect(
      readRotatingBanners(
        { rotating_banners: [banner, { ...second, imageUrl: '//evil.example' }] },
        clubId
      )
    ).toEqual([banner]);
  });
  it('uses owner RLS and whole settings CAS with no union gate, preserving other settings', async () => {
    const settings = { min_buy_in_bb: 40, rotating_banners: [banner] };
    const saved = {
      id: clubId,
      owner_id: 'owner',
      union_id: 'union',
      settings: { ...settings, rotating_banners: [second, banner] },
    };
    const q = query({ data: saved, error: null });
    mocks.from.mockReturnValue(q);
    await expect(
      saveClubRotatingBanners(clubId, 'owner', settings, [second, banner])
    ).resolves.toEqual(saved);
    expect(q.update).toHaveBeenCalledWith({ settings: saved.settings });
    expect(q.eq.mock.calls).toEqual([
      ['id', clubId],
      ['owner_id', 'owner'],
      ['settings', JSON.stringify(settings)],
    ]);
  });
  it('rejects concurrent changes and removed ownership without announcing success', async () => {
    mocks.from.mockReturnValueOnce(query({ data: null, error: null })).mockReturnValueOnce(
      query({
        data: { owner_id: 'other', settings: { rotating_banners: [banner] } },
        error: null,
      })
    );
    await expect(saveClubRotatingBanners(clubId, 'owner', {}, [banner])).rejects.toThrow('Reload');
    expect(mocks.emit).not.toHaveBeenCalled();
  });
  it('recovers committed saves regardless of JSONB key order, without overwriting later settings', async () => {
    const current = {
      owner_id: 'owner',
      settings: {
        unrelated: 'newer',
        rotating_banners: [{ enabled: true, imageUrl, title: 'First Banner', id: 'first' }],
      },
    };
    mocks.from
      .mockReturnValueOnce(query({ data: null, error: null }))
      .mockReturnValueOnce(query({ data: current, error: null }));
    await expect(saveClubRotatingBanners(clubId, 'owner', null, [banner])).resolves.toEqual(
      current
    );
  });
  it('propagates a database refusal', async () => {
    mocks.from.mockReturnValue(query({ data: null, error: new Error('denied') }));
    await expect(saveClubRotatingBanners(clubId, 'owner', {}, [banner])).rejects.toThrow('denied');
    expect(mocks.emit).not.toHaveBeenCalled();
  });
});
it('edits order, enable state and removal through the real union owner editor', async () => {
  const club = {
    id: clubId,
    name: 'Union Club',
    owner_id: 'owner',
    banner_url: null,
    union_id: 'union',
    settings: { other: 1, rotating_banners: [banner, second] },
  };
  const q = query({ data: club, error: null });
  mocks.from.mockReturnValue(q);
  const saved = vi.fn();
  render(<ClubRotatingBannerEditor club={club} ownerId="owner" onSaved={saved} />);
  fireEvent.click(screen.getByRole('button', { name: 'Move Banner 2 Up' }));
  expect((screen.getByLabelText('Banner Title 1') as HTMLInputElement).value).toBe('Second Banner');
  fireEvent.click(screen.getByLabelText('Enable Banner 1'));
  fireEvent.change(screen.getByLabelText('Banner Title 1'), { target: { value: 'Updated Title' } });
  fireEvent.click(screen.getByRole('button', { name: 'Remove Banner 2' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save Rotating Banners' }));
  await waitFor(() => expect(saved).toHaveBeenCalledOnce());
  expect(q.update).toHaveBeenCalledWith({
    settings: {
      other: 1,
      rotating_banners: [{ ...second, title: 'Updated Title', enabled: false }],
    },
  });
});
it('rotates enabled club images alongside resolved ads and never bills club banners', async () => {
  const paid = {
    adId: 'paid',
    adKey: 'paid',
    headline: 'Paid Promotion',
    imageUrl: '/paid.png',
    posterUrl: '/paid.png',
    targetUrl: '/clubs/test',
    advertiserKind: 'club',
  };
  mocks.resolve.mockResolvedValue([paid]);
  render(
    <HouseAdRotator
      slot="lobby_strip"
      clubId={clubId}
      clubSettings={{ rotating_banners: [banner, { ...second, enabled: false }] }}
      onNavigate={vi.fn()}
    />
  );
  await screen.findByAltText('First Banner');
  expect(mocks.impression).not.toHaveBeenCalled();
  expect(screen.queryByRole('tab', { name: 'Show Second Banner' })).toBeNull();
  fireEvent.click(screen.getByRole('tab', { name: 'Show Paid Promotion' }));
  await waitFor(() =>
    expect(mocks.impression).toHaveBeenCalledWith({ adId: 'paid' }, 'lobby_strip', clubId)
  );
  fireEvent.click(screen.getByRole('tab', { name: 'Show First Banner' }));
  fireEvent.click(screen.getByRole('button', { name: 'Club: First Banner' }));
  await screen.findByRole('dialog', { name: 'First Banner' });
  expect(
    screen.getAllByAltText('First Banner').every((image) => image.getAttribute('src') === imageUrl)
  ).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Close', exact: true }));
  expect(mocks.dismiss).not.toHaveBeenCalled();
  expect(mocks.click).not.toHaveBeenCalled();
});
