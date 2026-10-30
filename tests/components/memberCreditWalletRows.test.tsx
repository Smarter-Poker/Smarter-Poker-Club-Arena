import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({ eq: () => ({ abortSignal: () => ({ maybeSingle: mocks.read }) }) }),
        }),
      }),
    }),
  },
}));
import MemberCreditWalletRows from '../../src/components/club/MemberCreditWalletRows';
const terms = {
  club_id: 'club',
  user_id: 'agent',
  role: 'agent',
  is_prepaid: false,
  credit_limit: 5000,
  credit_used: 1250,
};
const props = { clubId: 'club', userId: 'agent', role: 'agent' as const, revision: 1 };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.read.mockResolvedValue({ data: terms, error: null });
});
describe('credit agreement beneath member wallets', () => {
  it('shows the assigned line, amount used and remaining capacity separately', async () => {
    render(<MemberCreditWalletRows {...props} />);
    expect(await screen.findByText('Credit Line')).toBeInTheDocument();
    expect(screen.getByText('Credit Line').parentElement).toHaveTextContent('5,000.00');
    expect(screen.queryByText('Credit Used')).not.toBeInTheDocument();
    expect(screen.queryByText('Credit Available')).not.toBeInTheDocument();
  });
  it('does not invent a line for prepaid terms', async () => {
    mocks.read.mockResolvedValue({ data: { ...terms, is_prepaid: true }, error: null });
    render(<MemberCreditWalletRows {...props} />);
    await waitFor(() =>
      expect(screen.queryByText('Loading Credit Line...')).not.toBeInTheDocument()
    );
    expect(screen.queryByText('Credit Line')).not.toBeInTheDocument();
  });
  it('reports unavailable reads, retries explicitly and never calls them zero', async () => {
    mocks.read.mockResolvedValueOnce({ data: null, error: new Error('denied') });
    render(<MemberCreditWalletRows {...props} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Retry Credit Line' }));
    expect(await screen.findByText('Credit Line')).toBeInTheDocument();
  });
  it('rejects a response for a different member and withdraws stale figures on navigation', async () => {
    const view = render(<MemberCreditWalletRows {...props} />);
    await screen.findByText('Credit Line');
    mocks.read.mockResolvedValue({ data: terms, error: null });
    view.rerender(<MemberCreditWalletRows {...props} userId="other" />);
    expect(screen.queryByText('Credit Line')).not.toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Retry Credit Line' })).toBeInTheDocument();
  });
});
