/**
 * A member's club status is changed only by the server.
 *
 * MembershipService.updateStatus used to write club_members.status from the
 * browser. The RLS policy lets a member update their own row, so a member
 * whom staff had suspended could set themselves back to active. The status
 * now goes through fn_club_set_member_status, which decides who may change
 * whom and records why (supabase/migrations/20260924045900_...; proved in
 * scripts/ci/test-member-status-server-owned.py). These tests pin the client
 * half: the RPC is the only write, and a refusal reaches the operator in the
 * server's own words.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const rpc = vi.fn();
const from = vi.fn();
const emit = vi.fn();

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    rpc: (...args: unknown[]) => rpc(...args),
    from: (...args: unknown[]) => from(...args),
  },
}));

vi.mock('../../src/core/MasterBus', () => ({
  masterBus: { emit: (...args: unknown[]) => emit(...args), subscribe: vi.fn(() => vi.fn()) },
}));

vi.mock('../../src/utils/clubIdResolver', () => ({
  resolveClubUUID: (id: string) => Promise.resolve(`uuid-of-${id}`),
}));

import { MembershipService } from '../../src/services/MembershipService';

describe('MembershipService.updateStatus asks the server', () => {
  beforeEach(() => {
    rpc.mockReset();
    from.mockReset();
    emit.mockReset();
  });

  it('calls fn_club_set_member_status and never writes club_members itself', async () => {
    rpc.mockResolvedValue({
      data: { success: true, unchanged: false, new_status: 'suspended', audit_id: 'a1' },
      error: null,
    });

    await expect(
      MembershipService.updateStatus('club-7', 'user-9', 'suspended', 'Chip Dumping Review')
    ).resolves.toBe(true);

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('fn_club_set_member_status', {
      p_club_id: 'uuid-of-club-7',
      p_user_id: 'user-9',
      p_status: 'suspended',
      p_reason: 'Chip Dumping Review',
    });
    expect(from).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledWith('CLUB_UPDATED', { clubId: 'uuid-of-club-7' });
  });

  it('sends a null reason when none is given', async () => {
    rpc.mockResolvedValue({ data: { success: true, new_status: 'active' }, error: null });
    await MembershipService.updateStatus('club-7', 'user-9', 'active');
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_status: 'active', p_reason: null });
  });

  it("throws the server's refusal in its own words and announces nothing", async () => {
    rpc.mockResolvedValue({
      data: { success: false, error: "The Club Owner's Membership Cannot Be Suspended Or Banned" },
      error: null,
    });

    await expect(MembershipService.updateStatus('club-7', 'owner-1', 'suspended')).rejects.toThrow(
      "The Club Owner's Membership Cannot Be Suspended Or Banned"
    );
    expect(emit).not.toHaveBeenCalled();
  });

  it('throws when the call itself fails', async () => {
    rpc.mockResolvedValue({ data: null, error: new Error('permission denied') });
    await expect(MembershipService.updateStatus('club-7', 'user-9', 'banned')).rejects.toThrow(
      'permission denied'
    );
    expect(emit).not.toHaveBeenCalled();
  });

  it('refuses an answer with no success flag as a success', async () => {
    rpc.mockResolvedValue({ data: null, error: null });
    await expect(MembershipService.updateStatus('club-7', 'user-9', 'banned')).rejects.toThrow(
      'The Club Did Not Accept The Status Change'
    );
  });

  it('refuses a success that does not name the status that was asked for', async () => {
    rpc.mockResolvedValue({ data: { success: true, new_status: 'active' }, error: null });
    await expect(MembershipService.updateStatus('club-7', 'user-9', 'suspended')).rejects.toThrow(
      'The Club Did Not Confirm The Status Change'
    );
    expect(emit).not.toHaveBeenCalled();
  });

  it('refuses an approved member answered as approved when active was asked for', async () => {
    // The server treats 'approved' as already active and changes nothing, but
    // it did not confirm the exact status asked for, so this is not a success.
    rpc.mockResolvedValue({
      data: [{ success: true, unchanged: true, new_status: 'approved' }],
      error: null,
    });
    await expect(MembershipService.updateStatus('club-7', 'user-9', 'active')).rejects.toThrow(
      'The Club Did Not Confirm The Status Change'
    );
    expect(emit).not.toHaveBeenCalled();
  });

  it('reads a one-row array answer the same as an object answer', async () => {
    rpc.mockResolvedValue({
      data: [{ success: true, unchanged: false, new_status: 'banned' }],
      error: null,
    });
    await expect(MembershipService.updateStatus('club-7', 'user-9', 'banned')).resolves.toBe(true);
    expect(emit).toHaveBeenCalledWith('CLUB_UPDATED', { clubId: 'uuid-of-club-7' });
  });
});

describe('the Suspend action shows why it was refused', () => {
  const page = readFileSync(resolve(__dirname, '../../src/pages/ClubDetailPage.tsx'), 'utf8');
  const service = readFileSync(
    resolve(__dirname, '../../src/services/MembershipService.ts'),
    'utf8'
  );

  it("ClubDetailPage's member action catch surfaces the server reason for a suspend", () => {
    expect(page).toContain("MembershipService.updateStatus(clubId, memberUserId, 'suspended')");
    expect(page).toMatch(
      /action === 'suspend'\s*\?\s*safeErrorMessage\(error, 'Could Not Suspend This Member'\)/
    );
  });

  it('MembershipService no longer writes a status column from the browser', () => {
    expect(service).not.toMatch(/\.update\(\{\s*status\b/);
  });

  it('Ban and Unban go through the same server door and show its refusal', () => {
    const panel = readFileSync(
      resolve(__dirname, '../../src/components/admin/ClubMemberManagement.tsx'),
      'utf8'
    );
    expect(panel).toContain(
      "await MembershipService.updateStatus(clubId, memberId, currentlyBanned ? 'active' : 'banned')"
    );
    expect(panel).not.toMatch(/\.update\(\{\s*status\b/);
    expect(panel).toContain("toast.error(safeErrorMessage(err, 'Failed To Update Ban Status'))");
  });
});
