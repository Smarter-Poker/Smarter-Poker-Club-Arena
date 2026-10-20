import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({
  allowed: true,
  rpc: vi.fn(),
  from: vi.fn(),
  assign: vi.fn(),
  toast: vi.fn(),
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
import AgentAssignmentPanel from '../../src/components/agent/AgentAssignmentPanel';
beforeEach(() => {
  vi.clearAllMocks();
  state.allowed = true;
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
    fireEvent.click(screen.getByRole('button', { name: 'Assign Or Transfer Selected' }));
    await screen.findByRole('button', { name: 'Retry Same Assignment' });
    expect(screen.getByLabelText('Destination Agent')).toBeDisabled();
    const first = state.assign.mock.calls[0];
    expect(first.slice(0, 3)).toEqual(['club', ['player'], 'target']);
    expect(first[4]).toBe('source');
    fireEvent.click(screen.getByRole('button', { name: 'Retry Same Assignment' }));
    await waitFor(() => expect(state.toast).toHaveBeenCalledWith('1 Members Reassigned'));
    expect(state.assign.mock.calls[1]).toEqual(first);
  });
});
