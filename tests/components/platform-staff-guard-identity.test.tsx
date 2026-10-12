import { act, cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  auth: {
    user: { id: 'staff-a' } as { id: string } | null,
    isHydrating: false,
  },
  maybeSingle: vi.fn(),
}));

vi.mock('../../src/hooks/useAuthUser', () => ({ useAuthUser: () => m.auth }));
vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: () => ({
      select() {
        return this;
      },
      eq() {
        return this;
      },
      maybeSingle: m.maybeSingle,
    }),
  },
}));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
vi.mock('../../src/components/common/EmptyState', () => ({
  LoadingState: ({ message }: { message: string }) => <div role="status">{message}</div>,
}));

import PlatformStaffGuard from '../../src/components/auth/PlatformStaffGuard';

const tree = () => (
  <MemoryRouter initialEntries={['/staff-console']}>
    <Routes>
      <Route
        path="/staff-console"
        element={
          <PlatformStaffGuard>
            <div>Protected Staff Console</div>
          </PlatformStaffGuard>
        }
      />
      <Route path="/" element={<div>Arena Home</div>} />
    </Routes>
  </MemoryRouter>
);

beforeEach(() => {
  vi.clearAllMocks();
  m.auth = { user: { id: 'staff-a' }, isHydrating: false };
});

afterEach(() => cleanup());

describe('PlatformStaffGuard identity binding', () => {
  it('removes the prior staff console during an authenticated identity change', async () => {
    let resolvePlayerB!: (value: { data: { role: string }; error: null }) => void;
    m.maybeSingle
      .mockResolvedValueOnce({ data: { role: 'admin' }, error: null })
      .mockImplementationOnce(
        () =>
          new Promise<{ data: { role: string }; error: null }>((resolve) => {
            resolvePlayerB = resolve;
          })
      );

    const view = render(tree());
    expect(await screen.findByText('Protected Staff Console')).toBeInTheDocument();

    m.auth = { user: { id: 'player-b' }, isHydrating: false };
    view.rerender(tree());

    expect(screen.queryByText('Protected Staff Console')).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent('Checking Your Access');

    await act(async () => {
      resolvePlayerB({ data: { role: 'player' }, error: null });
    });
    expect(await screen.findByText('Arena Home')).toBeInTheDocument();
  });
});
