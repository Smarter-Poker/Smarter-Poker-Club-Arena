/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  STAFF ANSWER A WRITTEN QUOTE ABOVE 2,500 MEMBERS (20260924182605)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The Commerce Desk's Written Quotes tab reads fn_ca_commerce_written_quotes
 * with no scope (the staff queue), prints each request with the club's name,
 * open requests first, and answers an open one: an offer of a capacity above
 * 2,500, a whole diamond price and a validity of 1 to 30 days, or a decline
 * that needs a note. Both are confirmed first. The real CommerceDeskService
 * runs against a fake supabase that answers in the migration's own shape.
 */

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const CLUB = '0c1ab000-0000-4000-8000-000000000021';
const CLUB2 = '0c1ab000-0000-4000-8000-000000000022';
const OWNER = '0a0e0000-0000-4000-8000-000000000021';
const STAFF = '0a0e0000-0000-4000-8000-000000000029';
const OPEN_ID = '0e000000-0000-4000-8000-000000000021';
const OFFERED_ID = '0e000000-0000-4000-8000-000000000022';

const h = vi.hoisted(() => ({
  rpc: vi.fn(),
  from: vi.fn(),
  confirm: vi.fn(async () => true),
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
  params: new URLSearchParams('tab=written'),
}));

vi.mock('../../src/lib/supabase', () => ({ supabase: { rpc: h.rpc, from: h.from } }));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
vi.mock('../../src/components/common/Toast', () => ({ useToast: () => h.toast }));
vi.mock('../../src/components/common/confirmDialog', () => ({ confirmDialog: h.confirm }));
vi.mock('../../src/hooks/useAuthUser', () => ({ useAuthUser: () => ({ user: { id: STAFF } }) }));
vi.mock('react-router-dom', () => ({ useSearchParams: () => [h.params, vi.fn()] }));

import CommerceDeskPage from '../../src/pages/admin/CommerceDeskPage';

const OPEN = {
  written_quote_id: OPEN_ID,
  scope_kind: 'club',
  scope_id: CLUB,
  requested_by: OWNER,
  requested_capacity: 3000,
  request_note: 'weekend leagues for three towns',
  state: 'requested',
  offered_capacity: null,
  offered_diamonds: null,
  sku: null,
  price_version_id: null,
  valid_until: null,
  decided_by: null,
  decided_at: null,
  staff_note: null,
  created_at: '2026-09-23T06:00:00.000Z',
};

const OFFERED = {
  ...OPEN,
  written_quote_id: OFFERED_ID,
  scope_id: CLUB2,
  requested_capacity: 5000,
  request_note: null,
  state: 'expired',
  offered_capacity: 5000,
  offered_diamonds: 14000,
  sku: 'capacity_wq_0e000000000040008000000000000022',
  valid_until: '2026-09-20T06:00:00.000Z',
  decided_by: STAFF,
  decided_at: '2026-09-19T06:00:00.000Z',
  created_at: '2026-09-18T06:00:00.000Z',
};

function answer(
  list: unknown,
  door: (fn: string, args: Record<string, unknown>) => unknown = () => null
) {
  h.rpc.mockImplementation(async (fn: string, args: Record<string, unknown>) => {
    if (fn === 'fn_ca_commerce_written_quotes')
      return { data: { success: true, written_quotes: list }, error: null };
    const d = door(fn, args);
    if (d) return { data: d, error: null };
    return { data: { success: true }, error: null };
  });
  h.from.mockImplementation((table: string) => ({
    select: () => ({
      in: async () => ({
        data:
          table === 'clubs'
            ? [
                { id: CLUB, name: 'river rats poker' },
                { id: CLUB2, name: 'big lake league' },
              ]
            : table === 'profiles'
              ? [
                  { id: OWNER, username: 'riverowner', alias: null },
                  { id: STAFF, username: 'deskstaff', alias: null },
                ]
              : [],
        error: null,
      }),
    }),
  }));
}

/** The state pill beside a card's title. */
const pill = (card: HTMLElement) => within(card).getByRole('heading').nextSibling?.textContent;

afterEach(() => vi.clearAllMocks());

describe('Commerce Desk: Written Quotes', () => {
  it('reads the staff queue with no scope and prints open requests first, by club name', async () => {
    answer([OFFERED, OPEN]);
    const { container } = render(<CommerceDeskPage />);
    await screen.findByText('River Rats Poker (Club)', { exact: false });
    expect(h.rpc).toHaveBeenCalledWith('fn_ca_commerce_written_quotes', {
      p_scope_kind: null,
      p_scope_id: null,
    });
    const cards = screen.getAllByRole('article');
    expect(cards[0].textContent).toContain('3,000 Members For River Rats Poker (Club)');
    expect(pill(cards[0])).toBe('Requested');
    expect(within(cards[0]).getByText('Weekend Leagues For Three Towns')).toBeTruthy();
    expect(within(cards[0]).getByText('Riverowner')).toBeTruthy();
    const expired = cards[1];
    expect(expired.textContent).toContain('5,000 Members For Big Lake League (Club)');
    expect(pill(expired)).toBe('Expired');
    expect(within(expired).getByText('14,000 Diamonds For 30 Days')).toBeTruthy();
    expect(within(expired).queryByRole('button', { name: 'Offer' })).toBeNull();
    expect(screen.getByText('Awaiting An Answer').nextSibling?.textContent).toBe('1');
    expect(container.textContent).not.toMatch(/—/);
  });

  it('offers a validated capacity, whole price and validity after a confirmation', async () => {
    answer([OPEN], (fn, args) =>
      fn === 'fn_ca_commerce_written_quote_offer'
        ? {
            success: true,
            written_quote: {
              ...OPEN,
              state: 'offered',
              offered_capacity: args.p_capacity,
              offered_diamonds: args.p_diamonds,
              sku: 'capacity_wq_x',
              valid_until: '2026-10-01T06:00:00.000Z',
              decided_by: STAFF,
              decided_at: '2026-09-24T06:00:00.000Z',
            },
          }
        : null
    );
    render(<CommerceDeskPage />);
    const card = await screen.findByRole('article');
    fireEvent.change(within(card).getByLabelText('Capacity To Offer'), {
      target: { value: '2,500' },
    });
    fireEvent.click(within(card).getByRole('button', { name: 'Offer' }));
    expect((await within(card).findByRole('alert')).textContent).toBe(
      'Offer More Than 2,500 And Up To 1,000,000 Members'
    );
    fireEvent.change(within(card).getByLabelText('Capacity To Offer'), {
      target: { value: '3,500' },
    });
    fireEvent.change(within(card).getByLabelText('Diamonds For 30 Days'), {
      target: { value: '9,000.5' },
    });
    fireEvent.click(within(card).getByRole('button', { name: 'Offer' }));
    await waitFor(() =>
      expect(within(card).getByRole('alert').textContent).toBe(
        'Enter A Whole Diamond Price From 1 To 100,000,000'
      )
    );
    fireEvent.change(within(card).getByLabelText('Diamonds For 30 Days'), {
      target: { value: '9,000' },
    });
    fireEvent.change(within(card).getByLabelText('Valid For (Days)'), {
      target: { value: '31' },
    });
    fireEvent.click(within(card).getByRole('button', { name: 'Offer' }));
    await waitFor(() =>
      expect(within(card).getByRole('alert').textContent).toBe('An Offer Is Valid For 1 To 30 Days')
    );
    expect(h.confirm).not.toHaveBeenCalled();
    fireEvent.change(within(card).getByLabelText('Valid For (Days)'), { target: { value: '7' } });
    fireEvent.click(within(card).getByRole('button', { name: 'Offer' }));
    await waitFor(() =>
      expect(h.rpc).toHaveBeenCalledWith('fn_ca_commerce_written_quote_offer', {
        p_written_quote_id: OPEN_ID,
        p_capacity: 3500,
        p_diamonds: 9000,
        p_valid_days: 7,
        p_note: null,
      })
    );
    expect(h.confirm.mock.calls[0][0]).toMatchObject({
      title: 'Offer Written Quote',
      message:
        'Offer River Rats Poker (Club) Up To 3,500 Approved Members For 9,000 Diamonds For 30 Days, Valid For 7 Days? The Owner Is Told Now.',
    });
    await screen.findByText('9,000 Diamonds For 30 Days');
    expect(h.toast.success).toHaveBeenCalledWith('Written Quote Offered: 9,000 Diamonds');
  });

  it('a decline needs a note and is confirmed as destructive', async () => {
    answer([OPEN], (fn) =>
      fn === 'fn_ca_commerce_written_quote_decline'
        ? {
            success: true,
            written_quote: {
              ...OPEN,
              state: 'declined',
              staff_note: 'Not Available At That Size Yet',
              decided_by: STAFF,
              decided_at: '2026-09-24T06:00:00.000Z',
            },
          }
        : null
    );
    render(<CommerceDeskPage />);
    const card = await screen.findByRole('article');
    fireEvent.click(within(card).getByRole('button', { name: 'Decline' }));
    expect((await within(card).findByRole('alert')).textContent).toBe(
      'A Decline Needs A Note Saying Why. A Refund Decline Needs At Least 5 Characters'
    );
    fireEvent.change(within(card).getByLabelText('Note To The Owner'), {
      target: { value: 'Not Available At That Size Yet' },
    });
    fireEvent.click(within(card).getByRole('button', { name: 'Decline' }));
    await waitFor(() =>
      expect(h.rpc).toHaveBeenCalledWith('fn_ca_commerce_written_quote_decline', {
        p_written_quote_id: OPEN_ID,
        p_note: 'Not Available At That Size Yet',
      })
    );
    expect(h.confirm.mock.calls[0][0]).toMatchObject({ variant: 'danger', confirmText: 'Decline' });
    await waitFor(() => expect(pill(screen.getByRole('article'))).toBe('Declined'));
    expect(screen.getByText('Not Available At That Size Yet')).toBeTruthy();
  });

  it('does nothing when the confirmation is cancelled, and prints a refusal in staff words', async () => {
    answer([OPEN], (fn) =>
      fn === 'fn_ca_commerce_written_quote_decline'
        ? { success: false, error: 'written_quote_already_decided' }
        : null
    );
    render(<CommerceDeskPage />);
    const card = await screen.findByRole('article');
    fireEvent.change(within(card).getByLabelText('Note To The Owner'), {
      target: { value: 'Too Large For Now' },
    });
    h.confirm.mockResolvedValueOnce(false);
    fireEvent.click(within(card).getByRole('button', { name: 'Decline' }));
    await waitFor(() => expect(h.confirm).toHaveBeenCalledTimes(1));
    expect(h.rpc).not.toHaveBeenCalledWith(
      'fn_ca_commerce_written_quote_decline',
      expect.anything()
    );
    fireEvent.click(within(card).getByRole('button', { name: 'Decline' }));
    expect((await within(card).findByRole('alert')).textContent).toBe(
      'This Written Quote Request Was Already Answered Or Withdrawn. Refresh The Queue'
    );
  });

  it('says so when the queue is empty or refused', async () => {
    answer([]);
    const { unmount } = render(<CommerceDeskPage />);
    await screen.findByText('No Written Quote Requests Yet');
    unmount();
    h.rpc.mockResolvedValue({ data: { success: false, error: 'staff_required' }, error: null });
    render(<CommerceDeskPage />);
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Only Platform Staff Can Use The Commerce Desk'
    );
  });
});
