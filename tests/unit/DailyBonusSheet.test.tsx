/**
 * DailyBonusSheet - every tile is claimed by hand, the sheet shows only what
 * the server says, and it is the spade console, not the shark's plaques.
 */
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getStatus: vi.fn(),
  claim: vi.fn(),
  markShown: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
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
      markShown: mocks.markShown,
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
  shown_today: false,
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
  shield: { held: 0, expires_at: null },
  boost: { active: false },
  streak_protected: false,
};

const phase3Tiles = [
  tile({ slot: 1 }),
  tile({ slot: 2, kind: 'mystery', label: 'Mystery Tile', base_diamonds: 0, diamonds: 0 }),
  tile({
    slot: 3,
    kind: 'shield',
    label: 'Streak Shield',
    quantity: 1,
    base_diamonds: 0,
    diamonds: 0,
  }),
  tile({
    slot: 4,
    kind: 'boost',
    label: 'Mission Boost',
    quantity: 24,
    base_diamonds: 0,
    diamonds: 0,
  }),
];

/** The copy of one note under the tiles, by its label, whole - the clock and
 *  the diamonds-so-far sit in their own spans inside it. */
function noteText(container: HTMLElement, label: string): string {
  const note = Array.from(container.querySelectorAll('.dbs__note')).find(
    (n) => n.querySelector('dt')?.textContent?.trim() === label
  );
  return note?.querySelector('dd')?.textContent ?? '';
}

describe('DailyBonusSheet', () => {
  beforeEach(() => {
    mocks.getStatus.mockReset();
    mocks.claim.mockReset();
    mocks.markShown.mockReset();
    mocks.markShown.mockResolvedValue(undefined);
    mocks.toast.success.mockReset();
    mocks.toast.error.mockReset();
    mocks.getStatus.mockResolvedValue(status);
  });

  it('renders the server tiles with their cent value, the streak, the countdown and the week', async () => {
    const { container } = render(<DailyBonusSheet mode="inline" />);
    expect(await screen.findByText('+5')).toBeTruthy();
    expect(screen.getByText('5¢ Value')).toBeTruthy();
    expect(
      container.querySelector('.dbs-row[data-kind="rabbit_hunts"] .dbs-row__figure')?.textContent
    ).toBe('×1');
    expect(screen.getByText('01:23:45')).toBeTruthy();
    expect(screen.getByLabelText('Day 2 Streak')).toBeTruthy();
    expect(screen.getAllByRole('listitem')).toHaveLength(7);
    // No decimal where there is nothing after it: a 1x streak prints as x1.
    expect(screen.getByText('Multiplier').nextElementSibling?.textContent).toBe('×1');
  });

  it('is the spade console wearing the diamond crest, with every tile a row printed on the glass', async () => {
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
    // The chassis is the console master with the diamond crest; nothing of the shark's.
    expect(container.querySelector('.sc.sc--crest-diamond .sc__head')).toBeTruthy();
    expect(container.querySelector('.sc__foot')).toBeTruthy();
    expect(container.querySelectorAll('[class*="shark"], .dbs-plaque, .dbs-btn')).toHaveLength(0);
    // The head prints the sheet's words in the master's zones.
    expect(container.querySelector('.sc__title')?.textContent).toBe('Daily Bonus');
    expect(container.querySelector('.sc__pill')?.textContent).toBe('Day 2');
    // Every icon is a painted render; no line icons anywhere on the sheet.
    const srcs = Array.from(
      container.querySelectorAll<HTMLImageElement>('.dbs-row__render img')
    ).map((img) => img.getAttribute('src') ?? '');
    expect(srcs.some((s) => s.endsWith('images/diamond-icon.png'))).toBe(true);
    expect(srcs.some((s) => s.endsWith('game-card-icons/rabbit-hunt.png'))).toBe(true);
    expect(srcs.some((s) => s.endsWith('game-card-icons/mystery-bounty.png'))).toBe(true);
    expect(srcs.some((s) => s.endsWith('images/global-header/vip.png'))).toBe(true);
    expect(screen.getByTestId('throwable-render').getAttribute('data-id')).toBe('tomato');
    expect(container.querySelectorAll('.dbs-row__render svg')).toHaveLength(0);
    // Every claim control is a lit word in the master's ink, nothing drawn.
    for (const b of screen.getAllByRole('button', { name: 'Claim' })) {
      expect(b.className).toContain('dbs-word');
      expect(b.className).toContain('sc-ink--white');
    }
    expect(container.querySelectorAll('.dbs-row')).toHaveLength(5);
    // Inline, the console closes flat: no plates under a page section.
    expect(container.querySelector('.sc--foot')).toBeTruthy();
    expect(container.querySelectorAll('.sc-plate')).toHaveLength(0);
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

  it('the modal renders on <body>, outside any host container that could trap a fixed overlay, with the plates as its controls', async () => {
    const onClose = vi.fn();
    render(
      <div style={{ perspective: '1200px', overflow: 'hidden' }}>
        <DailyBonusSheet mode="modal" open onClose={onClose} />
      </div>
    );
    await screen.findByText('+5');
    const overlay = document.querySelector('.dbs-overlay');
    expect(overlay?.parentElement).toBe(document.body);
    // The two painted plates: NOT NOW closes, CLAIM NEXT claims the first open tile.
    const notNow = screen.getByRole('button', { name: 'Close' });
    expect(notNow.className).toContain('sc-plate');
    expect(notNow.textContent).toBe('Not Now');
    fireEvent.click(notNow);
    expect(onClose).toHaveBeenCalledTimes(1);
    mocks.claim.mockResolvedValue({
      success: true,
      slot: 1,
      granted: { kind: 'diamonds', diamonds: 5, quantity: 0, balance_after: 505 },
      streak: 2,
    });
    fireEvent.click(screen.getByRole('button', { name: 'Claim Next' }));
    await waitFor(() => expect(mocks.claim).toHaveBeenCalledWith('2026-09-08', 1));
  });

  it('says so when the account is not eligible instead of showing an empty sheet', async () => {
    mocks.getStatus.mockResolvedValue({ ...status, eligible: false, reason: 'fixture', tiles: [] });
    render(<DailyBonusSheet mode="inline" />);
    expect(
      await screen.findByText('The Daily Bonus Is Not Available On This Account.')
    ).toBeTruthy();
  });

  it('tells the server the sheet was shown, once, and not when today was already shown elsewhere', async () => {
    render(<DailyBonusSheet mode="inline" />);
    await screen.findByText('+5');
    await waitFor(() => expect(mocks.markShown).toHaveBeenCalledTimes(1));

    mocks.markShown.mockClear();
    mocks.getStatus.mockResolvedValue({ ...status, shown_today: true });
    render(<DailyBonusSheet mode="inline" />);
    await waitFor(() => expect(screen.getAllByText('+5').length).toBeGreaterThan(1));
    expect(mocks.markShown).not.toHaveBeenCalled();
  });

  it('on a host console (the /bonuses page) it prints only its content on the glass', async () => {
    const { container } = render(<DailyBonusSheet mode="inline" chassis="glass" />);
    await screen.findByText('+5');
    expect(container.querySelector('.sc__head')).toBeNull();
    expect(container.querySelector('.dbs--glass')).toBeTruthy();
    expect(container.querySelectorAll('.dbs-row')).toHaveLength(3);
  });

  // ── Phase 3: the shield, the boost and the lucky roll ──────────────────

  it('a Streak Shield tile claims into a held shield, and the sheet says what it covers', async () => {
    mocks.getStatus.mockResolvedValue({ ...status, tiles: phase3Tiles, unclaimed: 4 });
    mocks.claim.mockResolvedValue({
      success: true,
      slot: 3,
      granted: {
        kind: 'shield',
        feature: 'streak_shield',
        quantity: 1,
        diamonds: 0,
        expires_at: '2026-10-08T05:00:00+00:00',
        balance_after: 500,
      },
      streak: 2,
    });
    const { container } = render(<DailyBonusSheet mode="inline" />);
    await screen.findByText('Covers One Missed Day');
    const row = container.querySelector('.dbs-row[data-kind="shield"]');
    expect(row?.querySelector('.dbs-row__render img')?.getAttribute('src')).toContain(
      'images/challenges/daily-missions-streak-freeze-v1.webp'
    );
    fireEvent.click(screen.getAllByRole('button', { name: 'Claim' })[2]);
    await waitFor(() => expect(mocks.claim).toHaveBeenCalledWith('2026-09-08', 3));
    expect(await screen.findByText('Held For 30 Days')).toBeTruthy();
    expect(screen.getByText(/One Shield Held\. It Covers One Missed Day/)).toBeTruthy();
    expect(mocks.toast.success).toHaveBeenCalledWith('Claimed ×1 Streak Shield, Held For 30 Days');
  });

  it('a Mission Boost tile is printed as 2×, claims into a running boost with its own clock, and is refused while one runs', async () => {
    mocks.getStatus.mockResolvedValue({ ...status, tiles: phase3Tiles, unclaimed: 4 });
    mocks.claim.mockResolvedValue({
      success: true,
      slot: 4,
      granted: {
        kind: 'boost',
        factor: 2,
        hours: 24,
        quantity: 24,
        diamonds: 0,
        ends_at: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
        balance_after: 500,
      },
      streak: 2,
    });
    const { container } = render(<DailyBonusSheet mode="inline" />);
    await screen.findByText('Double Daily Mission Diamonds For 24 Hours');
    const row = container.querySelector('.dbs-row[data-kind="boost"]');
    expect(row?.querySelector('.dbs-row__render--print')?.textContent).toBe('2×');
    expect(row?.querySelector('.dbs-row__render img')).toBeNull();
    fireEvent.click(screen.getAllByRole('button', { name: 'Claim' })[3]);
    await waitFor(() => expect(mocks.claim).toHaveBeenCalledWith('2026-09-08', 4));
    expect(await screen.findByText('Running For 24 Hours')).toBeTruthy();
    // The boost readout is live the moment it is claimed, not a tick later.
    expect(noteText(container, 'Boost')).toContain('2× Daily Mission Diamonds For Another');
    expect(noteText(container, 'Boost')).toMatch(/2[34]:\d\d:\d\d/);
    expect(mocks.toast.success).toHaveBeenCalledWith(
      'Mission Boost Is Live, 2× Diamonds For 24 Hours'
    );
  });

  it('a running boost from the ledger shows its countdown, and a second boost claim is refused in the server’s words', async () => {
    mocks.getStatus.mockResolvedValue({
      ...status,
      tiles: phase3Tiles,
      unclaimed: 4,
      boost: {
        active: true,
        factor: 2,
        kind: 'mission_diamonds',
        ends_at: new Date(Date.now() + 3725 * 1000).toISOString(),
        seconds_left: 3725,
        applied_diamonds: 12,
      },
    });
    mocks.claim.mockResolvedValue({ success: false, reason: 'boost_already_live' });
    const { container } = render(<DailyBonusSheet mode="inline" />);
    await screen.findByText('Double Daily Mission Diamonds For 24 Hours');
    expect(screen.getByText('01:02:05')).toBeTruthy();
    expect(noteText(container, 'Boost')).toContain('+12 Diamonds So Far');
    fireEvent.click(screen.getAllByRole('button', { name: 'Claim' })[3]);
    await waitFor(() =>
      expect(mocks.toast.error).toHaveBeenCalledWith('A Mission Boost Is Already Running')
    );
  });

  it('a mystery tile reveals what the server rolled, lucky multiplier and all, and rolls nothing itself', async () => {
    mocks.getStatus.mockResolvedValue({ ...status, tiles: phase3Tiles, unclaimed: 4 });
    mocks.claim.mockResolvedValue({
      success: true,
      slot: 2,
      granted: { kind: 'diamonds', diamonds: 20, quantity: 0, balance_after: 520, lucky: 2 },
      revealed: { kind: 'diamonds', diamonds: 20, quantity: 0, lucky: 2 },
      streak: 2,
    });
    const { container } = render(<DailyBonusSheet mode="inline" />);
    await screen.findByText('Claim To Reveal, With A Lucky Roll Up To 5×');
    expect(screen.getByText('?')).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button', { name: 'Claim' })[1]);
    await waitFor(() => expect(mocks.claim).toHaveBeenCalledWith('2026-09-08', 2));
    expect(await screen.findByText('+20')).toBeTruthy();
    expect(screen.getByText('20¢ Credited')).toBeTruthy();
    expect(screen.getByText('Lucky Roll ×2')).toBeTruthy();
    expect(container.querySelector('.dbs-row[data-kind="mystery"][data-revealed]')).toBeTruthy();
    expect(mocks.toast.success).toHaveBeenCalledWith('Claimed +20 Diamonds (20¢), Lucky ×2');
  });

  it('a day a shield covered says so on the streak readout, and a chest day lights the pill gold', async () => {
    mocks.getStatus.mockResolvedValue({
      ...status,
      streak: 14,
      streak_day: 14,
      streak_protected: true,
      shield: { held: 1, expires_at: '2026-10-01T05:00:00+00:00' },
      week: status.week.map((d) => (d.state === 'today' ? { ...d, chest: true } : d)),
    });
    const { container } = render(<DailyBonusSheet mode="inline" />);
    await screen.findByText('+5');
    expect(screen.getByText('Shield Covered Yesterday')).toBeTruthy();
    expect(screen.getByText('Chest')).toBeTruthy();
    const pill = container.querySelector('.sc__pill');
    expect(pill?.textContent).toBe('Day 14');
    expect(pill?.className).toContain('sc-ink--gold');
    expect(screen.getByText(/One Shield Held/)).toBeTruthy();
  });
});
