/**
 * ASSIGN OR TRANSFER A PLAYER TO AN AGENT (Dan 2026-10-22)
 *
 * "THERE IS NO WAY TO CURRENTLY ASSIGN OR REASSIGN A PLAYER TO ANOTHER AGENT.
 * ... YOU NEED TO CREATE THE ABILITY TO TRANSFER A PLAYER OR ASSIGN A PLAYER TO
 * AN AGENT."
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const toastSuccess = vi.fn();
vi.mock('../../src/components/common/Toast', () => ({
  useToast: () => ({ success: toastSuccess, error: vi.fn() }),
}));
const emit = vi.hoisted(() => vi.fn());
vi.mock('../../src/core/MasterBus', () => ({ masterBus: { emit } }));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));

let canManage = true;
const rows = {
  agents: [{ user_id: 'owner-1' }, { user_id: 'darth-1' }, { user_id: 'player-1' }],
  club_members: [
    { user_id: 'owner-1', role: 'owner' },
    { user_id: 'darth-1', role: 'super_agent' },
    { user_id: 'player-1', role: 'player' },
  ],
  profiles: [
    { id: 'owner-1', username: 'kingfish' },
    { id: 'darth-1', username: 'DarthBayter' },
    { id: 'player-1', username: 'GoldDigger' },
  ],
};
function query(table: keyof typeof rows) {
  const result = Promise.resolve({ data: rows[table], error: null });
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'in']) chain[m] = () => chain;
  chain.then = result.then.bind(result);
  return chain;
}
vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    rpc: vi.fn(async () => ({ data: canManage, error: null })),
    from: (table: keyof typeof rows) => query(table),
  },
}));

const preview = vi.fn();
const reassign = vi.fn();
vi.mock('../../src/services/AgentAssignmentService', () => ({
  AgentAssignmentService: { preview: (...a: unknown[]) => preview(...a) },
}));
vi.mock('../../src/services/UnionOpsService', () => ({
  UnionOpsService: { reassignClubMembers: (...a: unknown[]) => reassign(...a) },
}));

import MemberAssignAgent from '../../src/components/club/MemberAssignAgent';

const review = {
  club_id: 'club-1',
  review_token: 'a'.repeat(32),
  destination: { user_id: 'darth-1', name: 'DarthBayter', role: 'super_agent' },
  members: [
    {
      user_id: 'player-1',
      name: 'GoldDigger',
      role: 'player',
      source_user_id: null,
      source_name: 'Club Owner',
    },
  ],
  selected_count: 1,
  affected_count: 1,
};

beforeEach(() => {
  canManage = true;
  preview.mockResolvedValue(review);
  reassign.mockResolvedValue({ success: true, operation_id: 'x', moved: 1 });
});
afterEach(() => vi.clearAllMocks());

describe('Player Record: Assign To Agent', () => {
  it('saves an owner-tagged player directly into the selected agent downline', async () => {
    const onAssigned = vi.fn();
    render(
      <MemberAssignAgent
        clubId="club-1"
        userId="player-1"
        currentAgentId={null}
        onAssigned={onAssigned}
      />
    );
    expect(await screen.findByText('Assign To An Agent')).toBeInTheDocument();
    // The player is never offered as their own agent.
    expect(screen.queryByRole('option', { name: /GoldDigger/ })).toBeNull();
    expect(screen.queryByRole('option', { name: /kingfish/ })).toBeNull();

    fireEvent.change(screen.getByLabelText('Destination Agent'), {
      target: { value: 'darth-1' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onAssigned).toHaveBeenCalled());
    const [club, members, target, opId, source, token] = reassign.mock.calls[0];
    expect([club, members, target, source, token]).toEqual([
      'club-1',
      ['player-1'],
      'darth-1',
      undefined,
      review.review_token,
    ]);
    expect(typeof opId).toBe('string');
    expect(toastSuccess).toHaveBeenCalled();
    expect(preview).toHaveBeenCalledWith('club-1', ['player-1'], 'darth-1', undefined);
    expect(emit).toHaveBeenCalledWith('AGENT_UPDATED', { clubId: 'club-1', agentId: 'darth-1' });
    expect(screen.queryByRole('button', { name: /Review|Confirm Move/ })).toBeNull();
  });

  it('transfers between agents, guarding on the current agent', async () => {
    render(<MemberAssignAgent clubId="club-1" userId="player-1" currentAgentId="owner-1" />);
    expect(await screen.findByText('Transfer To Another Agent')).toBeInTheDocument();
    // The current agent is not offered as the destination.
    expect(screen.queryByRole('option', { name: /kingfish/ })).toBeNull();
    fireEvent.change(screen.getByLabelText('Destination Agent'), {
      target: { value: 'darth-1' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(reassign).toHaveBeenCalledTimes(1));
    expect(reassign.mock.calls[0][4]).toBe('owner-1');
    expect(preview).toHaveBeenCalledWith('club-1', ['player-1'], 'darth-1', 'owner-1');
  });

  it('keeps the same operation for a retry when the outcome is unknown', async () => {
    reassign.mockRejectedValueOnce(new Error('network'));
    render(<MemberAssignAgent clubId="club-1" userId="player-1" currentAgentId={null} />);
    await screen.findByText('Assign To An Agent');
    fireEvent.change(screen.getByLabelText('Destination Agent'), {
      target: { value: 'darth-1' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Retry Same Move' }));
    await waitFor(() => expect(reassign).toHaveBeenCalledTimes(2));
    expect(reassign.mock.calls[1]).toEqual(reassign.mock.calls[0]);
    expect(preview).toHaveBeenCalledTimes(1);
  });

  it('does not write or report success when validation fails', async () => {
    preview.mockRejectedValueOnce(new Error('Agent No Longer Active'));
    render(<MemberAssignAgent clubId="club-1" userId="player-1" currentAgentId={null} />);
    await screen.findByText('Assign To An Agent');
    fireEvent.change(screen.getByLabelText('Destination Agent'), { target: { value: 'darth-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Agent No Longer Active');
    expect(reassign).not.toHaveBeenCalled();
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
    expect(screen.getByLabelText('Destination Agent')).toBeEnabled();
  });

  it('revalidates on Save after an atomic database refusal', async () => {
    reassign.mockRejectedValueOnce({
      code: '22023',
      message: 'assignment_review_changed_preview_again',
    });
    render(<MemberAssignAgent clubId="club-1" userId="player-1" currentAgentId={null} />);
    await screen.findByText('Assign To An Agent');
    fireEvent.change(screen.getByLabelText('Destination Agent'), { target: { value: 'darth-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('This Player Changed');
    expect(toastSuccess).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledTimes(1));
    expect(preview).toHaveBeenCalledTimes(2);
    expect(reassign.mock.calls[1][3]).not.toBe(reassign.mock.calls[0][3]);
  });

  it('locks selection and prevents duplicate saves while validation is pending', async () => {
    let resolve!: (value: typeof review) => void;
    preview.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      })
    );
    render(<MemberAssignAgent clubId="club-1" userId="player-1" currentAgentId={null} />);
    await screen.findByText('Assign To An Agent');
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Destination Agent'), { target: { value: 'darth-1' } });
    const save = screen.getByRole('button', { name: 'Save' });
    fireEvent.click(save);
    fireEvent.click(save);
    expect(screen.getByLabelText('Destination Agent')).toBeDisabled();
    expect(preview).toHaveBeenCalledTimes(1);
    resolve(review);
    await waitFor(() => expect(reassign).toHaveBeenCalledTimes(1));
  });

  it('does not apply an old validation after navigating to another player', async () => {
    let resolve!: (value: typeof review) => void;
    preview.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      })
    );
    const { rerender } = render(
      <MemberAssignAgent clubId="club-1" userId="player-1" currentAgentId={null} />
    );
    await screen.findByText('Assign To An Agent');
    fireEvent.change(screen.getByLabelText('Destination Agent'), { target: { value: 'darth-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    rerender(<MemberAssignAgent clubId="club-1" userId="player-2" currentAgentId={null} />);
    resolve(review);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled());
    expect(reassign).not.toHaveBeenCalled();
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it('is hidden from anyone who cannot manage club assignments', async () => {
    canManage = false;
    const { container } = render(
      <MemberAssignAgent clubId="club-1" userId="player-1" currentAgentId={null} />
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(container.querySelector('.mm-assign')).toBeNull();
  });
});
