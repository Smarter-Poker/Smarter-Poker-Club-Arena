import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const f = vi.hoisted(() => ({
  actor: { user: { id: 'viewer-a' } },
  toast: { success: vi.fn(), error: vi.fn() },
  page: vi.fn(),
  summary: vi.fn(),
  export: vi.fn(),
  csv: vi.fn(),
  report: vi.fn(),
}));
vi.mock('../../src/hooks/useAuthUser', () => ({ useAuthUser: () => f.actor }));
vi.mock('../../src/hooks/useProfilePresence', () => ({ useOnlineNow: () => false }));
vi.mock('../../src/hooks/useMasterBusSubscription', () => ({
  useMasterBusSubscriptions: () => {},
}));
vi.mock('../../src/hooks/useMasterBusChannel', () => ({ useMasterBusChannel: () => {} }));
vi.mock('../../src/components/common/Toast', () => ({ useToast: () => f.toast }));
vi.mock('../../src/utils/strictClubIdResolver', () => ({
  resolveClubUUIDStrict: async (club: string) =>
    club === 'club-a'
      ? '00000000-0000-0000-0000-000000000043'
      : '00000000-0000-0000-0000-000000000044',
  ClubNotFoundError: class extends Error {},
}));
vi.mock('../../src/services/ClubRosterService', () => ({
  default: { getRosterPage: f.page, getSummary: f.summary, exportRoster: f.export },
  mapRosterRow: (row: unknown) => row,
  MemberAccessDeniedError: class MemberAccessDeniedError extends Error {},
}));
vi.mock('../../src/lib/export', () => ({ exportToCSV: f.csv }));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: f.report }));
import ClubMembersPage from '../../src/pages/ClubMembersPage';

function Harness() {
  const navigate = useNavigate();
  return (
    <>
      <button onClick={() => navigate('/clubs/club-a/members')}>Club A</button>
      <button onClick={() => navigate('/clubs/club-b/members')}>Club B</button>
      <Routes>
        <Route path="/clubs/:clubId/members" element={<ClubMembersPage />} />
      </Routes>
    </>
  );
}
const tree = () => (
  <MemoryRouter initialEntries={['/clubs/club-a/members']}>
    <Harness />
  </MemoryRouter>
);
const receipt = { rows: [{ alias: 'Old Viewer', role: 'player' }], row_count: 1 };
function deferred() {
  let resolve!: (value: typeof receipt) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<typeof receipt>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function ready() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(screen.getByRole('button', { name: 'Export CSV' })).toBeEnabled();
}
beforeEach(() => {
  vi.useFakeTimers();
  sessionStorage.clear();
  vi.clearAllMocks();
  f.actor.user = { id: 'viewer-a' };
  f.page.mockResolvedValue({ items: [], next_cursor: null, has_more: false, filtered_total: 0 });
  f.summary.mockResolvedValue({
    viewer_role: 'owner',
    capabilities: {
      can_view_financials: false,
      can_export: true,
      can_manage_members: false,
      can_view_notes: false,
    },
    counts: { total: 0, online: 0, seated: 0, agents: 0, admins: 0 },
    data_version: null,
    page_size: 80,
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it('downloads a completed export while its viewer and club still own the page', async () => {
  f.export.mockResolvedValue(receipt);
  render(tree());
  await ready();
  fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
  await act(async () => {
    await Promise.resolve();
  });
  expect(f.csv).toHaveBeenCalledTimes(1);
  expect(f.toast.success).toHaveBeenCalledWith('1 Players Exported');
});

it('rejects an old viewer receipt and keeps a new viewer export busy until its own answer', async () => {
  const old = deferred(),
    current = deferred();
  f.export.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
  const view = render(tree());
  await ready();
  fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
  f.actor.user = { id: 'viewer-b' };
  view.rerender(tree());
  await ready();
  fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
  await act(async () => {
    old.resolve(receipt);
  });
  expect(f.csv).not.toHaveBeenCalled();
  expect(f.toast.success).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Preparing...' })).toBeDisabled();
  await act(async () => {
    current.resolve(receipt);
  });
  expect(f.csv).toHaveBeenCalledTimes(1);
});

it('rejects a club A receipt after visiting club B and returning to club A', async () => {
  const old = deferred();
  f.export.mockReturnValue(old.promise);
  render(tree());
  await ready();
  fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
  fireEvent.click(screen.getByRole('button', { name: 'Club B' }));
  await ready();
  fireEvent.click(screen.getByRole('button', { name: 'Club A' }));
  await ready();
  await act(async () => {
    old.resolve(receipt);
  });
  expect(f.csv).not.toHaveBeenCalled();
  expect(f.toast.success).not.toHaveBeenCalled();
});

it.each(['success', 'error'])('ignores a late %s after unmount', async (outcome) => {
  const old = deferred();
  f.export.mockReturnValue(old.promise);
  const view = render(tree());
  await ready();
  fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
  view.unmount();
  await act(async () => {
    if (outcome === 'success') old.resolve(receipt);
    else old.reject(new Error('Old Request Failed'));
  });
  expect(f.csv).not.toHaveBeenCalled();
  expect(f.toast.success).not.toHaveBeenCalled();
  expect(f.toast.error).not.toHaveBeenCalled();
});
