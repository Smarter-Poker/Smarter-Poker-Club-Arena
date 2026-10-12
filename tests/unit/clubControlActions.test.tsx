// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ClubControlActions from '../../src/components/club/ClubControlActions';
const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  read: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  emit: vi.fn(),
  workspace: {
    clubUUID: 'club-a',
    routeClubId: 'jaqk',
    canControlClub: true,
    loading: false,
    error: null,
  },
  user: { id: 'staff' },
}));
vi.mock('../../src/contexts/ClubWorkspaceContext', () => ({
  useClubWorkspace: () => mocks.workspace,
}));
vi.mock('../../src/hooks/useAuthUser', () => ({ useAuthUser: () => ({ user: mocks.user }) }));
vi.mock('../../src/components/common/Toast', () => ({
  useToast: () => ({ success: mocks.success, error: mocks.error }),
}));
vi.mock('../../src/components/club/ClubEntryMessage', () => ({ CLUB_ENTRY_MESSAGE_MAX: 240 }));
vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    rpc: mocks.rpc,
    from: () => {
      const query = { select: () => query, eq: () => query, maybeSingle: mocks.read };
      return query;
    },
  },
}));
vi.mock('../../src/core/MasterBus', () => ({ masterBus: { emit: mocks.emit } }));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
const open = () =>
  render(
    <MemoryRouter>
      <ClubControlActions />
    </MemoryRouter>
  );
afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  mocks.workspace.canControlClub = true;
  mocks.read.mockResolvedValue({
    data: { lobby_message: 'Welcome', is_public: true, requires_approval: true },
    error: null,
  });
  mocks.rpc.mockResolvedValue({ data: { ok: true, lobby_message: 'New Message' }, error: null });
});
async function edit() {
  const field = await screen.findByLabelText('Message');
  await waitFor(() => expect((field as HTMLTextAreaElement).value).toBe('Welcome'));
  fireEvent.change(field, { target: { value: 'New Message' } });
  return screen.getByRole('button', { name: 'Save Club Message' });
}
describe('Control edits through the club message transaction', () => {
  it('saves the message, accepts the server result, and notifies the club consumers', async () => {
    open();
    fireEvent.click(await edit());
    await waitFor(() => expect(mocks.success).toHaveBeenCalledWith('Club Message Saved'));
    expect(mocks.rpc).toHaveBeenCalledWith('fn_set_club_lobby_message', {
      p_club_id: 'club-a',
      p_message: 'New Message',
    });
    expect(mocks.emit).toHaveBeenCalledWith('CLUB_SETTINGS_UPDATED', { clubId: 'club-a' });
  });
  it('keeps the draft and reports an unconfirmed server refusal', async () => {
    mocks.rpc.mockResolvedValue({ data: { ok: false, reason: 'not_authorized' }, error: null });
    open();
    fireEvent.click(await edit());
    await waitFor(() => expect(mocks.error).toHaveBeenCalled());
    expect(mocks.success).not.toHaveBeenCalled();
    expect(mocks.emit).not.toHaveBeenCalled();
    expect((screen.getByLabelText('Message') as HTMLTextAreaElement).value).toBe('New Message');
  });
  it('blocks repeated submissions while the transaction is in flight', async () => {
    let resolve!: (value: unknown) => void;
    mocks.rpc.mockReturnValue(
      new Promise((r) => {
        resolve = r;
      })
    );
    open();
    const button = await edit();
    fireEvent.click(button);
    fireEvent.click(button);
    expect(mocks.rpc).toHaveBeenCalledOnce();
    resolve({ data: { ok: true, lobby_message: 'New Message' }, error: null });
    await waitFor(() => expect(mocks.success).toHaveBeenCalledOnce());
  });
  it('does not offer controls to viewers without club-control access', () => {
    mocks.workspace.canControlClub = false;
    open();
    expect(screen.queryByLabelText('Message')).toBeNull();
    expect(mocks.read).not.toHaveBeenCalled();
  });
  it('never shows a failed policy lookup as public or approval-free', async () => {
    mocks.read.mockResolvedValue({ data: null, error: new Error('Policy Unavailable') });
    open();
    await screen.findByRole('alert');
    expect(screen.queryByText(/Public Club/)).toBeNull();
    expect((screen.getByLabelText('Message') as HTMLTextAreaElement).disabled).toBe(true);
  });
  it('does not send a toast to a different page after an interrupted write', async () => {
    let resolve!: (value: unknown) => void;
    mocks.rpc.mockReturnValue(
      new Promise((r) => {
        resolve = r;
      })
    );
    const view = open();
    fireEvent.click(await edit());
    view.unmount();
    resolve({ data: { ok: true, lobby_message: 'New Message' }, error: null });
    await Promise.resolve();
    await Promise.resolve();
    expect(mocks.success).not.toHaveBeenCalled();
  });
});
