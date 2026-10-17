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
import { useRosterWinLoss } from '../../src/hooks/useRosterWinLoss';
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

    expect(screen.getByText('+70')).toBeInTheDocument();
    expect(screen.getByText('-1.2K')).toBeInTheDocument();
    expect(screen.getByText('+4.3K')).toBeInTheDocument();
    expect(screen.getByText('Cash +120 / Tournaments -50')).toBeInTheDocument();
    expect(ClubRosterService.getMemberWinLoss).toHaveBeenCalledWith(
      'club-1',
      'player-1',
      expect.any(AbortSignal)
    );
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

  it('asks for nothing when the viewer has no financial view of the roster', () => {
    const spy = vi.spyOn(ClubRosterService, 'getMembersWinLoss');
    renderHook(() => useRosterWinLoss('club-1', [member('a')], 'overall', false));
    expect(spy).not.toHaveBeenCalled();
  });

  it('puts the window selector and the figure on the Players page', () => {
    const page = read('src/pages/ClubMembersPage.tsx');
    expect(page).toContain('aria-label="Win And Loss Period"');
    expect(page).toContain(
      'useRosterWinLoss(resolvedClubId, members, winLossPeriod, canUseFinancialViews)'
    );
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
