// @vitest-environment happy-dom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ rpc: vi.fn(), read: vi.fn(), emit: vi.fn() }));
vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({ eq: () => ({ abortSignal: () => ({ maybeSingle: mocks.read }) }) }),
        }),
      }),
    }),
    rpc: (...args: unknown[]) => ({ abortSignal: () => mocks.rpc(...args) }),
  },
}));
vi.mock('../../src/core/MasterBus', () => ({ masterBus: { emit: mocks.emit } }));
import MemberCreditEditor from '../../src/components/club/MemberCreditEditor';
const terms = {
  id: 'agent-row',
  club_id: 'club',
  user_id: 'member',
  role: 'agent',
  is_prepaid: false,
  credit_limit: 1234,
  credit_used: 0,
};
const props = {
  clubId: 'club',
  userId: 'member',
  role: 'agent' as const,
  onClose: vi.fn(),
  onSaved: vi.fn(),
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.read.mockResolvedValue({ data: terms, error: null });
  mocks.rpc.mockResolvedValue({
    data: {
      success: true,
      agent_id: terms.id,
      club_id: 'club',
      is_prepaid: false,
      credit_limit: 2345,
    },
    error: null,
  });
});
afterEach(cleanup);
describe('existing member credit agreement', () => {
  it('loads persisted terms and updates only credit through the audited administration RPC', async () => {
    render(<MemberCreditEditor {...props} />);
    const amount = await screen.findByRole('spinbutton', { name: 'Credit Limit In Chips' });
    expect(amount).toHaveValue(1234);
    fireEvent.change(amount, { target: { value: '2345' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Credit Line' }));
    await waitFor(() => expect(props.onSaved).toHaveBeenCalledOnce());
    expect(mocks.rpc).toHaveBeenCalledWith('fn_admin_update_agent', {
      p_agent_id: 'agent-row',
      p_is_prepaid: false,
      p_credit_limit: 2345,
      p_credit_reason: 'Credit Line Edited From Member Record',
    });
    expect(mocks.emit).toHaveBeenCalledWith('AGENT_UPDATED', { clubId: 'club', agentId: 'member' });
  });
  it('can turn prepaid into credit and close unused credit back to prepaid', async () => {
    mocks.read.mockResolvedValueOnce({
      data: { ...terms, is_prepaid: true, credit_limit: 0 },
      error: null,
    });
    render(<MemberCreditEditor {...props} />);
    fireEvent.change(await screen.findByRole('combobox'), { target: { value: 'credit' } });
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '2345' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Credit Line' }));
    await waitFor(() => expect(props.onSaved).toHaveBeenCalledOnce());
    cleanup();
    mocks.rpc.mockResolvedValueOnce({
      data: {
        success: true,
        agent_id: terms.id,
        club_id: 'club',
        is_prepaid: true,
        credit_limit: 0,
      },
      error: null,
    });
    render(<MemberCreditEditor {...props} />);
    fireEvent.change(await screen.findByRole('combobox'), { target: { value: 'prepaid' } });
    expect(screen.queryByRole('spinbutton')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Save Credit Line' }));
    await waitFor(() => expect(props.onSaved).toHaveBeenCalledTimes(2));
    expect(mocks.rpc).toHaveBeenLastCalledWith(
      'fn_admin_update_agent',
      expect.objectContaining({ p_is_prepaid: true, p_credit_limit: 0 })
    );
  });
  it.each(['', '0', '-1', '1.5', '9007199254740992'])(
    'refuses invalid credit %s before writing',
    async (value) => {
      render(<MemberCreditEditor {...props} />);
      fireEvent.change(await screen.findByRole('spinbutton'), { target: { value } });
      fireEvent.click(screen.getByRole('button', { name: 'Save Credit Line' }));
      expect(await screen.findByRole('alert')).toHaveTextContent('Whole Chips Greater Than Zero');
      expect(mocks.rpc).not.toHaveBeenCalled();
    }
  );
  it('protects drawn credit when reducing a line or selecting prepaid', async () => {
    mocks.read.mockResolvedValue({ data: { ...terms, credit_used: 400 }, error: null });
    render(<MemberCreditEditor {...props} />);
    fireEvent.change(await screen.findByRole('spinbutton'), { target: { value: '399' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Credit Line' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Outstanding Credit');
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'prepaid' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Credit Line' }));
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it('requires authoritative reload after a refused or unconfirmed save', async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: { success: false, error: 'Parent Limit Refused' },
      error: null,
    });
    render(<MemberCreditEditor {...props} />);
    await screen.findByRole('spinbutton');
    fireEvent.click(screen.getByRole('button', { name: 'Save Credit Line' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Parent Limit Refused');
    expect(props.onSaved).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Save Credit Line' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Reload Terms' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Save Credit Line' })).toBeEnabled()
    );
  });
  it('refuses a receipt for another agreement', async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: {
        success: true,
        agent_id: 'other',
        club_id: 'club',
        is_prepaid: false,
        credit_limit: 1234,
      },
      error: null,
    });
    render(<MemberCreditEditor {...props} />);
    await screen.findByRole('spinbutton');
    fireEvent.click(screen.getByRole('button', { name: 'Save Credit Line' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Receipt Did Not Match');
    expect(props.onSaved).not.toHaveBeenCalled();
  });
  it('prevents duplicate clicks while the actual write is pending', async () => {
    let finish!: (value: unknown) => void;
    mocks.rpc.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    render(<MemberCreditEditor {...props} />);
    fireEvent.change(await screen.findByRole('spinbutton'), { target: { value: '2345' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Credit Line' }));
    fireEvent.click(screen.getByRole('button', { name: 'Saving...' }));
    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledOnce());
    finish({
      data: {
        success: true,
        agent_id: terms.id,
        club_id: 'club',
        is_prepaid: false,
        credit_limit: 2345,
      },
      error: null,
    });
    await waitFor(() => expect(props.onSaved).toHaveBeenCalledOnce());
  });
  it.each([null, { ...terms, role: 'sub_agent' }, { ...terms, club_id: 'other' }])(
    'does not offer a save for absent or wrong-scope terms',
    async (row) => {
      mocks.read.mockResolvedValueOnce({ data: row, error: null });
      render(<MemberCreditEditor {...props} />);
      expect(await screen.findByRole('alert')).toHaveTextContent(
        'Unavailable Or The Member Role Changed'
      );
      expect(screen.queryByRole('button', { name: 'Save Credit Line' })).toBeNull();
    }
  );
});
