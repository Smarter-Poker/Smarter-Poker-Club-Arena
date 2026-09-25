/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  STAFF SEE WHAT ENFORCEMENT WOULD REFUSE BEFORE ANYONE SWITCHES IT ON
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 20260924102056 records every admission decision in shadow and gives staff
 * one read of them, fn_ca_commerce_admission_report. The Commerce Desk's
 * Admission tab prints it: the enforcement state, the totals, each door in
 * words (never a function name as the title), and the clubs a would-deny fell
 * on, by name. The real CommerceDeskService runs against a fake supabase that
 * answers in the migration's own JSON shape.
 */

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const CLUB = '0c1ab000-0000-4000-8000-000000000009';
const STAFF = '0a0e0000-0000-4000-8000-000000000009';

const h = vi.hoisted(() => ({
  rpc: vi.fn(),
  from: vi.fn(),
  params: new URLSearchParams('tab=admission'),
}));

vi.mock('../../src/lib/supabase', () => ({ supabase: { rpc: h.rpc, from: h.from } }));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
vi.mock('../../src/components/common/Toast', () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }),
}));
vi.mock('../../src/hooks/useAuthUser', () => ({ useAuthUser: () => ({ user: { id: STAFF } }) }));
vi.mock('react-router-dom', () => ({
  useSearchParams: () => [h.params, vi.fn()],
}));

import CommerceDeskPage from '../../src/pages/admin/CommerceDeskPage';

const REPORT = {
  success: true,
  days: 30,
  since: '2026-08-25T00:00:00.000Z',
  enforced_from: null,
  enforced: false,
  doors: [
    {
      action: 'join_member',
      door: 'fn_join_club',
      decisions: 12,
      would_deny: 9,
      refused: 0,
      undecided: 0,
      scopes_would_deny: 2,
      last_at: '2026-09-24T06:00:00.000Z',
    },
    {
      action: 'open_table',
      door: 'fn_cash_game_create',
      decisions: 3,
      would_deny: 0,
      refused: 0,
      undecided: 1,
      scopes_would_deny: 0,
      last_at: '2026-09-23T06:00:00.000Z',
    },
  ],
  scopes: [
    {
      scope_kind: 'club',
      scope_id: CLUB,
      would_deny: 9,
      refused: 0,
      reasons: ['capacity_reached', 'no_effective_entitlement'],
      last_at: '2026-09-24T06:00:00.000Z',
    },
  ],
};

function answer(report: unknown) {
  h.rpc.mockImplementation(async (fn: string, args: Record<string, unknown>) => {
    if (fn === 'fn_ca_commerce_admission_report') return { data: report, error: null, args };
    return { data: { success: true }, error: null };
  });
  h.from.mockImplementation((table: string) => ({
    select: () => ({
      in: async () => ({
        data: table === 'clubs' ? [{ id: CLUB, name: 'river rats poker' }] : [],
        error: null,
      }),
    }),
  }));
}

afterEach(() => vi.clearAllMocks());

describe('Commerce Desk: Admission', () => {
  it('prints the shadow report in words, with club names and no em dash', async () => {
    answer(REPORT);
    const { container } = render(<CommerceDeskPage />);
    await screen.findByText('Player Joins A Club That Admits Automatically');
    expect(h.rpc).toHaveBeenCalledWith('fn_ca_commerce_admission_report', { p_days: 30 });
    expect(screen.getByText('Off. Admission Runs In Shadow')).toBeTruthy();
    const joins = screen.getByRole('article', {
      name: 'Player Joins A Club That Admits Automatically',
    });
    expect(within(joins).getByText('9 Would Refuse')).toBeTruthy();
    expect(within(joins).getByText('Member Joins Without Review')).toBeTruthy();
    const table = screen.getByRole('article', { name: 'Owner Opens A Cash Game' });
    expect(within(table).getByText('All Allowed')).toBeTruthy();
    expect(within(table).getByText('Decision Unavailable')).toBeTruthy();
    await screen.findByText('River Rats Poker (Club)');
    expect(screen.getByText('Member Capacity Reached, No Operating Access')).toBeTruthy();
    expect(container.textContent).not.toMatch(/—/);
  });

  it('reads another window on request', async () => {
    answer(REPORT);
    render(<CommerceDeskPage />);
    await screen.findByText('Player Joins A Club That Admits Automatically');
    fireEvent.click(screen.getByRole('radio', { name: 'Last 90 Days' }));
    await waitFor(() =>
      expect(h.rpc).toHaveBeenCalledWith('fn_ca_commerce_admission_report', { p_days: 90 })
    );
  });

  it('says so when enforcement is on, and when nothing has been decided', async () => {
    answer({
      ...REPORT,
      enforced: true,
      enforced_from: '2026-10-01T00:00:00.000Z',
      doors: [],
      scopes: [],
    });
    render(<CommerceDeskPage />);
    await screen.findByText(/^On Since /);
    expect(screen.getByText('No Admission Decisions In The Last 30 Days')).toBeTruthy();
    expect(screen.getByText('None In The Last 30 Days')).toBeTruthy();
  });

  it('prints a refusal in staff words', async () => {
    answer({ success: false, error: 'staff_required' });
    render(<CommerceDeskPage />);
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Only Platform Staff Can Use The Commerce Desk'
    );
  });
});
