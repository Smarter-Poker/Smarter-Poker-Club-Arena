/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  STAFF DECIDE A FREE MONTH REVIEW (20260924182605)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * An operator's later club inherits the first free month's end. The owner of
 * a genuinely new operation asks for a review with a statement; the Commerce
 * Desk's Free Month Reviews tab reads fn_ca_commerce_trial_reviews with no
 * scope, prints the statement and the club by name, and approves (with an
 * optional note, printing the granted free month's end) or declines (a note
 * is required). Both are confirmed first; staff never decide a review of
 * their own club. The real CommerceDeskService runs against a fake supabase
 * that answers in the migration's own shape.
 */

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const CLUB = '0c1ab000-0000-4000-8000-000000000031';
const CLUB2 = '0c1ab000-0000-4000-8000-000000000032';
const OWNER = '0a0e0000-0000-4000-8000-000000000031';
const STAFF = '0a0e0000-0000-4000-8000-000000000039';
const REVIEW = '0e000000-0000-4000-8000-000000000031';
const OWN_REVIEW = '0e000000-0000-4000-8000-000000000032';

const h = vi.hoisted(() => ({
  rpc: vi.fn(),
  from: vi.fn(),
  confirm: vi.fn(async () => true),
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
  params: new URLSearchParams('tab=reviews'),
}));

vi.mock('../../src/lib/supabase', () => ({ supabase: { rpc: h.rpc, from: h.from } }));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
vi.mock('../../src/components/common/Toast', () => ({ useToast: () => h.toast }));
vi.mock('../../src/components/common/confirmDialog', () => ({ confirmDialog: h.confirm }));
vi.mock('../../src/hooks/useAuthUser', () => ({ useAuthUser: () => ({ user: { id: STAFF } }) }));
vi.mock('react-router-dom', () => ({ useSearchParams: () => [h.params, vi.fn()] }));

import CommerceDeskPage from '../../src/pages/admin/CommerceDeskPage';

const OPEN = {
  review_id: REVIEW,
  scope_kind: 'club',
  scope_id: CLUB,
  operator_id: OWNER,
  requested_by: OWNER,
  statement: 'a new independent operation with its own members in another city',
  state: 'requested',
  decided_by: null,
  decided_at: null,
  staff_note: null,
  granted_trial_id: null,
  granted_trial_end: null,
  created_at: '2026-09-23T06:00:00.000Z',
};

const OWN = {
  ...OPEN,
  review_id: OWN_REVIEW,
  scope_id: CLUB2,
  operator_id: STAFF,
  requested_by: STAFF,
  created_at: '2026-09-22T06:00:00.000Z',
};

const GRANTED_END = '2026-10-24T06:00:00.000Z';

function answer(
  list: unknown,
  door: (fn: string, args: Record<string, unknown>) => unknown = () => null
) {
  h.rpc.mockImplementation(async (fn: string, args: Record<string, unknown>) => {
    if (fn === 'fn_ca_commerce_trial_reviews')
      return { data: { success: true, reviews: list }, error: null };
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
                { id: CLUB, name: 'north shore poker' },
                { id: CLUB2, name: 'staff home game' },
              ]
            : table === 'profiles'
              ? [{ id: OWNER, username: 'northowner', alias: null }]
              : [],
        error: null,
      }),
    }),
  }));
}

const pill = (card: HTMLElement) => within(card).getByRole('heading').nextSibling?.textContent;
const card = (name: RegExp) =>
  screen.getAllByRole('article').find((a) => name.test(a.textContent ?? '')) as HTMLElement;

afterEach(() => vi.clearAllMocks());

describe('Commerce Desk: Free Month Reviews', () => {
  it('reads the staff queue with no scope and prints the statement and the club by name', async () => {
    answer([OPEN, OWN]);
    const { container } = render(<CommerceDeskPage />);
    await screen.findByText('Free Month For North Shore Poker (Club)');
    expect(h.rpc).toHaveBeenCalledWith('fn_ca_commerce_trial_reviews', {
      p_scope_kind: null,
      p_scope_id: null,
    });
    const open = card(/North Shore Poker/);
    expect(pill(open)).toBe('Requested');
    expect(
      within(open).getByText('A New Independent Operation With Its Own Members In Another City')
    ).toBeTruthy();
    expect(within(open).getByText('Northowner')).toBeTruthy();
    expect(within(open).getByRole('button', { name: 'Approve' })).toBeTruthy();
    // A staff member's own club: the desk says so and offers no decision.
    const own = card(/Staff Home Game/);
    expect(within(own).queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(
      within(own).getByText(
        'You Cannot Decide A Review Of Your Own Club Or Union. Another Staff Member Decides It.'
      )
    ).toBeTruthy();
    expect(screen.getByText('Awaiting A Decision').nextSibling?.textContent).toBe('2');
    expect(container.textContent).not.toMatch(/—/);
  });

  it('approves with an optional note after a confirmation and prints the granted end', async () => {
    answer([OPEN], (fn) =>
      fn === 'fn_ca_commerce_trial_review_decide'
        ? {
            success: true,
            review: {
              ...OPEN,
              state: 'approved',
              decided_by: STAFF,
              decided_at: '2026-09-24T06:00:00.000Z',
              granted_trial_id: '0f000000-0000-4000-8000-000000000031',
              granted_trial_end: GRANTED_END,
            },
          }
        : null
    );
    render(<CommerceDeskPage />);
    await screen.findByText('Free Month For North Shore Poker (Club)');
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() =>
      expect(h.rpc).toHaveBeenCalledWith('fn_ca_commerce_trial_review_decide', {
        p_review_id: REVIEW,
        p_approve: true,
        p_note: null,
      })
    );
    expect(h.confirm.mock.calls[0][0]).toMatchObject({
      title: 'Approve Free Month',
      message:
        'Grant North Shore Poker (Club) A Fresh 30 Day Free Month Starting Now? The Owner Is Told Now And Gets The Usual Reminders.',
    });
    await waitFor(() => expect(pill(screen.getByRole('article'))).toBe('Approved'));
    expect(screen.getByText('Free Month Ends')).toBeTruthy();
    const ends = new Date(GRANTED_END).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
    expect(screen.getByText('Free Month Ends').nextSibling?.textContent).toBe(ends);
  });

  it('a decline needs a note and is confirmed as destructive', async () => {
    answer([OPEN], (fn) =>
      fn === 'fn_ca_commerce_trial_review_decide'
        ? {
            success: true,
            review: {
              ...OPEN,
              state: 'declined',
              decided_by: STAFF,
              decided_at: '2026-09-24T06:00:00.000Z',
              staff_note: 'Same Operation As Your First Club',
            },
          }
        : null
    );
    render(<CommerceDeskPage />);
    await screen.findByText('Free Month For North Shore Poker (Club)');
    fireEvent.click(screen.getByRole('button', { name: 'Decline' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'A Decline Needs A Note Saying Why. A Refund Decline Needs At Least 5 Characters'
    );
    expect(h.confirm).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Note To The Owner'), {
      target: { value: 'Same Operation As Your First Club' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Decline' }));
    await waitFor(() =>
      expect(h.rpc).toHaveBeenCalledWith('fn_ca_commerce_trial_review_decide', {
        p_review_id: REVIEW,
        p_approve: false,
        p_note: 'Same Operation As Your First Club',
      })
    );
    expect(h.confirm.mock.calls[0][0]).toMatchObject({ variant: 'danger', confirmText: 'Decline' });
    await waitFor(() => expect(pill(screen.getByRole('article'))).toBe('Declined'));
    expect(screen.getByText('Same Operation As Your First Club')).toBeTruthy();
  });

  it('prints a refusal in staff words and keeps the server copy of the review', async () => {
    answer([OPEN], (fn) =>
      fn === 'fn_ca_commerce_trial_review_decide'
        ? {
            success: false,
            error: 'trial_review_already_decided',
            review: { ...OPEN, state: 'declined', staff_note: 'Declined Elsewhere' },
          }
        : null
    );
    render(<CommerceDeskPage />);
    await screen.findByText('Free Month For North Shore Poker (Club)');
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Another Staff Member Already Decided This Review. Refresh The Queue'
    );
    expect(pill(screen.getByRole('article'))).toBe('Declined');
  });

  it('says so when there are no reviews', async () => {
    answer([]);
    render(<CommerceDeskPage />);
    await screen.findByText('No Free Month Reviews Yet');
  });
});
