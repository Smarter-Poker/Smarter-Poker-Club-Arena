import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
  it('shows only the assigned tracking line', async () => {
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
  it('keeps the verified card mounted through a delayed same-member refresh', async () => {
    const view = render(<MemberCreditWalletRows {...props} />);
    const card = await screen.findByRole('region', { name: 'Credit Tracking' });
    let resolve!: (value: { data: typeof terms; error: null }) => void;
    mocks.read.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        })
    );
    view.rerender(<MemberCreditWalletRows {...props} revision={2} />);
    await waitFor(() => expect(mocks.read).toHaveBeenCalledTimes(2));
    expect(screen.queryByText('Loading Credit Line...')).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Credit Tracking' })).toBe(card);
    expect(card).toHaveTextContent('5,000.00');
    await act(async () => resolve({ data: { ...terms, credit_limit: 2500 }, error: null }));
    expect(card).toHaveTextContent('2,500.00');
    expect(screen.getByRole('region', { name: 'Credit Tracking' })).toBe(card);
  });
  it('withdraws a verified line when a background read fails and retries explicitly', async () => {
    const view = render(<MemberCreditWalletRows {...props} />);
    await screen.findByText('Credit Line');
    mocks.read.mockResolvedValueOnce({ data: null, error: new Error('denied') });
    view.rerender(<MemberCreditWalletRows {...props} revision={2} />);
    const retry = await screen.findByRole('button', { name: 'Retry Credit Line' });
    expect(screen.queryByRole('region', { name: 'Credit Tracking' })).not.toBeInTheDocument();
    fireEvent.click(retry);
    expect(await screen.findByText('Credit Line')).toBeInTheDocument();
  });
  it('ignores an obsolete refresh response after a newer revision finishes', async () => {
    const view = render(<MemberCreditWalletRows {...props} />);
    const card = await screen.findByRole('region', { name: 'Credit Tracking' });
    let resolve!: (value: { data: typeof terms; error: null }) => void;
    mocks.read.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        })
    );
    view.rerender(<MemberCreditWalletRows {...props} revision={2} />);
    await waitFor(() => expect(mocks.read).toHaveBeenCalledTimes(2));
    mocks.read.mockResolvedValueOnce({ data: { ...terms, credit_limit: 2500 }, error: null });
    view.rerender(<MemberCreditWalletRows {...props} revision={3} />);
    await waitFor(() => expect(card).toHaveTextContent('2,500.00'));
    await act(async () => resolve({ data: { ...terms, credit_limit: 9999 }, error: null }));
    expect(card).toHaveTextContent('2,500.00');
    expect(card).not.toHaveTextContent('9,999.00');
  });
  it('withdraws the prior role agreement before replacement terms arrive', async () => {
    const view = render(<MemberCreditWalletRows {...props} />);
    await screen.findByText('Credit Line');
    mocks.read.mockImplementationOnce(() => new Promise(() => {}));
    view.rerender(<MemberCreditWalletRows {...props} role="super_agent" />);
    expect(screen.queryByRole('region', { name: 'Credit Tracking' })).not.toBeInTheDocument();
    expect(screen.getByText('Loading Credit Line...')).toBeInTheDocument();
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
