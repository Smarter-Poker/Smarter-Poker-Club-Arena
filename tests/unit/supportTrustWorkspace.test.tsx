import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import FeedbackForm from '../../src/components/support/FeedbackForm';
import HelpPage from '../../src/pages/HelpPage';
import FairGamingPage from '../../src/pages/legal/FairGamingPage';
import PrivacyPolicyPage from '../../src/pages/legal/PrivacyPolicyPage';
import PromotionsPage from '../../src/pages/legal/PromotionsPage';
import TermsOfServicePage from '../../src/pages/legal/TermsOfServicePage';

import { resolveSeo } from '../../src/lib/seo';
const mocks = vi.hoisted(() => ({
  insert: vi.fn(),
  reportError: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('../../src/hooks/useAuthUser', () => ({
  useAuthUser: () => ({ user: { id: 'player-1' } }),
}));

vi.mock('../../src/hooks/useSystemHealth', () => ({
  useSystemHealth: () => ({
    health: {
      status: 'ok',
      supabase: 'ok',
      latencyMs: 42,
      timestamp: '2026-08-29T00:00:00.000Z',
      version: 'test',
    },
    isChecking: false,
    retry: vi.fn(),
  }),
}));

vi.mock('../../src/components/common/Toast', () => ({
  useToast: () => ({
    success: mocks.toastSuccess,
    error: mocks.toastError,
  }),
}));

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: () => ({ insert: mocks.insert }),
  },
}));

vi.mock('../../src/utils/errorReporter', () => ({
  reportError: mocks.reportError,
}));

function renderRoute(node: ReactNode, path: string) {
  return render(<MemoryRouter initialEntries={[path]}>{node}</MemoryRouter>);
}

describe('Support And Trust Workspace', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.insert.mockResolvedValue({ error: null });
  });

  it.each([
    ['Terms Of Service', '/legal/tos', <TermsOfServicePage />, 'CA-TOS-01'],
    ['Privacy Policy', '/legal/privacy', <PrivacyPolicyPage />, 'CA-PRV-01'],
    ['Fair Gaming Policy', '/legal/fair-gaming', <FairGamingPage />, 'CA-FGP-02'],
    ['Promotion Rules', '/legal/promotions', <PromotionsPage />, 'CA-PRM-02'],
  ])('renders %s as an indexed legal document', (title, path, page, documentCode) => {
    renderRoute(page, path);

    expect(screen.getByRole('heading', { level: 1, name: title })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Legal Center' })).toHaveAttribute('href', '/legal');
    expect(screen.getAllByText(documentCode)).toHaveLength(2);
    expect(screen.getByRole('navigation', { name: `${title} Sections` })).toBeInTheDocument();
    expect(screen.getByRole('article', { name: title })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Legal Documents' })).toBeInTheDocument();
  });

  it('removes unsupported certification claims from the fair gaming policy', () => {
    renderRoute(<FairGamingPage />, '/legal/fair-gaming');

    expect(screen.getByText(/Cryptographically Secure Random Values/i)).toBeInTheDocument();
    expect(screen.getByText(/Equity Simulations Use Separate/i)).toBeInTheDocument();
    expect(screen.queryByText(/Certified Random Number Generator/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Regular Third-Party Audits/i)).not.toBeInTheDocument();
  });

  it('uses live reward destinations instead of frozen promotion values', () => {
    renderRoute(<PromotionsPage />, '/legal/promotions');

    expect(screen.getByRole('link', { name: 'Promotions' })).toHaveAttribute('href', '/promotions');
    expect(screen.getByRole('link', { name: 'Bonuses' })).toHaveAttribute('href', '/bonuses');
    expect(screen.getByRole('link', { name: 'Rakeback' })).toHaveAttribute('href', '/rakeback');
    expect(screen.getByRole('link', { name: 'VIP Status' })).toHaveAttribute('href', '/vip');
    expect(screen.queryByText(/Bronze VIP: 5% Rakeback/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Day 7: 1000 Chips/i)).not.toBeInTheDocument();
  });

  it('renders accurate help actions, live status, and stable searchable questions', () => {
    renderRoute(<HelpPage />, '/help');

    expect(screen.getByRole('heading', { level: 1, name: 'Help Center' })).toBeInTheDocument();
    expect(screen.getByText('Systems Operational')).toBeInTheDocument();
    expect(screen.getByText('Supabase Responded In 42 Ms')).toBeInTheDocument();
    expect(screen.queryByText(/Geeves/i)).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Email Support' })).toHaveAttribute(
      'href',
      'mailto:support@smarter.poker'
    );

    const search = screen.getByRole('searchbox', { name: 'Search Help' });
    fireEvent.change(search, { target: { value: 'rakeback' } });
    expect(screen.getByText('Why Can A Bonus Or Rakeback Rate Change?')).toBeInTheDocument();
    expect(screen.queryByText('How Do I Change My Password?')).not.toBeInTheDocument();

    const question = screen.getByRole('button', {
      name: /Rewards Why Can A Bonus Or Rakeback Rate Change/i,
    });
    fireEvent.click(question);
    expect(question).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText(/Reward Amounts Come From The Live Offer/i)).toBeInTheDocument();
  });

  it('only confirms a support request after Supabase accepts it', async () => {
    const onClose = vi.fn();
    render(<FeedbackForm isOpen onClose={onClose} />);

    fireEvent.change(screen.getByLabelText('Description'), {
      target: { value: 'The tournament registration button did not respond.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send Support Request' }));

    await screen.findByRole('heading', { name: 'Support Request Sent' });
    expect(mocks.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: 'player-1',
        category: 'bug',
        description: 'The tournament registration button did not respond.',
      })
    );
    expect(mocks.toastSuccess).toHaveBeenCalledWith('Support Request Sent');
  });

  it('keeps the request open and gives a recovery path when Supabase rejects it', async () => {
    mocks.insert.mockResolvedValue({ error: new Error('RLS rejected insert') });
    render(<FeedbackForm isOpen onClose={vi.fn()} />);

    fireEvent.change(screen.getByLabelText('Description'), {
      target: { value: 'Account support request.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send Support Request' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Support Request Could Not Be Sent');
    expect(screen.queryByRole('heading', { name: 'Support Request Sent' })).not.toBeInTheDocument();
    expect(mocks.reportError).toHaveBeenCalled();
    expect(mocks.toastError).toHaveBeenCalledWith('Support Request Not Sent');
  });

  it('exposes a labelled dialog and keeps every category state explicit', () => {
    render(<FeedbackForm isOpen onClose={vi.fn()} />);

    const dialog = screen.getByRole('dialog', { name: 'Send Support Request' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    const suggestion = within(dialog).getByRole('button', { name: 'Suggestion' });
    fireEvent.click(suggestion);
    expect(suggestion).toHaveAttribute('aria-pressed', 'true');
    expect(within(dialog).getByRole('button', { name: 'Bug' })).toHaveAttribute(
      'aria-pressed',
      'false'
    );
  });

  it('sets a useful document title for support', async () => {
    // Derived from the route's own head rather than pinned: the point is
    // that the page sets the title its head declares, so the tab does not
    // change on hydration. Pinning the literal broke the day the public
    // titles were prefixed with the product name (AEO phase 3, 2026-09-18).
    renderRoute(<HelpPage />, '/help');
    const expected = `${resolveSeo('/help').title} | Smarter.Poker`;
    await waitFor(() => expect(document.title).toBe(expected));
  });
});
