import { act, cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  auth: {
    user: { id: 'reviewer-a' } as { id: string } | null,
    isHydrating: false,
  },
  rpc: vi.fn(),
}));

vi.mock('../../src/hooks/useAuthUser', () => ({ useAuthUser: () => m.auth }));
vi.mock('../../src/lib/supabase', () => ({ supabase: { rpc: m.rpc } }));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
vi.mock('../../src/components/common/EmptyState', () => ({
  LoadingState: ({ message }: { message: string }) => <div role="status">{message}</div>,
}));

import FinancialAdminGate from '../../src/components/auth/FinancialAdminGate';

const tree = () => (
  <MemoryRouter initialEntries={['/financial-incidents']}>
    <Routes>
      <Route
        path="/financial-incidents"
        element={
          <FinancialAdminGate>
            <div>Protected Incident Console</div>
          </FinancialAdminGate>
        }
      />
      <Route path="/financial-admin" element={<div>Financial Admin Landing</div>} />
    </Routes>
  </MemoryRouter>
);

beforeEach(() => {
  vi.clearAllMocks();
  m.auth = { user: { id: 'reviewer-a' }, isHydrating: false };
});

afterEach(() => cleanup());

describe('FinancialAdminGate identity binding', () => {
  it('removes the prior reviewer console during an authenticated identity change', async () => {
    let resolveReviewerB!: (value: { data: boolean; error: null }) => void;
    m.rpc.mockResolvedValueOnce({ data: true, error: null }).mockImplementationOnce(
      () =>
        new Promise<{ data: boolean; error: null }>((resolve) => {
          resolveReviewerB = resolve;
        })
    );

    const view = render(tree());
    expect(await screen.findByText('Protected Incident Console')).toBeInTheDocument();

    m.auth = { user: { id: 'reviewer-b' }, isHydrating: false };
    view.rerender(tree());

    expect(screen.queryByText('Protected Incident Console')).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent('Checking Your Access');

    await act(async () => {
      resolveReviewerB({ data: false, error: null });
    });
    expect(await screen.findByText('Financial Admin Landing')).toBeInTheDocument();
  });
});
