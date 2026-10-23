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
  it('assigns an owner-tagged player to an agent after a review', async () => {
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

    fireEvent.change(screen.getByLabelText('Destination Agent'), {
      target: { value: 'darth-1' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    expect(await screen.findByText(/Move From Club Owner To/)).toBeInTheDocument();
    expect(preview).toHaveBeenCalledWith('club-1', ['player-1'], 'darth-1', undefined);

    fireEvent.click(screen.getByRole('button', { name: 'Confirm Move' }));
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
  });

  it('transfers between agents, guarding on the current agent', async () => {
    render(<MemberAssignAgent clubId="club-1" userId="player-1" currentAgentId="owner-1" />);
    expect(await screen.findByText('Transfer To Another Agent')).toBeInTheDocument();
    // The current agent is not offered as the destination.
    expect(screen.queryByRole('option', { name: /kingfish/ })).toBeNull();
    fireEvent.change(screen.getByLabelText('Destination Agent'), {
      target: { value: 'darth-1' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    await screen.findByRole('button', { name: 'Confirm Move' });
    expect(preview).toHaveBeenCalledWith('club-1', ['player-1'], 'darth-1', 'owner-1');
  });

  it('keeps the same operation for a retry when the outcome is unknown', async () => {
    reassign.mockRejectedValueOnce(new Error('network'));
    render(<MemberAssignAgent clubId="club-1" userId="player-1" currentAgentId={null} />);
    await screen.findByText('Assign To An Agent');
    fireEvent.change(screen.getByLabelText('Destination Agent'), {
      target: { value: 'darth-1' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm Move' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Retry Same Move' }));
    await waitFor(() => expect(reassign).toHaveBeenCalledTimes(2));
    expect(reassign.mock.calls[1][3]).toBe(reassign.mock.calls[0][3]);
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
