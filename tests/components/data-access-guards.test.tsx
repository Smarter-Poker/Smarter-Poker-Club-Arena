import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const { auth, rpc } = vi.hoisted(() => ({
  auth: { current: { user: { id: 'owner' }, isHydrating: false } },
  rpc: vi.fn(),
}));
vi.mock('../../src/hooks/useAuthUser', () => ({ useAuthUser: () => auth.current }));
vi.mock('../../src/lib/supabase', () => ({ supabase: { rpc } }));
vi.mock('../../src/hooks/useUnionRouteId', () => ({
  useUnionRouteId: () => ({ unionId: 'fade0000-0000-0000-0000-000000000001', unionRef: 'union-1' }),
}));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
vi.mock('../../src/components/common/EmptyState', () => ({
  LoadingState: () => <p>Checking Access</p>,
  PermissionState: () => <p>Access Refused</p>,
}));
import ClubDataGuard from '../../src/components/auth/ClubDataGuard';
import UnionOverseerGuard from '../../src/components/auth/UnionOverseerGuard';
const club = 'a0000000-0000-0000-0000-000000000001';
function ClubRoute({ wholeClub = false }: { wholeClub?: boolean }) {
  return (
    <MemoryRouter initialEntries={[`/clubs/${club}/data/advanced`]}>
      <Routes>
        <Route
          path="clubs/:clubId/data/advanced"
          element={
            <ClubDataGuard wholeClub={wholeClub}>
              <p>Private Report</p>
            </ClubDataGuard>
          }
        />
        <Route path="clubs/:clubId/data" element={<p>Own Downline</p>} />
      </Routes>
    </MemoryRouter>
  );
}
afterEach(cleanup);
beforeEach(() => {
  auth.current = { user: { id: 'owner' }, isHydrating: false };
  rpc.mockReset();
});

describe('Club Data route authorization', () => {
  it.each(['owner', 'co_owner', 'admin'])('%s may open the whole report', async () => {
    rpc.mockResolvedValue({ data: 'club', error: null });
    render(<ClubRoute wholeClub />);
    expect(await screen.findByText('Private Report')).toBeInTheDocument();
  });
  it.each(['super_agent', 'agent', 'sub_agent'])(
    '%s is redirected from the whole report to their downline',
    async () => {
      rpc.mockResolvedValue({ data: 'downline', error: null });
      render(<ClubRoute wholeClub />);
      expect(await screen.findByText('Own Downline')).toBeInTheDocument();
      expect(screen.queryByText('Private Report')).not.toBeInTheDocument();
    }
  );
  it('admits an agent to the scoped simple screen', async () => {
    rpc.mockResolvedValue({ data: 'downline', error: null });
    render(<ClubRoute />);
    expect(await screen.findByText('Private Report')).toBeInTheDocument();
  });
  it.each([null, 'unknown'])('refuses a player or unreadable scope (%s)', async (data) => {
    rpc.mockResolvedValue({ data, error: null });
    render(<ClubRoute />);
    expect(await screen.findByText('Access Refused')).toBeInTheDocument();
  });
  it('refuses errors even when a broad scope accompanies the error', async () => {
    rpc.mockResolvedValue({ data: 'club', error: { code: '42501' } });
    render(<ClubRoute />);
    expect(await screen.findByText('Access Refused')).toBeInTheDocument();
  });
  it('never reuses the prior account permission while the next read is pending', async () => {
    rpc.mockResolvedValueOnce({ data: 'club', error: null });
    const view = render(<ClubRoute wholeClub />);
    await screen.findByText('Private Report');
    let finish!: (value: unknown) => void;
    rpc.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    auth.current = { user: { id: 'agent' }, isHydrating: false };
    view.rerender(<ClubRoute wholeClub />);
    expect(screen.queryByText('Private Report')).not.toBeInTheDocument();
    await act(async () => finish({ data: 'downline', error: null }));
    await screen.findByText('Own Downline');
  });
});

describe('Union Data account boundary', () => {
  it('retires an owner verdict before an agent in the same union renders', async () => {
    rpc.mockResolvedValueOnce({ data: true, error: null });
    const view = render(
      <MemoryRouter>
        <UnionOverseerGuard>
          <p>Whole Union</p>
        </UnionOverseerGuard>
      </MemoryRouter>
    );
    await screen.findByText('Whole Union');
    let finish!: (value: unknown) => void;
    rpc.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    auth.current = { user: { id: 'agent' }, isHydrating: false };
    view.rerender(
      <MemoryRouter>
        <UnionOverseerGuard>
          <p>Whole Union</p>
        </UnionOverseerGuard>
      </MemoryRouter>
    );
    expect(screen.queryByText('Whole Union')).not.toBeInTheDocument();
    await act(async () => finish({ data: false, error: null }));
    await screen.findByText('Access Refused');
  });
});
