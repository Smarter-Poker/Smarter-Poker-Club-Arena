import { beforeEach, expect, it, vi } from 'vitest';
const rpc = vi.hoisted(() => vi.fn());
vi.mock('../../src/lib/supabase', () => ({ supabase: { rpc } }));
import { AgentAssignmentService } from '../../src/services/AgentAssignmentService';
const review = {
  club_id: 'club',
  review_token: 'a'.repeat(32),
  destination: { user_id: 'agent', name: 'Agent', role: 'agent' },
  members: [
    {
      user_id: 'player',
      name: 'Player',
      role: 'player',
      source_user_id: null,
      source_name: 'Unassigned',
    },
  ],
  selected_count: 1,
  affected_count: 1,
};
beforeEach(() => rpc.mockReset());
it('validates the server preview against exactly the requested members and destination', async () => {
  rpc.mockResolvedValue({ data: review, error: null });
  expect(await AgentAssignmentService.preview('club', ['player'], 'agent')).toEqual(review);
  await expect(AgentAssignmentService.preview('other', ['player'], 'agent')).rejects.toThrow(
    'Could Not Be Verified'
  );
  await expect(AgentAssignmentService.preview('club', ['unrelated'], 'agent')).rejects.toThrow(
    'Could Not Be Verified'
  );
});
it('refuses malformed nested history review before rendering it', async () => {
  const row = {
    operation_id: 'operation',
    created_at: '2026-10-21T18:00:00Z',
    actor_name: 'Admin',
    source_name: 'Source',
    destination_name: 'Destination',
    moved: 1,
    review: { ...review, members: 'broken' },
  };
  rpc.mockResolvedValue({ data: { rows: [row], page_size: 25 }, error: null });
  await expect(AgentAssignmentService.history('club', '')).rejects.toThrow('Could Not Be Verified');
});
it('preserves opaque keyset cursors and detects the extra pagination row', async () => {
  const rows = Array.from({ length: 26 }, (_, i) => ({
    operation_id: String(i),
    created_at: '2026-10-21T18:00:00Z',
    actor_name: 'Admin',
    source_name: 'Source',
    destination_name: 'Destination',
    moved: 1,
    review: null,
  }));
  rpc.mockResolvedValue({ data: { rows, page_size: 25 }, error: null });
  const page = await AgentAssignmentService.history('club', 'Player', {
    at: '2026-10-21T18:00:00Z',
    id: 'previous',
  });
  expect(page.rows).toHaveLength(25);
  expect(page.hasMore).toBe(true);
  expect(rpc).toHaveBeenCalledWith(
    'fn_club_assignment_history',
    expect.objectContaining({ p_before_id: 'previous', p_search: 'Player', p_limit: 25 })
  );
});
