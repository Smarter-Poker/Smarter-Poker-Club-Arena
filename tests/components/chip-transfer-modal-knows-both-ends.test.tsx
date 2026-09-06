/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  THE CHIP TRANSFER MODAL KNOWS BOTH ENDS BEFORE IT MOVES ANYTHING
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * WHY THIS EXISTS (2026-09-04, phase 5)
 *
 * Member Management opens this modal with `recipientId` set and Confirm was
 * enabled the moment an amount was typed. The recipient's ROLE, which decides
 * the destination wallet, came from a recipient list that took three to four
 * sequential reads to arrive. With the role still unknown, p_destination fell
 * through to 'player_wallet' - and fn_club_bank_send honours p_destination -
 * so "Fund Them Now" on a freshly promoted agent could credit their player
 * wallet. The sender's role, which decides whether the club bank or the agent
 * wallet is DEBITED, was read with its error ignored and defaulted to
 * 'member'.
 *
 * These cases hold the send closed until both roles are read, and assert the
 * destination that goes over the wire.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ids = vi.hoisted(() => ({
  CLUB: '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3',
  SENDER: '47965354-0e56-43ef-931c-ddaab82af765',
  AGENT: '11111111-1111-4111-8111-111111111111',
}));
const { CLUB, SENDER, AGENT } = ids;

const rpcMock = vi.hoisted(() => vi.fn());
const fromMock = vi.hoisted(() => vi.fn());
const toastState = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
/** Per-test knobs for what the table reads answer. */
const db = vi.hoisted(() => ({
  senderRole: { data: { role: 'owner' }, error: null } as { data: unknown; error: unknown },
  pinned: {
    data: {
      user_id: '11111111-1111-4111-8111-111111111111',
      role: 'agent',
      chip_balance: 12,
      status: 'active',
      users: { id: '11111111-1111-4111-8111-111111111111', username: 'Rook' },
    },
    error: null,
  } as { data: unknown; error: unknown },
  pinnedDelayMs: 0,
  clubOwner: '47965354-0e56-43ef-931c-ddaab82af765' as string | null,
}));

vi.mock('../../src/hooks/useAuthUser', () => ({
  useAuthUser: () => ({ user: { id: ids.SENDER }, isHydrating: false }),
}));
vi.mock('../../src/components/common/Toast', () => ({ useToast: () => toastState }));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
vi.mock('../../src/utils/clubIdResolver', () => ({
  resolveClubUUID: async () => ids.CLUB,
  resolveClubIdFilter: () => ({ column: 'id', value: ids.CLUB }),
}));
vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    rpc: (...args: unknown[]) => rpcMock(...args),
    from: (...args: unknown[]) => fromMock(...args),
  },
}));

import ChipTransferModal from '../../src/components/agent/ChipTransferModal';

/** A tiny PostgREST builder: records the filters and answers by table + shape. */
function chainFor(table: string) {
  const filters: Record<string, unknown> = {};
  let selectArg = '';
  const chain: Record<string, unknown> = {};
  for (const m of ['eq', 'in', 'or', 'order', 'limit']) {
    chain[m] = (k: string, v?: unknown) => {
      filters[`${m}:${k}`] = v;
      return chain;
    };
  }
  chain.select = (arg: string) => {
    selectArg = arg;
    return chain;
  };
  chain.maybeSingle = async () => {
    if (table === 'club_members' && filters['eq:user_id'] === SENDER) return db.senderRole;
    if (
      table === 'club_members' &&
      filters['eq:user_id'] === AGENT &&
      selectArg.includes('users:user_id')
    ) {
      if (db.pinnedDelayMs) await new Promise((r) => setTimeout(r, db.pinnedDelayMs));
      return db.pinned;
    }
    if (table === 'clubs' && selectArg.includes('chip_treasury'))
      return { data: { chip_treasury: 1000000 }, error: null };
    if (table === 'clubs' && selectArg.includes('owner_id'))
      return { data: { owner_id: db.clubOwner }, error: null };
    if (table === 'clubs') return { data: { name: 'Deep Stack Society' }, error: null };
    if (table === 'agents') return { data: { agent_wallet_balance: 500 }, error: null };
    return { data: null, error: null };
  };
  chain.then = (resolve: (v: unknown) => unknown) => resolve({ data: [], error: null });
  return chain;
}

beforeEach(() => {
  rpcMock.mockReset();
  fromMock.mockReset();
  fromMock.mockImplementation((table: string) => chainFor(table));
  rpcMock.mockImplementation((name: string) => {
    if (name === 'fn_club_bank_send' || name === 'fn_agent_wallet_send') {
      return Promise.resolve({ data: { success: true }, error: null });
    }
    return Promise.resolve({ data: [], error: null });
  });
  db.senderRole = { data: { role: 'owner' }, error: null };
  db.pinned = {
    data: {
      user_id: AGENT,
      role: 'agent',
      chip_balance: 12,
      status: 'active',
      users: { id: AGENT, username: 'Rook' },
    },
    error: null,
  };
  db.pinnedDelayMs = 0;
  db.clubOwner = SENDER;
});

const confirmButton = () => screen.getByRole('button', { name: /Confirm Transfer|Processing/ });

describe('funding a named recipient', () => {
  it('sends to the AGENT wallet once the recipient role is read', async () => {
    render(<ChipTransferModal isOpen onClose={() => {}} clubId={CLUB} recipientId={AGENT} />);
    await waitFor(() => expect(screen.getByText('Agent Wallet')).toBeTruthy());
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '250' } });
    await waitFor(() => expect((confirmButton() as HTMLButtonElement).disabled).toBe(false));
    await act(async () => {
      fireEvent.click(confirmButton());
    });
    await waitFor(() => expect(rpcMock).toHaveBeenCalled());
    const [fn, args] = rpcMock.mock.calls.find((c) => String(c[0]).endsWith('_send'))!;
    expect(fn).toBe('fn_club_bank_send');
    expect(args).toMatchObject({
      p_to_user_id: AGENT,
      p_amount: 250,
      p_destination: 'agent_wallet',
    });
  });

  it('keeps Confirm closed, and sends nothing, while the recipient is still unknown', async () => {
    db.pinnedDelayMs = 400;
    render(<ChipTransferModal isOpen onClose={() => {}} clubId={CLUB} recipientId={AGENT} />);
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '250' } });
    // Before the read lands the button is disabled; a click must not send.
    expect((confirmButton() as HTMLButtonElement).disabled).toBe(true);
    await act(async () => {
      fireEvent.click(confirmButton());
    });
    expect(rpcMock.mock.calls.filter((c) => String(c[0]).endsWith('_send'))).toHaveLength(0);
    await waitFor(() => expect((confirmButton() as HTMLButtonElement).disabled).toBe(false), {
      timeout: 2000,
    });
  });

  it('names a recipient who is not a member and never sends', async () => {
    db.pinned = { data: null, error: null };
    render(<ChipTransferModal isOpen onClose={() => {}} clubId={CLUB} recipientId={AGENT} />);
    await waitFor(() =>
      expect(screen.getByText('That Person Is Not A Member Of This Club')).toBeTruthy()
    );
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '5' } });
    expect((confirmButton() as HTMLButtonElement).disabled).toBe(true);
    expect(rpcMock.mock.calls.filter((c) => String(c[0]).endsWith('_send'))).toHaveLength(0);
  });
});

describe('the sender role', () => {
  it('is never defaulted: a failed read closes the modal to sending and says so', async () => {
    db.senderRole = { data: null, error: { code: 'PGRST301', message: 'boom' } };
    render(<ChipTransferModal isOpen onClose={() => {}} clubId={CLUB} recipientId={AGENT} />);
    await waitFor(() =>
      expect(
        screen.getByText('Your Club Role Could Not Be Read. Nothing Can Be Sent Until It Is.')
      ).toBeTruthy()
    );
    await waitFor(() => expect(screen.getByText('Agent Wallet')).toBeTruthy());
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '250' } });
    expect((confirmButton() as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Your Wallet:')).toBeTruthy();
  });

  it('routes an agent sender through the agent wallet RPC', async () => {
    db.senderRole = { data: { role: 'agent' }, error: null };
    rpcMock.mockImplementation((name: string) => {
      if (name === 'fn_club_cashier_members') return Promise.resolve({ data: [], error: null });
      return Promise.resolve({ data: { success: true }, error: null });
    });
    render(<ChipTransferModal isOpen onClose={() => {}} clubId={CLUB} recipientId={AGENT} />);
    await waitFor(() => expect(screen.getByText('Your Agent Wallet:')).toBeTruthy());
    await waitFor(() => expect(screen.getByText('Agent Wallet')).toBeTruthy());
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '9999' } });
    await waitFor(() => expect((confirmButton() as HTMLButtonElement).disabled).toBe(false));
    await act(async () => {
      fireEvent.click(confirmButton());
    });
    // 9,999 is above the 500 float: the CLIENT does not refuse an agent send,
    // because the server may fund it from a credit line the browser cannot
    // see. The server is the one that decides.
    await waitFor(() =>
      expect(rpcMock.mock.calls.some((c) => c[0] === 'fn_agent_wallet_send')).toBe(true)
    );
  });
});

describe('the verification pass (2026-09-04, same day)', () => {
  it('routes the club owner through the club bank even with no membership row', async () => {
    // fn_club_bank_role treats clubs.owner_id as 'owner'; the modal used to
    // read club_members alone and fall to 'player', the agent-wallet RPC.
    db.senderRole = { data: null, error: null };
    db.clubOwner = SENDER;
    render(<ChipTransferModal isOpen onClose={() => {}} clubId={CLUB} recipientId={AGENT} />);
    await waitFor(() => expect(screen.getByText('Your Club Bank:')).toBeTruthy());
    await waitFor(() => expect(screen.getByText('Agent Wallet')).toBeTruthy());
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '10' } });
    await waitFor(() => expect((confirmButton() as HTMLButtonElement).disabled).toBe(false));
    await act(async () => {
      fireEvent.click(confirmButton());
    });
    await waitFor(() =>
      expect(rpcMock.mock.calls.some((c) => c[0] === 'fn_club_bank_send')).toBe(true)
    );
  });

  it('forgets the previous recipient when reopened for another one', async () => {
    // The Agent Team console reuses one modal for every agent it funds.
    db.pinned = { data: null, error: null };
    const view = render(
      <ChipTransferModal isOpen onClose={() => {}} clubId={CLUB} recipientId={AGENT} />
    );
    await waitFor(() =>
      expect(screen.getByText('That Person Is Not A Member Of This Club')).toBeTruthy()
    );
    // Close, then reopen for a recipient who IS a member.
    view.rerender(<ChipTransferModal isOpen={false} onClose={() => {}} clubId={CLUB} />);
    db.pinned = {
      data: {
        user_id: AGENT,
        role: 'agent',
        chip_balance: 12,
        status: 'active',
        users: { id: AGENT, username: 'Rook' },
      },
      error: null,
    };
    view.rerender(
      <ChipTransferModal isOpen onClose={() => {}} clubId={CLUB} recipientId={AGENT} />
    );
    await waitFor(() => expect(screen.getByText('Agent Wallet')).toBeTruthy());
    expect(screen.queryByText('That Person Is Not A Member Of This Club')).toBeNull();
  });
});

describe('the dialog', () => {
  it('is a labelled modal dialog whose inputs have labels', async () => {
    render(<ChipTransferModal isOpen onClose={() => {}} clubId={CLUB} recipientId={AGENT} />);
    const dialog = screen.getByRole('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(screen.getByLabelText('Amount')).toBeTruthy();
    expect(screen.getByLabelText('Note (Optional)')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy();
    await waitFor(() => expect(screen.getByText('Your Club Bank:')).toBeTruthy());
    await waitFor(() => expect(screen.getByText('Agent Wallet')).toBeTruthy());
  });

  it('locks background scroll, traps keyboard focus, and restores the opener', async () => {
    const opener = document.createElement('button');
    opener.textContent = 'Open Cashier';
    document.body.appendChild(opener);
    opener.focus();

    const view = render(
      <ChipTransferModal isOpen onClose={() => {}} clubId={CLUB} recipientId={AGENT} />
    );
    const dialog = screen.getByRole('dialog');
    const close = screen.getByRole('button', { name: 'Close' });
    await waitFor(() => expect(close).toHaveFocus());
    expect(document.body.style.overflow).toBe('hidden');

    await waitFor(() => expect(screen.getByText('Agent Wallet')).toBeTruthy());
    const enabled = Array.from(
      dialog.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )
    );
    const last = enabled.at(-1)!;
    last.focus();
    fireEvent.keyDown(dialog.parentElement!, { key: 'Tab' });
    expect(close).toHaveFocus();

    view.rerender(<ChipTransferModal isOpen={false} onClose={() => {}} clubId={CLUB} />);
    expect(document.body.style.overflow).toBe('');
    expect(opener).toHaveFocus();
    opener.remove();
  });
});
