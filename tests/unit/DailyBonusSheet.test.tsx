/**
 * DailyBonusSheet - every tile is claimed by hand, and the sheet shows only
 * what the server says.
 */
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getStatus: vi.fn(),
  claim: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('../../src/components/common/Toast', () => ({ useToast: () => mocks.toast }));
vi.mock('../../src/services/HapticService', () => ({ triggerHaptic: () => true }));
vi.mock('../../src/utils/playPremiumSfx', () => ({ playPremiumSfx: () => undefined }));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: () => undefined }));
vi.mock('../../src/components/table/ThrowableImage', () => ({
  ThrowableImage: ({ throwableId }: { throwableId: string }) => (
    <img alt="" data-testid="throwable-render" data-id={throwableId} />
  ),
}));
vi.mock('../../src/services/DailyBonusService', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/DailyBonusService')>(
    '../../src/services/DailyBonusService'
  );
  return {
    ...actual,
    dailyBonusService: {
      getStatus: mocks.getStatus,
      claim: mocks.claim,
      requestIdFor: () => 'req',
    },
  };
});

import DailyBonusSheet from '../../src/components/daily-bonus/DailyBonusSheet';

const tile = (over: Record<string, unknown>) => ({
  slot: 1,
  kind: 'diamonds',
  label: 'Diamonds',
  vip_only: false,
  quantity: 0,
  base_diamonds: 5,
  diamonds: 5,
  claimed: false,
  claimed_at: null,
  granted: null,
  locked: false,
  capped: false,
  ...over,
});

const status = {
  eligible: true,
  today: '2026-09-08',
  reset_at: '2026-09-09T05:00:00+00:00',
  seconds_to_reset: 5025,
  streak: 2,
  cycle_day: 2,
  streak_day: null,
  multiplier: 1,
  is_vip: false,
  claimed_today: false,
  unclaimed: 2,
  tiles: [
    tile({ slot: 1 }),
    tile({
      slot: 2,
      kind: 'rabbit_hunts',
      label: 'Rabbit Hunt',
      quantity: 1,
      base_diamonds: 0,
      diamonds: 0,
    }),
    tile({
      slot: 5,
      label: 'VIP Bonus',
      vip_only: true,
      base_diamonds: 10,
      diamonds: 10,
      locked: true,
    }),
  ],
  week: [1, 2, 3, 4, 5, 6, 7].map((day) => ({
    day,
    streak: day,
    diamonds: day * 7,
    extras: null,
    state: day < 2 ? 'done' : day === 2 ? 'today' : 'upcoming',
  })),
  tomorrow: [{ kind: 'diamonds', label: 'Diamonds', vip_only: false, quantity: 0, diamonds: 10 }],
  caps: {
    daily_cap: 110,
    daily_used: 0,
    daily_remaining: 110,
    monthly_cap: 3300,
    monthly_used: 0,
    monthly_remaining: 3300,
    bonus_monthly_cap: 3750,
    bonus_monthly_used: 0,
    bonus_monthly_remaining: 3750,
    frozen: false,
  },
  cents_per_diamond: 1,
};

describe('DailyBonusSheet', () => {
  beforeEach(() => {
    mocks.getStatus.mockReset();
    mocks.claim.mockReset();
    mocks.toast.success.mockReset();
    mocks.toast.error.mockReset();
    mocks.getStatus.mockResolvedValue(status);
  });

  it('renders the server tiles with their cent value, the streak, the countdown and the week', async () => {
    render(<DailyBonusSheet mode="inline" />);
    expect(await screen.findByText('+5')).toBeTruthy();
    expect(screen.getByText('5¢ Value')).toBeTruthy();
    expect(screen.getByText('×1')).toBeTruthy();
    expect(screen.getByText('01:23:45')).toBeTruthy();
    expect(screen.getByLabelText('Day 2 Streak')).toBeTruthy();
    expect(screen.getAllByRole('listitem')).toHaveLength(7);
  });

  it('is cut from the console art: painted renders for icons, the console faces for buttons', async () => {
    mocks.getStatus.mockResolvedValue({
      ...status,
      tiles: [
        tile({ slot: 1 }),
        tile({
          slot: 2,
          kind: 'throwables',
          label: 'Throwables',
          quantity: 2,
          base_diamonds: 0,
          diamonds: 0,
        }),
        tile({
          slot: 3,
          kind: 'rabbit_hunts',
          label: 'Rabbit Hunt',
          quantity: 1,
          base_diamonds: 0,
          diamonds: 0,
        }),
        tile({ slot: 4, kind: 'mystery', label: 'Mystery Tile', base_diamonds: 0, diamonds: 0 }),
        tile({ slot: 5, label: 'VIP Bonus', vip_only: true, base_diamonds: 10, diamonds: 10 }),
      ],
    });
    const { container } = render(<DailyBonusSheet mode="inline" />);
    await screen.findByText('+5');
    const srcs = Array.from(
      container.querySelectorAll<HTMLImageElement>('.dbs-tile__icon img')
    ).map((img) => img.getAttribute('src') ?? '');
    expect(srcs.some((s) => s.endsWith('images/diamond-icon.png'))).toBe(true);
    expect(srcs.some((s) => s.endsWith('game-card-icons/rabbit-hunt.png'))).toBe(true);
    expect(srcs.some((s) => s.endsWith('game-card-icons/mystery-bounty.png'))).toBe(true);
    expect(srcs.some((s) => s.endsWith('images/global-header/vip.png'))).toBe(true);
    expect(screen.getByTestId('throwable-render').getAttribute('data-id')).toBe('tomato');
    // No line icons anywhere on the sheet: every tile icon is a render.
    expect(container.querySelectorAll('.dbs-tile__icon svg')).toHaveLength(0);
    // Every claim control is the console's own button face.
    for (const b of screen.getAllByRole('button', { name: 'Claim' })) {
      expect(b.className).toContain('dbs-btn');
    }
    // The readouts, the week and the tiles all sit on the card's plaque.
    expect(container.querySelectorAll('.dbs__readouts .dbs-plaque')).toHaveLength(3);
    expect(container.querySelectorAll('.dbs__week .dbs-plaque')).toHaveLength(7);
    expect(container.querySelectorAll('.dbs-tile .dbs-plaque')).toHaveLength(5);
  });

  it('a VIP tile is locked for a non-VIP and has no claim control', async () => {
    render(<DailyBonusSheet mode="inline" />);
    await screen.findByText('+5');
    expect(screen.getByText('VIP Members Only')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Claim' })).toHaveLength(2);
  });

  it('claims one tile by hand and shows what the ledger actually granted', async () => {
    mocks.claim.mockResolvedValue({
      success: true,
      slot: 1,
      granted: { kind: 'diamonds', diamonds: 5, quantity: 0, balance_after: 505 },
      streak: 2,
      first_claim_of_day: true,
    });
    render(<DailyBonusSheet mode="inline" />);
    await screen.findByText('+5');
    fireEvent.click(screen.getAllByRole('button', { name: 'Claim' })[0]);
    await waitFor(() => expect(mocks.claim).toHaveBeenCalledWith('2026-09-08', 1));
    expect(await screen.findByText('Claimed')).toBeTruthy();
    expect(screen.getByText('5¢ Credited')).toBeTruthy();
    expect(mocks.toast.success).toHaveBeenCalledWith('Claimed +5 Diamonds (5¢)');
    expect(screen.getByText('Streak Locked In For Today.')).toBeTruthy();
  });

  it('surfaces a server refusal in the server’s words and leaves the tile claimable', async () => {
    mocks.claim.mockResolvedValue({ success: false, reason: 'daily_cap' });
    render(<DailyBonusSheet mode="inline" />);
    await screen.findByText('+5');
    fireEvent.click(screen.getAllByRole('button', { name: 'Claim' })[0]);
    await waitFor(() =>
      expect(mocks.toast.error).toHaveBeenCalledWith('Daily Diamond Cap Reached')
    );
    expect(screen.queryByText('Claimed')).toBeNull();
  });

  it('the modal renders on <body>, outside any host container that could trap a fixed overlay', async () => {
    render(
      <div style={{ perspective: '1200px', overflow: 'hidden' }}>
        <DailyBonusSheet mode="modal" open onClose={() => undefined} />
      </div>
    );
    await screen.findByText('+5');
    const overlay = document.querySelector('.dbs-overlay');
    expect(overlay?.parentElement).toBe(document.body);
  });

  it('says so when the account is not eligible instead of showing an empty sheet', async () => {
    mocks.getStatus.mockResolvedValue({ ...status, eligible: false, reason: 'fixture', tiles: [] });
    render(<DailyBonusSheet mode="inline" />);
    expect(
      await screen.findByText('The Daily Bonus Is Not Available On This Account.')
    ).toBeTruthy();
  });
});
