// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ClubApplicantsPage from '../../src/pages/ClubApplicantsPage';

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  confirm: vi.fn(),
  emit: vi.fn(),
  error: vi.fn(),
  success: vi.fn(),
  user: { id: 'operator' },
  access: { canControlClub: true, loading: false, error: null, reload: vi.fn() },
}));
vi.mock('../../src/lib/supabase', () => ({ supabase: { rpc: mocks.rpc } }));
vi.mock('../../src/hooks/useAuthUser', () => ({ useAuthUser: () => ({ user: mocks.user }) }));
vi.mock('../../src/hooks/useClubNavigationAccess', () => ({
  useClubNavigationAccess: () => mocks.access,
}));
vi.mock('../../src/components/common/Toast', () => ({
  useToast: () => ({ error: mocks.error, success: mocks.success }),
}));
vi.mock('../../src/components/common/confirmDialog', () => ({ confirmDialog: mocks.confirm }));
vi.mock('../../src/utils/clubIdResolver', () => ({
  resolveClubUUIDStrict: async () => 'club-uuid',
}));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
vi.mock('../../src/core/MasterBus', () => ({
  masterBus: { emit: mocks.emit, subscribeDebounced: () => () => undefined },
}));
const player = {
  user_id: 'applicant',
  display_name: 'Arena Player',
  created_at: '2026-10-11T00:00:00Z',
};
function open() {
  return render(
    <MemoryRouter initialEntries={['/clubs/jaqk/applicants']}>
      <Routes>
        <Route path="/clubs/:clubId/applicants" element={<ClubApplicantsPage />} />
      </Routes>
    </MemoryRouter>
  );
}
afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  mocks.access.canControlClub = true;
  mocks.confirm.mockResolvedValue(true);
  mocks.rpc.mockResolvedValue({ data: [player], error: null });
});
describe('applicant review uses the existing authorized transaction', () => {
  it('reads the pending queue with the resolved club identity', async () => {
    open();
    await screen.findByRole('button', { name: 'Approve' });
    expect(mocks.rpc).toHaveBeenCalledWith('fn_list_pending_members', { p_club_id: 'club-uuid' });
  });
  it('refuses to read or act without club-control access', async () => {
    mocks.access.canControlClub = false;
    open();
    expect(screen.getByRole('note').textContent).toContain('Access Is Required');
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it('does not treat a failed queue read as no applicants', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: new Error('Queue Unavailable') });
    open();
    await screen.findByRole('alert');
    expect(screen.queryByText(/No Pending Applicants/)).toBeNull();
  });
  it('cancellation leaves the pending membership untouched', async () => {
    mocks.confirm.mockResolvedValue(false);
    open();
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(mocks.confirm).toHaveBeenCalledOnce());
    expect(
      mocks.rpc.mock.calls.filter((call) => call[0] === 'fn_review_join_request')
    ).toHaveLength(0);
  });
  it('confirms a decision, refreshes the queue and emits the resolved club identity', async () => {
    mocks.rpc.mockImplementation(async (name) =>
      name === 'fn_review_join_request'
        ? { data: { success: true }, error: null }
        : { data: mocks.emit.mock.calls.length ? [] : [player], error: null }
    );
    open();
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    await screen.findByText(/No Pending Applicants/);
    expect(mocks.rpc).toHaveBeenCalledWith('fn_review_join_request', {
      p_club_id: 'club-uuid',
      p_user_id: 'applicant',
      p_approve: true,
    });
    expect(mocks.emit).toHaveBeenCalledWith('CLUB_UPDATED', { clubId: 'club-uuid' });
    expect(mocks.success).toHaveBeenCalledOnce();
  });
  it('shows the server admission refusal and never claims approval', async () => {
    mocks.rpc.mockImplementation(async (name) =>
      name === 'fn_review_join_request'
        ? { data: { success: false, error: 'Club Capacity Reached' }, error: null }
        : { data: [player], error: null }
    );
    open();
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(mocks.error).toHaveBeenCalledWith('Club Capacity Reached'));
    expect(mocks.success).not.toHaveBeenCalled();
    expect(mocks.emit).not.toHaveBeenCalled();
  });
  it('allows only one decision while confirmation or the write is in flight', async () => {
    let resolve!: (value: boolean) => void;
    mocks.confirm.mockReturnValue(
      new Promise((r) => {
        resolve = r;
      })
    );
    open();
    const button = await screen.findByRole('button', { name: 'Approve' });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(mocks.confirm).toHaveBeenCalledOnce();
    resolve(false);
  });
  it('does not submit after the operator leaves during confirmation', async () => {
    let resolve!: (value: boolean) => void;
    mocks.confirm.mockReturnValue(
      new Promise((r) => {
        resolve = r;
      })
    );
    const view = open();
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    view.unmount();
    resolve(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(
      mocks.rpc.mock.calls.filter((call) => call[0] === 'fn_review_join_request')
    ).toHaveLength(0);
  });
});
