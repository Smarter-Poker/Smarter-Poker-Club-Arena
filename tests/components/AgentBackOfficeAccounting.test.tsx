import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
const state = vi.hoisted(() => ({
  user: { id: 'owner' } as { id: string } | null,
  roster: vi.fn(),
  statement: vi.fn(),
}));
vi.mock('../../src/hooks/useAuthUser', () => ({ useAuthUser: () => ({ user: state.user }) }));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
vi.mock('../../src/services/UnionOpsService', () => ({
  UnionOpsService: { getAgentRoster: state.roster, getAgentStatement: state.statement },
  describeRpcError: (e: Error) => e.message,
}));
import AgentBackOffice from '../../src/components/agent/AgentBackOffice';
const statement = {
  agent_user_id: 'agent',
  period_start: '2026-09-07T07:00Z',
  period_end: '2026-09-14T07:00Z',
  players: 0,
  rake_generated: 12.34,
  commission_earned: 10.23,
  rakeback_passed_to_players: 0,
  commission_net_of_rakeback: 10.23,
  player_net_result: 0,
  credit_outstanding: 0,
  net_settlement_position: null,
  settlement_verified: false,
};
beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  state.user = { id: 'owner' };
  state.roster.mockResolvedValue([]);
  state.statement.mockResolvedValue(statement);
});
describe('agent accounting evidence', () => {
  it('requests the selected club and never displays an unverified amount as due', async () => {
    render(<AgentBackOffice agentUserId="agent" clubId="club-a" />);
    await screen.findByText('Settlement Requires Reconciliation');
    expect(state.roster).toHaveBeenCalledWith('agent', undefined, undefined, 'club-a');
    expect(state.statement).toHaveBeenCalledWith('agent', undefined, undefined, 'club-a');
    expect(screen.queryByText(/Due To You|Due From You/)).toBeNull();
    expect(screen.getByText('12.34')).toBeDefined();
  });
  it('cannot render stale club A data after club B is selected', async () => {
    let finish!: (value: unknown) => void;
    state.statement.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      })
    );
    const view = render(<AgentBackOffice agentUserId="agent" clubId="club-a" />);
    await waitFor(() => expect(state.statement).toHaveBeenCalledTimes(1));
    state.statement.mockResolvedValueOnce({ ...statement, rake_generated: 98.76 });
    view.rerender(<AgentBackOffice agentUserId="agent" clubId="club-b" />);
    await screen.findByText('98.76');
    await act(async () => {
      finish(statement);
    });
    expect(screen.queryByText('12.34')).toBeNull();
  });
  it('shows failure instead of treating an unavailable statement as zero debt', async () => {
    state.statement.mockRejectedValueOnce(new Error('Statement Unavailable'));
    render(<AgentBackOffice clubId="club-a" />);
    await screen.findByText('Statement Unavailable');
    expect(screen.queryByText('No Players Assigned Yet.')).toBeNull();
  });
  it('removes account data immediately on signout', async () => {
    const view = render(<AgentBackOffice clubId="club-a" />);
    await screen.findByText('12.34');
    state.user = null;
    view.rerender(<AgentBackOffice clubId="club-a" />);
    expect(screen.queryByText('12.34')).toBeNull();
    await screen.findByText('Sign In To View Your Statement');
  });
});
