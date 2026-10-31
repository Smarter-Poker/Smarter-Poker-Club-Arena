/**
 * WIN / LOSS ON PLAYERS AND THE PLAYER RECORD (Dan 2026-10-16)
 *
 * "WHEN YOU ARE ON THE PLAYERS OR PLAYER MANAGEMENT, YOU SHOULD BE ABLE TO SEE
 * THERE OVERALL WIN LOSS NUMBERS, AS WELL AS BROKEN DOWN BY DAILY, WEEKLY
 * MONTHLY ETC. CURRENTLY THAT DOESN'T EXIST."
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderHook, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ClubRosterService, {
  type MemberWinLoss,
  type RosterMember,
} from '../../src/services/ClubRosterService';
import MemberWinLossCard from '../../src/components/club/MemberWinLossCard';
import { useRosterWinLoss, WIN_LOSS_TTL_MS } from '../../src/hooks/useRosterWinLoss';
import { winLossChips } from '../../src/utils/format';

const ROOT = resolve(__dirname, '../..');
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');
const MIGRATION = read('supabase/migrations/20261017035934_player_win_loss_by_period.sql');

const figure = (cash: number, mtt: number) => ({ cash, mtt, net: cash + mtt });
const record: MemberWinLoss = {
  as_of: '2026-10-17',
  today: figure(120, -50),
  week: figure(-1250.75, 0),
  month: figure(3400, 900),
  overall: figure(0, 0),
};

function member(id: string, financial = true): RosterMember {
  return { user_id: id, can_view_financials: financial } as RosterMember;
}

afterEach(() => vi.restoreAllMocks());

describe('winLossChips', () => {
  it('signs a win, keeps the minus on a loss and never overstates either', () => {
    expect(winLossChips(1290)).toBe('+1.2K');
    expect(winLossChips(-1290)).toBe('-1.2K');
    expect(winLossChips(70)).toBe('+70');
    expect(winLossChips(-450.9)).toBe('-450');
    expect(winLossChips(0)).toBe('0');
    expect(winLossChips(-0.4)).toBe('0');
    expect(winLossChips(null)).toBe('0');
  });
});

describe('Player Record: Win / Loss card', () => {
  it('shows Today, This Week, This Month and Overall with the cash and tournament split', async () => {
    vi.spyOn(ClubRosterService, 'getMemberWinLoss').mockResolvedValue(record);
    render(<MemberWinLossCard clubId="club-1" userId="player-1" />);

    expect(await screen.findByText('Today')).toBeInTheDocument();
    expect(screen.getByText('This Week')).toBeInTheDocument();
    expect(screen.getByText('This Month')).toBeInTheDocument();
    expect(screen.getByText('Overall')).toBeInTheDocument();

    expect(screen.getByText('+70.00')).toBeInTheDocument();
    expect(screen.getByText('-1,250.75')).toBeInTheDocument();
    expect(screen.getByText('+4,300.00')).toBeInTheDocument();
    expect(screen.getByText('Cash +120.00 / Tournaments -50.00')).toBeInTheDocument();
    expect(ClubRosterService.getMemberWinLoss).toHaveBeenCalledWith(
      'club-1',
      'player-1',
      expect.any(AbortSignal)
    );
  });

  it('retains cents in each period total and both underlying categories', async () => {
    vi.spyOn(ClubRosterService, 'getMemberWinLoss').mockResolvedValue({
      ...record,
      today: figure(-0.4, 0.01),
      week: figure(1000.01, -0.02),
      month: figure(10234.57, -35.12),
      overall: figure(-1234567.89, 987.65),
    });
    const { container } = render(<MemberWinLossCard clubId="club-1" userId="player-1" />);
    await screen.findByText('-0.39');
    const rows = [...container.querySelectorAll('.mm-winloss__row')];
    expect(rows.map((row) => row.querySelector('.mm-stat__value')?.textContent)).toEqual([
      '-0.39',
      '+999.99',
      '+10,199.45',
      '-1,233,580.24',
    ]);
    expect(rows.map((row) => row.querySelector('.mm-winloss__split')?.textContent)).toEqual([
      'Cash -0.40 / Tournaments +0.01',
      'Cash +1,000.01 / Tournaments -0.02',
      'Cash +10,234.57 / Tournaments -35.12',
      'Cash -1,234,567.89 / Tournaments +987.65',
    ]);
  });

  it('colours a win up and a loss down with the record inks', async () => {
    vi.spyOn(ClubRosterService, 'getMemberWinLoss').mockResolvedValue(record);
    render(<MemberWinLossCard clubId="club-1" userId="player-1" />);
    const today = (await screen.findByText('Today')).closest('.mm-stat');
    const week = screen.getByText('This Week').closest('.mm-stat');
    const overall = screen.getByText('Overall').closest('.mm-stat');
    expect(today?.className).toContain('mm-stat--up');
    expect(week?.className).toContain('mm-stat--down');
    expect(overall?.className).not.toMatch(/mm-stat--(up|down)/);
  });

  it('renders nothing when the viewer may not see this member', async () => {
    vi.spyOn(ClubRosterService, 'getMemberWinLoss').mockResolvedValue(null);
    const { container } = render(<MemberWinLossCard clubId="club-1" userId="player-1" />);
    await waitFor(() => expect(container.querySelector('.mm-winloss')).toBeNull());
  });

  it('says so when the figures cannot be read', async () => {
    vi.spyOn(ClubRosterService, 'getMemberWinLoss').mockRejectedValue(new Error('down'));
    render(<MemberWinLossCard clubId="club-1" userId="player-1" />);
    expect(await screen.findByText('Win And Loss Could Not Be Loaded.')).toBeInTheDocument();
  });

  it('is on the Player Record wherever its financials are', () => {
    const page = read('src/pages/MemberManagementPage.tsx');
    expect(page).toContain('<MemberWinLossCard');
    expect(page).toMatch(
      /can_view_financials && resolvedClubId && identity!\.user_id && \(\s*<MemberWinLossCard/
    );
  });
});

describe('Players list: win / loss per row', () => {
  it('asks only for rows the viewer may see, once per window, and keeps each window', async () => {
    const spy = vi
      .spyOn(ClubRosterService, 'getMembersWinLoss')
      .mockImplementation(async (_club, ids, period) => {
        const out = new Map();
        ids.forEach((id) => out.set(id, figure(period === 'today' ? 5 : 50, 0)));
        return out;
      });
    const members = [member('a'), member('b', false), member('c')];
    const { result, rerender } = renderHook(
      ({ period }) => useRosterWinLoss('club-1', members, period, true),
      { initialProps: { period: 'overall' as const } as { period: 'overall' | 'today' } }
    );

    await waitFor(() => expect(result.current.get('a')?.net).toBe(50));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][1]).toEqual(['a', 'c']);
    expect(result.current.has('b')).toBe(false);

    rerender({ period: 'today' });
    await waitFor(() => expect(result.current.get('a')?.net).toBe(5));
    expect(spy).toHaveBeenCalledTimes(2);

    rerender({ period: 'overall' });
    expect(result.current.get('a')?.net).toBe(50);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('asks the whole window again once it is older than the TTL', async () => {
    let calls = 0;
    const spy = vi
      .spyOn(ClubRosterService, 'getMembersWinLoss')
      .mockImplementation(async (_club, ids) => {
        calls += 1;
        return new Map(ids.map((id) => [id, figure(calls * 10, 0)]));
      });
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const first = [member('a')];
    const { result, rerender } = renderHook(
      ({ members }) => useRosterWinLoss('club-1', members, 'overall', true),
      { initialProps: { members: first } }
    );
    await waitFor(() => expect(result.current.get('a')?.net).toBe(10));

    // Within the TTL a roster refresh asks only for new rows.
    rerender({ members: [member('a'), member('b')] });
    await waitFor(() => expect(result.current.get('b')?.net).toBe(20));
    expect(spy.mock.calls[1][1]).toEqual(['b']);

    // Past it, the next change re-asks everyone; old figures stay meanwhile.
    now.mockReturnValue(1_000_000 + WIN_LOSS_TTL_MS + 1);
    rerender({ members: [member('a'), member('b')] });
    expect(result.current.get('a')?.net).toBe(10);
    await waitFor(() => expect(result.current.get('a')?.net).toBe(30));
    expect(spy.mock.calls[2][1]).toEqual(['a', 'b']);
  });

  it('offers the window to an agent who sees only their downline', () => {
    const page = read('src/pages/ClubMembersPage.tsx');
    expect(page).toContain(
      'const showWinLoss = canUseFinancialViews || members.some((m) => m.can_view_financials);'
    );
    expect(page).toMatch(
      /useRosterWinLoss\(\s*resolvedClubId,\s*members,\s*winLossPeriod,\s*showWinLoss,\s*\w+,\s*user\?\.id,?\s*\)/
    );
    expect(page).toMatch(
      /\{showWinLoss && \(\s*<label className="members-sort members-winloss-period">/
    );
  });

  it('asks for nothing when the viewer has no financial view of the roster', () => {
    const spy = vi.spyOn(ClubRosterService, 'getMembersWinLoss');
    renderHook(() => useRosterWinLoss('club-1', [member('a')], 'overall', false));
    expect(spy).not.toHaveBeenCalled();
  });

  it('puts the window selector and the figure on the Players page', () => {
    const page = read('src/pages/ClubMembersPage.tsx');
    expect(page).toContain('aria-label="Win And Loss Period"');

    expect(page).toContain('winLoss={winLoss.get(member.user_id)}');
  });
});

describe('the migration measures money, under the record access rule', () => {
  it('reads cash from the exact hand facts and tournaments from wallet <-> prize pool legs', () => {
    expect(MIGRATION).toContain('public.club_member_play_totals');
    expect(MIGRATION).toContain('public.club_member_daily_facts');
    expect(MIGRATION).toMatch(/NOT f\.is_mtt/);
    expect(MIGRATION).toContain("l.to_type = 'player_wallet'");
    expect(MIGRATION).toContain("l.from_type = 'prize_liability'");
    expect(MIGRATION).toContain("l.status = 'posted'");
    // Tournament CHIP results are not money and must never be summed in.
    expect(MIGRATION).not.toMatch(/mtt_net\s*\)?\s*FROM public\.club_member_play_totals/);
    // Every daily-facts read is cash only: each f.is_mtt is negated.
    expect(MIGRATION.match(/f\.is_mtt/g)?.length).toBe(MIGRATION.match(/NOT f\.is_mtt/g)?.length);
  });

  it('answers only staff, downline or service viewers, and never names a horse', () => {
    expect(MIGRATION.match(/ca_club_roster_access/g)?.length).toBeGreaterThanOrEqual(2);
    expect(MIGRATION).toContain("IN ('staff', 'downline', 'service')");
    expect(MIGRATION).not.toMatch(/is_horse\s*(=|IS|AND)/);
  });

  it('is one transaction, read-only, and keeps the money helper off the public API', () => {
    expect(MIGRATION.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(MIGRATION.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(MIGRATION).not.toMatch(/\b(INSERT INTO|UPDATE public\.|DELETE FROM)\b/);
    expect(MIGRATION).toContain(
      'REVOKE ALL ON FUNCTION public.ca_club_member_tournament_money(uuid, uuid, timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;'
    );
  });
});

it('refreshes the mounted win/loss card when its record changes', async () => {
  const spy = vi.spyOn(ClubRosterService, 'getMemberWinLoss').mockResolvedValue(record);
  const view = render(<MemberWinLossCard clubId="club-1" userId="player-1" refreshKey={0} />);
  await screen.findByText('+70.00');
  spy.mockResolvedValue({ ...record, today: figure(77, 0) });
  view.rerender(<MemberWinLossCard clubId="club-1" userId="player-1" refreshKey={1} />);
  expect(await screen.findByText('+77.00')).toBeInTheDocument();
});

it('keeps verified figures visible during an in-flight background refresh', async () => {
  const spy = vi.spyOn(ClubRosterService, 'getMemberWinLoss').mockResolvedValue(record);
  const view = render(<MemberWinLossCard clubId="club-1" userId="player-1" refreshKey={0} />);
  await screen.findByText('+70.00');
  let finish!: (data: MemberWinLoss) => void;
  spy.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    })
  );
  view.rerender(<MemberWinLossCard clubId="club-1" userId="player-1" refreshKey={1} />);
  await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
  expect(screen.getByText('+70.00')).toBeInTheDocument();
  expect(screen.queryByText('Loading Win And Loss...')).not.toBeInTheDocument();
  finish({ ...record, today: figure(88, 0) });
  expect(await screen.findByText('+88.00')).toBeInTheDocument();
});

it('withdraws the old card immediately when the member changes', async () => {
  const spy = vi.spyOn(ClubRosterService, 'getMemberWinLoss').mockResolvedValue(record);
  const view = render(<MemberWinLossCard clubId="club-1" userId="player-1" />);
  await screen.findByText('+70.00');
  spy.mockReturnValueOnce(new Promise(() => {}));
  view.rerender(<MemberWinLossCard clubId="club-1" userId="player-2" />);
  expect(screen.queryByText('+70.00')).not.toBeInTheDocument();
  expect(screen.getByText('Loading Win And Loss...')).toBeInTheDocument();
});

it('keeps loaded figures with a stale note when a background refresh fails', async () => {
  const spy = vi.spyOn(ClubRosterService, 'getMemberWinLoss').mockResolvedValue(record);
  const view = render(<MemberWinLossCard clubId="club-1" userId="player-1" refreshKey={0} />);
  await screen.findByText('+70.00');
  spy.mockRejectedValueOnce(new Error('timed out'));
  view.rerender(<MemberWinLossCard clubId="club-1" userId="player-1" refreshKey={1} />);
  expect(
    await screen.findByText('Could Not Refresh Win And Loss. Showing The Previous Successful Read.')
  ).toBeInTheDocument();
  expect(screen.getByText('+70.00')).toBeInTheDocument();
  expect(screen.queryByText('Win And Loss Could Not Be Loaded.')).not.toBeInTheDocument();
  spy.mockResolvedValueOnce({ ...record, today: figure(90, 0) });
  view.rerender(<MemberWinLossCard clubId="club-1" userId="player-1" refreshKey={2} />);
  expect(await screen.findByText('+90.00')).toBeInTheDocument();
  expect(
    screen.queryByText('Could Not Refresh Win And Loss. Showing The Previous Successful Read.')
  ).not.toBeInTheDocument();
});

it('shows Unavailable on a Players row whose win / loss read failed', () => {
  const page = read('src/pages/ClubMembersPage.tsx');
  expect(page).toContain('winLossUnavailable={winLoss.unavailable.has(member.user_id)}');
  expect(page).toContain("return unavailable ? 'Unavailable' : '...';");
});

it('keeps current results visible when only historical ownership is unavailable', async () => {
  vi.spyOn(ClubRosterService, 'getMemberWinLoss').mockResolvedValue({
    ...record,
    overall: { cash: null, mtt: -50, net: null },
  });
  const { container } = render(<MemberWinLossCard clubId="club-partial" userId="player-partial" />);
  await screen.findByText('+70.00');
  const overall = screen.getByText('Overall').closest('.mm-stat');
  expect(overall?.querySelector('.mm-stat__value')?.textContent).toBe('Unavailable');
  expect(overall?.textContent).toContain('Cash Unavailable / Tournaments -50.00');
  expect(overall?.className).not.toMatch(/mm-stat--(up|down)/);
  expect(container.textContent).toContain('Some Historical Jackpot Club Records Are Missing');
});
