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
import { supabase } from '../../src/lib/supabase';

// The assignment control has its own suite (PlayerAssignAgent.test.tsx).
vi.mock('../../src/components/club/MemberAssignAgent', () => ({
  default: ({
    currentAgentId,
    underOwner,
  }: {
    currentAgentId: string | null;
    underOwner?: boolean;
  }) => (
    <div
      data-testid="assign-agent"
      data-current={currentAgentId ?? ''}
      data-owner={String(underOwner)}
    />
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

  it('a player with no agent shows the club owner, and assigns from an empty agent', async () => {
    vi.spyOn(ClubRosterService, 'getMemberUplineChain').mockResolvedValue([
      {
        depth: 1,
        user_id: 'o1',
        name: 'KingFish',
        player_number: '1',
        role: 'owner',
        assigned: false,
      },
    ]);
    render(<MemberUplineCard clubId="club-1" userId="player-1" />);
    expect(await screen.findByText('KingFish (ID: 1)')).toBeInTheDocument();
    expect(
      screen.getByText('No Agent Assigned. This Player Sits Directly Under The Club Owner.')
    ).toBeInTheDocument();
    const control = screen.getByTestId('assign-agent');
    expect(control.getAttribute('data-current')).toBe('');
    expect(control.getAttribute('data-owner')).toBe('true');
  });

  it.each([false, true])(
    'preserves assigned=%s through the real RPC adapter into the assignment control',
    async (assigned) => {
      const row = {
        depth: 1,
        user_id: 'owner-1',
        name: 'KingFish',
        player_number: '1',
        role: 'owner',
        assigned,
      };
      vi.spyOn(supabase, 'rpc').mockReturnValue({
        abortSignal: () => Promise.resolve({ data: [row], error: null }),
      } as any);
      const actual = ClubRosterService.getMemberUplineChain;
      const decoded = await actual('club-1', 'player-1');
      expect(decoded?.[0].assigned).toBe(assigned);
      render(<MemberUplineCard clubId="club-1" userId="player-1" />);
      const control = await screen.findByTestId('assign-agent');
      expect(control.getAttribute('data-current')).toBe(assigned ? 'owner-1' : '');
    }
  );

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

const OWNER_RULE = read(
  'supabase/migrations/20261022150431_upline_chain_shows_the_club_owner_only_when_the_player_has_n.sql'
);

describe('ca_club_member_upline_chain: the owner is only the default home', () => {
  it('never prints the club owner above an agent', () => {
    expect(OWNER_RULE).toContain('AND nxt.agent_id IS DISTINCT FROM v_owner');
    expect(OWNER_RULE).toContain('AND c.uid IS DISTINCT FROM v_owner');
  });

  it('shows the owner, unassigned, when the player has no agent', () => {
    expect(OWNER_RULE).toMatch(/SELECT v_owner, 1, false[\s\S]*NOT EXISTS \(SELECT 1 FROM chain\)/);
    expect(OWNER_RULE).toContain("'assigned', l.assigned");
    expect(OWNER_RULE.match(/^BEGIN;$/gm)?.length).toBe(1);
    expect(OWNER_RULE.match(/^COMMIT;$/gm)?.length).toBe(1);
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
