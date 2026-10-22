/**
 * UPLINE AGENTS ON THE PLAYER RECORD (Dan 2026-10-21)
 *
 * "WHEN YOU CLICK ON ANY PLAYER INSIDE MY CLUB, I SHOULD BE ABLE TO SEE WHO IS
 * UPLINE AGENT(S) ARE. I CURRENTLY CAN'T SEE THIS."
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ClubRosterService, { type MemberUplineLevel } from '../../src/services/ClubRosterService';
import MemberUplineCard from '../../src/components/club/MemberUplineCard';

// The assignment control has its own suite (PlayerAssignAgent.test.tsx).
vi.mock('../../src/components/club/MemberAssignAgent', () => ({
  default: ({ currentAgentId }: { currentAgentId: string | null }) => (
    <div data-testid="assign-agent" data-current={currentAgentId ?? ''} />
  ),
}));

const ROOT = resolve(__dirname, '../..');
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');
const MIGRATION = read(
  'supabase/migrations/20261022044452_player_record_shows_the_full_upline_agent_chain.sql'
);
const PAGE = read('src/pages/MemberManagementPage.tsx');

const chain: MemberUplineLevel[] = [
  { depth: 1, user_id: 'a1', name: 'TomTomTamale', player_number: '925976', role: 'super_agent' },
  { depth: 2, user_id: 'o1', name: 'kingfish', player_number: '1', role: 'owner' },
];

afterEach(() => vi.restoreAllMocks());

describe('Player Record: Upline Agents card', () => {
  it('lists every agent above the player, closest first, with role and ID', async () => {
    vi.spyOn(ClubRosterService, 'getMemberUplineChain').mockResolvedValue(chain);
    render(<MemberUplineCard clubId="club-1" userId="player-1" />);

    expect(await screen.findByText('Direct Upline (Super Agent)')).toBeInTheDocument();
    expect(screen.getByText('TomTomTamale (ID: 925976)')).toBeInTheDocument();
    expect(screen.getByText('Upline Level 2 (Owner)')).toBeInTheDocument();
    expect(screen.getByText('kingfish (ID: 1)')).toBeInTheDocument();
    expect(ClubRosterService.getMemberUplineChain).toHaveBeenCalledWith(
      'club-1',
      'player-1',
      expect.any(AbortSignal)
    );
  });

  it('offers Assign To Agent with the direct upline as the current agent', async () => {
    vi.spyOn(ClubRosterService, 'getMemberUplineChain').mockResolvedValue(chain);
    render(<MemberUplineCard clubId="club-1" userId="player-1" />);
    const control = await screen.findByTestId('assign-agent');
    expect(control.getAttribute('data-current')).toBe('a1');
  });

  it('says so when the player has no upline', async () => {
    vi.spyOn(ClubRosterService, 'getMemberUplineChain').mockResolvedValue([]);
    render(<MemberUplineCard clubId="club-1" userId="player-1" />);
    expect(
      await screen.findByText('No Agent Assigned. This Player Sits Directly Under The Club Owner.')
    ).toBeInTheDocument();
  });

  it('renders nothing for a viewer the RPC denies', async () => {
    vi.spyOn(ClubRosterService, 'getMemberUplineChain').mockResolvedValue(null);
    const { container } = render(<MemberUplineCard clubId="club-1" userId="player-1" />);
    await vi.waitFor(() => expect(container.querySelector('.mm-upline')).toBeNull());
  });

  it('is on the Player Record, behind the financial view', () => {
    expect(PAGE).toMatch(
      /can_view_financials && resolvedClubId && identity!\.user_id && \(\s*<MemberUplineCard/
    );
  });
});

describe('ca_club_member_upline_chain', () => {
  it('walks the agent chain inside the club, cycle safe and capped', () => {
    expect(MIGRATION).toContain('CREATE OR REPLACE FUNCTION public.ca_club_member_upline_chain');
    expect(MIGRATION).toContain('WITH RECURSIVE chain');
    expect(MIGRATION).toContain('NOT nxt.agent_id = ANY (c.path)');
    expect(MIGRATION).toContain('c.depth < 20');
    expect(MIGRATION).toContain('cm.club_id = p_club_id AND cm.user_id = c.uid');
  });

  it('uses the record access gate and is closed to anon', () => {
    expect(MIGRATION).toContain("v_access NOT IN ('staff', 'downline', 'service')");
    expect(MIGRATION).toContain('FROM PUBLIC, anon');
    expect(MIGRATION.match(/^BEGIN;$/gm)?.length).toBe(1);
    expect(MIGRATION.match(/^COMMIT;$/gm)?.length).toBe(1);
  });
});
