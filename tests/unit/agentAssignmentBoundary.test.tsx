import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({
  allowed: true,
  rpc: vi.fn(),
  from: vi.fn(),
  assign: vi.fn(),
  toast: vi.fn(),
  preview: vi.fn(),
  history: vi.fn(),
}));
vi.mock('../../src/stores/useUserStore', () => ({
  useUserStore: (select: (state: unknown) => unknown) => select({ user: { id: 'viewer' } }),
}));
vi.mock('../../src/lib/supabase', () => ({ supabase: { rpc: state.rpc, from: state.from } }));
vi.mock('../../src/services/UnionOpsService', () => ({
  UnionOpsService: { reassignClubMembers: state.assign },
}));
vi.mock('../../src/components/common/Toast', () => ({
  useToast: () => ({ success: state.toast }),
}));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
vi.mock('../../src/utils/fetchAllRows', () => ({
  fetchAllRows: async () => [
    { user_id: 'player', role: 'player', agent_id: 'source' },
    { user_id: 'source', role: 'agent', agent_id: null },
    { user_id: 'target', role: 'super_agent', agent_id: null },
  ],
}));
vi.mock('../../src/services/AgentAssignmentService', () => ({
  AgentAssignmentService: { preview: state.preview, history: state.history },
}));
import AgentAssignmentPanel from '../../src/components/agent/AgentAssignmentPanel';
beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  state.allowed = true;
  state.preview.mockImplementation(async (club, ids, target) => ({
    club_id: club,
    review_token: 'a'.repeat(32),
    destination: { user_id: target, name: 'Target Agent', role: 'super_agent' },
    members: ids.map((id: string) => ({
      user_id: id,
      name: 'Player One',
      role: 'player',
      source_user_id: 'source',
      source_name: 'Source Agent',
    })),
    selected_count: ids.length,
    affected_count: 3,
  }));
  state.history.mockResolvedValue({ rows: [], hasMore: false });
  state.rpc.mockImplementation(async () => ({ data: state.allowed, error: null }));
  state.from.mockReturnValue({
    select: () => ({
      in: async () => ({
        data: [
          { id: 'player', alias: 'Player One' },
          { id: 'source', alias: 'Source Agent' },
          { id: 'target', alias: 'Target Agent' },
        ],
        error: null,
      }),
    }),
  });
  state.assign.mockImplementation(async (_club, members, _target, op) => ({
    success: true,
    operation_id: op,
    moved: members.length,
  }));
});
describe('assignment access and safe retry', () => {
  it('never loads the club roster for an unauthorized agent', async () => {
    state.allowed = false;
    render(<AgentAssignmentPanel clubId="club" />);
    await waitFor(() => expect(screen.queryByText('Loading Assignment Controls...')).toBeNull());
    expect(state.from).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('Members To Move')).toBeNull();
  });
  it('moves the selected source downline and retains exactly the same operation on an unknown response', async () => {
    state.assign.mockRejectedValueOnce(new Error('Network disconnected'));
    render(<AgentAssignmentPanel clubId="club" />);
    await screen.findByLabelText('Current Agent');
    fireEvent.change(screen.getByLabelText('Current Agent'), { target: { value: 'source' } });
    fireEvent.click(screen.getByRole('button', { name: 'Select All Shown' }));
    fireEvent.change(screen.getByLabelText('Destination Agent'), { target: { value: 'target' } });
    fireEvent.click(screen.getByRole('button', { name: 'Review Assignment Or Transfer' }));
    await screen.findByRole('button', { name: 'Confirm Transfer' });
    expect(state.assign).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Transfer Preview')).toHaveTextContent('3 Total Members');
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Transfer' }));
    await screen.findByRole('button', { name: 'Retry Same Assignment' });
    expect(screen.getByLabelText('Destination Agent')).toBeDisabled();
    const first = state.assign.mock.calls[0];
    expect(first.slice(0, 3)).toEqual(['club', ['player'], 'target']);
    expect(first[4]).toBe('source');
    expect(first[5]).toBe('a'.repeat(32));
    fireEvent.click(screen.getByRole('button', { name: 'Retry Same Assignment' }));
    await waitFor(() => expect(state.toast).toHaveBeenCalledWith('1 Members Reassigned'));
    expect(state.assign.mock.calls[1]).toEqual(first);
  });
  it('requires a new review after a stale hierarchy refusal', async () => {
    state.assign.mockRejectedValueOnce({
      code: '22023',
      message: 'assignment_review_changed_preview_again',
    });
    render(<AgentAssignmentPanel clubId="club" />);
    await screen.findByLabelText('Current Agent');
    fireEvent.change(screen.getByLabelText('Current Agent'), { target: { value: 'source' } });
    fireEvent.click(screen.getByRole('button', { name: 'Select All Shown' }));
    fireEvent.change(screen.getByLabelText('Destination Agent'), { target: { value: 'target' } });
    fireEvent.click(screen.getByRole('button', { name: 'Review Assignment Or Transfer' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm Transfer' }));
    await screen.findByRole('button', { name: 'Review Assignment Or Transfer' });
    expect(screen.queryByLabelText('Transfer Preview')).toBeNull();
    expect(screen.getByLabelText('Destination Agent')).not.toBeDisabled();
    expect(state.assign).toHaveBeenCalledTimes(1);
  });
  it('loads staff history through the scoped search service', async () => {
    render(<AgentAssignmentPanel clubId="club" />);
    await screen.findByLabelText('Search Transfers');
    fireEvent.change(screen.getByLabelText('Search Transfers'), {
      target: { value: 'Player One' },
    });
    // Search is disabled while the first history page loads; a click on the
    // disabled submit is dropped, so wait for the control like a player would.
    const searchHistory = screen.getByRole('button', { name: 'Search History' });
    await waitFor(() => expect(searchHistory).toBeEnabled());
    fireEvent.click(searchHistory);
    await waitFor(() =>
      expect(state.history).toHaveBeenLastCalledWith('club', 'Player One', undefined)
    );
  });
  it('recovers exactly the same request after an interrupted screen remount', async () => {
    state.assign.mockRejectedValueOnce(new Error('Response Unknown'));
    const view = render(<AgentAssignmentPanel clubId="club" />);
    await screen.findByLabelText('Current Agent');
    fireEvent.change(screen.getByLabelText('Current Agent'), { target: { value: 'source' } });
    fireEvent.click(screen.getByRole('button', { name: 'Select All Shown' }));
    fireEvent.change(screen.getByLabelText('Destination Agent'), { target: { value: 'target' } });
    fireEvent.click(screen.getByRole('button', { name: 'Review Assignment Or Transfer' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm Transfer' }));
    await screen.findByRole('button', { name: 'Retry Same Assignment' });
    const request = state.assign.mock.calls[0];
    view.unmount();
    render(<AgentAssignmentPanel clubId="club" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Retry Same Assignment' }));
    await waitFor(() => expect(state.assign).toHaveBeenCalledTimes(2));
    expect(state.assign.mock.calls[1]).toEqual(request);
    await waitFor(() =>
      expect(sessionStorage.getItem('agent_assignment_intent_v1:viewer:club')).toBeNull()
    );
  });
});
