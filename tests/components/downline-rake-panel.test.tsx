import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  getDownlineRake: vi.fn(),
  getDownlineRakeSummary: vi.fn(),
  subscribeToRake: vi.fn(() => vi.fn()),
}));

vi.mock('../../src/services/AgentRakeService', () => ({
  AgentRakeService: {
    getDownlineRake: state.getDownlineRake,
    getDownlineRakeSummary: state.getDownlineRakeSummary,
    subscribeToRake: state.subscribeToRake,
  },
  RAKE_WINDOWS: [
    { key: 'today', label: 'Today' },
    { key: '24h', label: '24h' },
    { key: 'week', label: 'This Week' },
    { key: '30d', label: '30 Days' },
  ],
  windowToRange: () => ({ since: null, until: null }),
  describeRakeError: () => 'rake reporting is temporarily unavailable.',
}));

vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));

import DownlineRakePanel from '../../src/components/agent/DownlineRakePanel';

const roles = [
  {
    club_id: 'club-1',
    club_name: 'river sharks',
    role: 'super_agent' as const,
    agent_id: 'agent-role-1',
    is_overseer: false,
  },
  {
    club_id: 'club-2',
    club_name: 'ALL CAPS CLUB',
    role: 'agent' as const,
    agent_id: 'agent-role-2',
    is_overseer: false,
  },
];

const summary = {
  period_start: '2026-10-01T00:00:00Z',
  period_end: '2026-10-03T00:00:00Z',
  members: 1,
  active: 1,
  direct: 1,
  sub_agents: 1,
  hands: 20,
  rake_generated: 14,
  commission_rate: 0.2,
  estimated_commission: 2.8,
  last_hand_at: '2026-10-03T00:00:00Z',
  top_earner: { username: 'river shark', rake: 14 },
};

const row = (index: number, role = 'player') => ({
  player_id: `player-${index}`,
  username: index === 0 ? 'river shark' : `Player ${index}`,
  club_id: 'club-1',
  club_name: 'river sharks',
  role,
  depth: 1,
  upline_user_id: 'agent-root',
  upline_name: 'table boss',
  rake_generated: index + 1,
  hands: index + 2,
  last_hand_at: '2026-10-03T00:00:00Z',
  downline_players: role === 'agent' ? 3 : 0,
  downline_rake: role === 'agent' ? 12 : 0,
});

beforeEach(() => {
  state.getDownlineRake.mockReset();
  state.getDownlineRakeSummary.mockReset();
  state.subscribeToRake.mockClear();
  state.getDownlineRake.mockResolvedValue([row(0, 'sub_agent'), row(1)]);
  state.getDownlineRakeSummary.mockResolvedValue(summary);
});

afterEach(() => cleanup());

describe('DownlineRakePanel', () => {
  it('uses semantic controls, truthful polling copy, and preserves identity casing', async () => {
    render(<DownlineRakePanel roles={roles} />);

    const agent = await screen.findByRole('button', { name: 'Open river shark Downline' });
    expect(agent).toHaveAttribute('type', 'button');
    expect(screen.getByText('Sub Agent')).toBeVisible();
    expect(screen.getAllByText('table boss')).toHaveLength(2);
    expect(screen.getAllByText('river shark').length).toBeGreaterThan(0);
    expect(screen.getByText(/Verified 30-Second Poll \/ Last Checked/)).toBeVisible();
    expect(screen.queryByText(/^Live\b/)).not.toBeInTheDocument();

    fireEvent.click(agent);
    await waitFor(() =>
      expect(state.getDownlineRake).toHaveBeenLastCalledWith(
        expect.objectContaining({ agentUserId: 'player-0', limit: 501 })
      )
    );
    expect(screen.getByRole('button', { name: 'river shark' })).toHaveAttribute(
      'aria-current',
      'page'
    );
  });

  it('progressively reads beyond the old 500-row cap', async () => {
    state.getDownlineRake.mockImplementation(async ({ limit }: { limit: number }) =>
      Array.from({ length: limit === 501 ? 501 : 620 }, (_, i) => row(i))
    );

    render(<DownlineRakePanel roles={[roles[0]]} />);

    const more = await screen.findByRole('button', { name: 'Show 500 More Members' });
    expect(screen.getByText(/Showing 500 Members/)).toBeVisible();
    expect(screen.getAllByRole('row')).toHaveLength(501);

    fireEvent.click(more);
    await waitFor(() =>
      expect(state.getDownlineRake).toHaveBeenLastCalledWith(
        expect.objectContaining({ limit: 1001 })
      )
    );
    await waitFor(() => expect(screen.getAllByRole('row')).toHaveLength(621));
    expect(screen.queryByRole('button', { name: 'Show 500 More Members' })).not.toBeInTheDocument();
  });

  it('title-cases a dynamic error without adding generic inline chrome', async () => {
    state.getDownlineRake.mockRejectedValueOnce(new Error('offline'));
    render(<DownlineRakePanel roles={[roles[0]]} />);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Rake Reporting Is Temporarily Unavailable.'
    );

    const source = readFileSync(
      resolve(__dirname, '../../src/components/agent/DownlineRakePanel.tsx'),
      'utf8'
    );
    expect(source).toContain("import './DownlineRakePanel.css'");
    expect(source).not.toContain('style={{');
    expect(source).not.toContain('Live · Updated');
    expect(source).not.toMatch(/[♠♥♦♣▲▼▪✓✗○★☆⚠→←↑↓]/u);
  });
});
