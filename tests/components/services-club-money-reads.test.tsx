/**
 * LAUNCH AUDIT S-07 (2026-10-09): Club Bank and promo pot are money columns the
 * clubs SELECT policies expose to every signed-in user for any club. The
 * cashier-side reads the services slice owns stop reading them off the table:
 *
 *   - ChipTransferModal reads the sender's Club Bank through the role-checked
 *     fn_club_money_panel; a refused, failed or malformed answer is Unknown,
 *     never a 0, and a slower read for an earlier club never paints over the
 *     current one.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ids = vi.hoisted(() => ({
  CLUB: '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3',
  CLUB_2: '3b2243ca-6cb3-43f7-8a12-41b8a0ffacf4',
  SENDER: '47965354-0e56-43ef-931c-ddaab82af765',
  AGENT: '11111111-1111-4111-8111-111111111111',
}));
const { CLUB, CLUB_2, AGENT } = ids;

const h = vi.hoisted(() => ({
  rpc: vi.fn(),
  selects: [] as { table: string; arg: string }[],
  reportError: vi.fn(),
  maybeSingle: null as null | ((table: string, arg: string) => Promise<unknown>),
}));

vi.mock('../../src/hooks/useAuthUser', () => ({
  useAuthUser: () => ({ user: { id: ids.SENDER }, isHydrating: false }),
}));
vi.mock('../../src/components/common/Toast', () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }),
}));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: h.reportError }));
vi.mock('../../src/utils/clubIdResolver', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/utils/clubIdResolver')>()),
  resolveClubUUID: async (id: string) => id,
  resolveClubIdFilter: (id: string) => ({ column: 'id', value: id }),
}));
vi.mock('../../src/lib/supabase', () => {
  const chainFor = (table: string) => {
    let arg = '';
    const chain: Record<string, unknown> = {};
    for (const m of ['eq', 'in', 'or', 'order', 'limit', 'ilike', 'update', 'neq']) {
      chain[m] = () => chain;
    }
    chain.select = (value?: string) => {
      arg = value ?? '';
      h.selects.push({ table, arg });
      return chain;
    };
    chain.maybeSingle = () =>
      h.maybeSingle ? h.maybeSingle(table, arg) : Promise.resolve({ data: null, error: null });
    chain.then = (resolveValue: (v: unknown) => unknown) => resolveValue({ data: [], error: null });
    return chain;
  };
  return {
    supabase: {
      rpc: (...args: unknown[]) => h.rpc(...args),
      from: (table: string) => chainFor(table),
    },
    getAuthUser: vi.fn().mockResolvedValue({ data: { user: { id: ids.SENDER } }, error: null }),
  };
});

import ChipTransferModal from '../../src/components/agent/ChipTransferModal';

function deferred<T>() {
  let resolveValue!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolveValue = yes;
  });
  return { promise, resolve: resolveValue };
}

/** Owner sender, a pinned agent recipient, the club name. Nothing reads clubs money. */
function ownerTables(table: string, arg: string): Promise<unknown> {
  if (table === 'club_members' && arg === 'role')
    return Promise.resolve({ data: { role: 'owner' }, error: null });
  if (table === 'club_members' && arg.includes('users:user_id'))
    return Promise.resolve({
      data: {
        user_id: AGENT,
        role: 'agent',
        chip_balance: 12,
        status: 'active',
        users: { id: AGENT, username: 'Rook' },
      },
      error: null,
    });
  if (table === 'clubs' && arg === 'name')
    return Promise.resolve({ data: { name: 'Deep Stack Society' }, error: null });
  return Promise.resolve({ data: null, error: null });
}

const balance = () => document.querySelector('.agent-balance .balance-amount')?.textContent;

beforeEach(() => {
  h.rpc.mockReset();
  h.selects.length = 0;
  h.reportError.mockReset();
  h.maybeSingle = ownerTables;
});

describe('ChipTransferModal reads the Club Bank through fn_club_money_panel', () => {
  it('paints the authorized panel figure and never selects clubs.chip_treasury', async () => {
    h.rpc.mockImplementation((name: string) =>
      Promise.resolve(
        name === 'fn_club_money_panel'
          ? { data: { authorized: true, scope: 'club', club_treasury: 1234567 }, error: null }
          : { data: [], error: null }
      )
    );
    render(<ChipTransferModal isOpen onClose={() => {}} clubId={CLUB} recipientId={AGENT} />);
    await waitFor(() => expect(screen.getByText('Your Club Bank:')).toBeTruthy());
    await waitFor(() => expect(balance()).toBe('1.2M'));
    expect(h.rpc).toHaveBeenCalledWith('fn_club_money_panel', { p_club_id: CLUB });
    expect(
      h.selects.filter((s) => s.table === 'clubs' && /chip_treasury|promo_balance|\*/.test(s.arg))
    ).toEqual([]);
  });

  it.each([
    ['a refusal', { data: { authorized: false, reason: 'not_a_member' }, error: null }],
    ['a failed read', { data: null, error: { code: '57014', message: 'timeout' } }],
    ['a malformed figure', { data: { authorized: true, club_treasury: 'lots' }, error: null }],
  ])('%s is Unknown, never a 0, and is reported', async (_label, answer) => {
    h.rpc.mockImplementation((name: string) =>
      Promise.resolve(name === 'fn_club_money_panel' ? answer : { data: [], error: null })
    );
    render(<ChipTransferModal isOpen onClose={() => {}} clubId={CLUB} recipientId={AGENT} />);
    await waitFor(() => expect(screen.getByText('Your Club Bank:')).toBeTruthy());
    await waitFor(() =>
      expect(h.reportError).toHaveBeenCalledWith(
        expect.anything(),
        'ChipTransferModal.club_bank_read'
      )
    );
    expect(balance()).toBe('Unknown');
    // The send preview says Unknown too, never "0 -> 0".
    await waitFor(() => expect(screen.getByText('Agent Wallet')).toBeTruthy());
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '25' } });
    const preview = await screen.findByText('You:');
    expect(preview.parentElement?.textContent).toBe('You:Unknown');
  });

  it('a slower read for an earlier club never paints over the current club', async () => {
    const first = deferred<unknown>();
    h.rpc.mockImplementation((name: string, args: { p_club_id?: string }) => {
      if (name !== 'fn_club_money_panel') return Promise.resolve({ data: [], error: null });
      return args.p_club_id === CLUB
        ? first.promise
        : Promise.resolve({ data: { authorized: true, club_treasury: 222 }, error: null });
    });
    const view = render(
      <ChipTransferModal isOpen onClose={() => {}} clubId={CLUB} recipientId={AGENT} />
    );
    await waitFor(() =>
      expect(h.rpc).toHaveBeenCalledWith('fn_club_money_panel', { p_club_id: CLUB })
    );
    view.rerender(
      <ChipTransferModal isOpen onClose={() => {}} clubId={CLUB_2} recipientId={AGENT} />
    );
    await waitFor(() => expect(balance()).toBe('222.00'));
    await act(async () => {
      first.resolve({ data: { authorized: true, club_treasury: 111 }, error: null });
      await first.promise;
    });
    expect(balance()).toBe('222.00');
  });
});
