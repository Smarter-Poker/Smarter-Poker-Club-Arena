/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  STAFF READ THE COMMERCE OPERATING METRICS (R2 7.5, 20260924183529)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The Commerce Desk's Metrics tab prints fn_ca_commerce_metrics: net paid
 * diamonds apart from proposed quotes, free month waivers, refunds, retries
 * and replays; refund, renewal and notice ages; sponsorship use; and the
 * accounting postcondition failures the consumers record. What the records do
 * not hold (purchase replays, a rolled back owner purchase) is said to be
 * unrecorded, never shown as zero. The real CommerceDeskService runs against
 * a fake supabase that answers in the migration's own shape.
 */

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  rpc: vi.fn(),
  from: vi.fn(),
  params: new URLSearchParams('tab=metrics'),
}));

vi.mock('../../src/lib/supabase', () => ({ supabase: { rpc: h.rpc, from: h.from } }));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
vi.mock('../../src/components/common/Toast', () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }),
}));
vi.mock('../../src/hooks/useAuthUser', () => ({ useAuthUser: () => ({ user: { id: 'staff' } }) }));
vi.mock('react-router-dom', () => ({ useSearchParams: () => [h.params, vi.fn()] }));

import CommerceDeskPage from '../../src/pages/admin/CommerceDeskPage';

/** The shape the runner's GREEN scenario asserts, as the read returns it. */
const METRICS = {
  success: true,
  days: 30,
  since: '2026-08-25T00:00:00.000Z',
  as_of: '2026-09-24T00:00:00.000Z',
  quotes: { priced: 9, proposed_diamonds: 4700, consumed: 6, open: 1, expired: 1, withdrawn: 1 },
  purchases: {
    committed: 6,
    paid: 6,
    zero_net: 0,
    net_paid_diamonds: 3000,
    sponsored_net_diamonds: 500,
    trial_waiver_diamonds: 0,
    by_kind: {
      purchase: { committed: 6, net_paid_diamonds: 3000 },
      upgrade: { committed: 0, net_paid_diamonds: 0 },
      renewal: { committed: 0, net_paid_diamonds: 0 },
    },
  },
  trial_waivers: { scopes: 2, trials: 1, net_paid_diamonds: 0 },
  refunds: {
    committed: 1,
    gross_diamonds: 500,
    debt_settled_diamonds: 0,
    added_to_balance_diamonds: 500,
  },
  refund_requests: {
    by_state: { requested: 1, approved: 1, owed: 0, refunded: 1, declined: 1, failed: 0 },
    awaiting_decision: 1,
    oldest_awaiting_decision_at: '2026-09-22T18:00:00.000Z',
    oldest_awaiting_decision_hours: 30,
    awaiting_execution: 1,
    awaiting_execution_diamonds: 100,
    oldest_awaiting_execution_at: '2026-09-23T19:00:00.000Z',
    oldest_awaiting_execution_hours: 5,
  },
  renewals: {
    authorized: 1,
    due_now: 1,
    oldest_due_at: '2026-09-23T17:00:00.000Z',
    oldest_overdue_hours: 7,
    needs_attention: 0,
    renewed: 0,
    not_completed: 2,
  },
  sponsorships: { active: 1, budget_diamonds: 2000, committed_diamonds: 500 },
  notices: {
    undelivered_due: 2,
    oldest_undelivered_due_at: '2026-09-23T21:00:00.000Z',
    oldest_undelivered_hours: 3,
    scheduled: 2,
    suppressed: 0,
  },
  duplicates: {
    refund_execution_replays: 1,
    renewal_debit_reference_reused: 1,
    purchase_replays_recorded: false,
  },
  postconditions: { renewal: 1, refund: 1, purchase_failures_recorded: false },
  retries: { refund_execution_retries: 2, renewal_claim_retries: 0 },
};

function answer(m: unknown) {
  h.rpc.mockImplementation(async (fn: string) => {
    if (fn === 'fn_ca_commerce_metrics') return { data: m, error: null };
    return { data: { success: true }, error: null };
  });
}

/** The value printed beside a row label inside one card. */
const value = (card: HTMLElement, label: string) =>
  within(card).getByText(label).nextSibling?.textContent;

afterEach(() => vi.clearAllMocks());

describe('Commerce Desk: Metrics', () => {
  it('prints every measure in words and whole diamonds, net paid apart from the rest', async () => {
    answer(METRICS);
    const { container } = render(<CommerceDeskPage />);
    const pay = await screen.findByRole('article', { name: 'Payments' });
    expect(h.rpc).toHaveBeenCalledWith('fn_ca_commerce_metrics', { p_days: 30 });
    expect(value(pay, 'Net Paid')).toBe('3,000 Diamonds');
    expect(value(pay, 'Purchases')).toBe('6, 3,000 Diamonds');
    expect(value(pay, 'Paid By Sponsors')).toBe('500 Diamonds');
    const quotes = screen.getByRole('article', { name: 'Quotes' });
    expect(value(quotes, 'Proposed, Not Paid')).toBe('4,700 Diamonds');
    expect(value(quotes, 'Withdrawn')).toBe('1');
    const free = screen.getByRole('article', { name: 'Free Months' });
    expect(value(free, 'Clubs And Unions Granted')).toBe('2');
    expect(value(free, 'Diamonds Charged')).toBe('0 Diamonds');
    const refunds = screen.getByRole('article', { name: 'Refunds' });
    expect(value(refunds, 'Returned')).toBe('500 Diamonds');
    expect(value(refunds, 'Oldest Awaiting A Decision')).toBe('30 Hours');
    expect(value(refunds, 'Approved, Not Yet Returned')).toBe('1, 100 Diamonds');
    expect(value(refunds, 'Oldest Not Yet Returned')).toBe('5 Hours');
    expect(value(refunds, 'Declined Requests')).toBe('1');
    const renewals = screen.getByRole('article', { name: 'Renewals' });
    expect(value(renewals, 'Oldest Overdue')).toBe('7 Hours');
    expect(value(renewals, 'Not Completed In The Window')).toBe('2');
    const sp = screen.getByRole('article', { name: 'Sponsorships' });
    expect(value(sp, 'Used')).toBe('25%');
    const notices = screen.getByRole('article', { name: 'Notices' });
    expect(value(notices, 'Oldest Undelivered')).toBe('3 Hours');
    const fail = screen.getByRole('article', { name: 'Replays, Retries And Failures' });
    expect(value(fail, 'Purchase Replays')).toBe('Answered From The Receipt, Not Recorded');
    expect(value(fail, 'Refund Postcondition Failures')).toBe('1 Failure');
    expect(value(fail, 'Owner Purchase Failures')).toBe('Rolled Back Whole, Not Recorded');
    expect(screen.getByText('Accounting Postcondition Failures').nextSibling?.textContent).toBe(
      '2'
    );
    expect(container.textContent).not.toMatch(/—/);
  });

  it('prints no age as None and a long one in days', async () => {
    answer({
      ...METRICS,
      refund_requests: {
        ...METRICS.refund_requests,
        oldest_awaiting_decision_hours: null,
        oldest_awaiting_execution_hours: 75,
      },
      sponsorships: { active: 0, budget_diamonds: 0, committed_diamonds: 0 },
    });
    render(<CommerceDeskPage />);
    const refunds = await screen.findByRole('article', { name: 'Refunds' });
    expect(value(refunds, 'Oldest Awaiting A Decision')).toBe('None');
    expect(value(refunds, 'Oldest Not Yet Returned')).toBe('3 Days');
    expect(value(screen.getByRole('article', { name: 'Sponsorships' }), 'Used')).toBe('None');
  });

  it('reads another window on request', async () => {
    answer(METRICS);
    render(<CommerceDeskPage />);
    await screen.findByRole('article', { name: 'Payments' });
    fireEvent.click(screen.getByRole('radio', { name: 'Last 7 Days' }));
    await waitFor(() =>
      expect(h.rpc).toHaveBeenCalledWith('fn_ca_commerce_metrics', { p_days: 7 })
    );
  });

  it('prints a refusal in staff words', async () => {
    answer({ success: false, error: 'staff_required' });
    render(<CommerceDeskPage />);
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Only Platform Staff Can Use The Commerce Desk'
    );
  });
});
