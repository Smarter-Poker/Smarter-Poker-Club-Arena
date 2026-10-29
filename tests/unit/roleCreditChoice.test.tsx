// @vitest-environment happy-dom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn(), roles: vi.fn(), toast: vi.fn() }));
vi.mock('../../src/lib/supabase', () => ({ supabase: { rpc: mocks.rpc, from: mocks.from } }));
vi.mock('../../src/components/common/Toast', () => ({
  useToast: () => ({ success: mocks.toast }),
}));
vi.mock('../../src/services/ClubRosterService', () => ({
  default: { getGrantableRoles: mocks.roles },
}));
vi.mock('../../src/components/agent/ChipTransferModal', () => ({ default: () => null }));
import { RoleSection } from '../../src/pages/MemberManagementPage';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.roles.mockResolvedValue(['agent', 'sub_agent']);
  const query: any = {
    select: () => query,
    eq: () => query,
    abortSignal: () => query,
    maybeSingle: async () => ({
      data: {
        id: 'agent-row',
        club_id: 'club',
        user_id: 'member',
        role: 'agent',
        is_prepaid: false,
        credit_limit: 1234,
        credit_used: 0,
      },
      error: null,
    }),
  };
  mocks.from.mockReturnValue(query);
  mocks.rpc.mockImplementation(() => ({
    abortSignal: () =>
      Promise.resolve({ data: { success: false, error: 'Test Refusal' }, error: null }),
  }));
});
afterEach(cleanup);

async function openRole(targetRole: 'player' | 'super_agent' = 'player') {
  render(
    <RoleSection
      resolvedClubId="club"
      targetUserId="member"
      targetName="Member"
      targetRole={targetRole}
      myRole="owner"
      onRoleChanged={vi.fn()}
    />
  );
  fireEvent.click(await screen.findByRole('button', { name: /^Agent/ }));
  fireEvent.change(screen.getByLabelText('Agent Rakeback Percent (0 To 70)'), {
    target: { value: '40' },
  });
}

describe('role funding agreement', () => {
  it('requires an explicit funding choice', async () => {
    await openRole();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(await screen.findByText('Choose Prepaid Or A Credit Line.')).toBeTruthy();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it.each(['', '0', '-1', '1.5'])(
    'rejects invalid credit amount %s before writing',
    async (amount) => {
      await openRole();
      fireEvent.change(screen.getByLabelText('Funding'), { target: { value: 'credit' } });
      fireEvent.change(screen.getByLabelText('Credit Limit In Chips'), {
        target: { value: amount },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
      expect(
        await screen.findByText('Enter A Credit Limit In Whole Chips Greater Than Zero.')
      ).toBeTruthy();
      expect(mocks.rpc).not.toHaveBeenCalled();
    }
  );

  it.each(['player', 'super_agent'] as const)(
    'sends credit with the atomic role write from %s',
    async (role) => {
      await openRole(role);
      fireEvent.change(screen.getByLabelText('Funding'), { target: { value: 'credit' } });
      fireEvent.change(screen.getByLabelText('Credit Limit In Chips'), {
        target: { value: '5000' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
      await waitFor(() =>
        expect(mocks.rpc).toHaveBeenCalledWith('fn_club_set_member_role', {
          p_club_id: 'club',
          p_user_id: 'member',
          p_role: 'agent',
          p_commission_rate: 0.4,
          p_is_prepaid: false,
          p_credit_limit: 5000,
        })
      );
      expect(await screen.findByText('Test Refusal')).toBeTruthy();
    }
  );

  it('clears the transmitted limit when prepaid is selected', async () => {
    await openRole();
    fireEvent.change(screen.getByLabelText('Funding'), { target: { value: 'credit' } });
    fireEvent.change(screen.getByLabelText('Credit Limit In Chips'), { target: { value: '5000' } });
    fireEvent.change(screen.getByLabelText('Funding'), { target: { value: 'prepaid' } });
    expect(screen.queryByLabelText('Credit Limit In Chips')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() =>
      expect(mocks.rpc).toHaveBeenCalledWith(
        'fn_club_set_member_role',
        expect.objectContaining({ p_is_prepaid: true, p_credit_limit: 0 })
      )
    );
  });
});

describe('credit editing entry point', () => {
  it('opens saved credit terms from the current role without a role transition', async () => {
    render(
      <RoleSection
        resolvedClubId="club"
        targetUserId="member"
        targetName="Member"
        targetRole="agent"
        myRole="owner"
        onRoleChanged={vi.fn()}
      />
    );
    const edit = await screen.findByRole('button', { name: 'Edit Credit Line' });
    await waitFor(() => expect(edit.disabled).toBe(false));
    fireEvent.click(edit);
    const amount = await screen.findByLabelText('Credit Limit In Chips');
    expect((amount as HTMLInputElement).value).toBe('1234');
    expect(screen.queryByRole('button', { name: 'Confirm' })).toBeNull();
    fireEvent.change(amount, { target: { value: '3456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Credit Line' }));
    await waitFor(() =>
      expect(mocks.rpc).toHaveBeenCalledWith('fn_admin_update_agent', {
        p_agent_id: 'agent-row',
        p_is_prepaid: false,
        p_credit_limit: 3456,
        p_credit_reason: 'Credit Line Edited From Member Record',
      })
    );
    expect(mocks.rpc.mock.calls.some(([name]) => name === 'fn_club_set_member_role')).toBe(false);
  });
  it('does not offer club credit administration to an agent', async () => {
    render(
      <RoleSection
        resolvedClubId="club"
        targetUserId="member"
        targetName="Member"
        targetRole="sub_agent"
        myRole="agent"
        onRoleChanged={vi.fn()}
      />
    );
    await screen.findByText('Sub Agent (Current)', { exact: true });
    expect(screen.queryByRole('button', { name: 'Edit Credit Line' })).toBeNull();
  });
});
