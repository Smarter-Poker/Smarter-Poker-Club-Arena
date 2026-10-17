/**
 * A LOST RESPONSE IS NOT A REFUSAL (cashier launch, round 2, 2026-10-09).
 *
 * supabase-js does not reject when fetch() fails: postgrest-js RESOLVES with
 * `{ data: null, error: { message: 'TypeError: Failed to fetch', code: '' },
 * status: 0 }`. The union wallet sheet read every resolved `error` as a server
 * refusal and retired the operation id, so the operator's retry of a send the
 * server had already committed went out under a NEW id and paid twice
 * (.agent-logs/C5-probe-union-transport). An id is retired only by a definitive
 * outcome: success, a `success:false` body, or a SQL refusal carried on a 4xx.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const UNION_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const rpc = vi.fn();
const unionClubs = [{ club_id: 'c-2', clubs: { name: 'SHARK CLUB' } }];
const fromChain = (table?: string) => {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'in', 'order', 'limit', 'range', 'contains'])
    chain[m] = () => chain;
  chain.then = (resolve: (v: { data: unknown[]; error: null }) => void) =>
    resolve({ data: table === 'union_clubs' ? unionClubs : [], error: null });
  return chain;
};
vi.mock('../src/lib/supabase', () => ({
  /* The directory RPC is paged (.order().order().range(), 2026-10-17), so a
     result is a thenable that also answers the builder methods. */
  supabase: {
    rpc: (...a: unknown[]) => {
      const result = rpc(...a) as PromiseLike<unknown>;
      const chain: Record<string, unknown> = {
        then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) =>
          Promise.resolve(result).then(ok, bad),
      };
      for (const m of ['order', 'range', 'limit']) chain[m] = () => chain;
      return chain;
    },
    from: (t: string) => fromChain(t),
  },
}));
vi.mock('../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
vi.mock('../src/hooks/useAuthUser', () => ({
  useAuthUser: () => ({
    user: { id: '11111111-1111-4111-8111-111111111111' },
    isAuthenticated: true,
    isHydrating: false,
  }),
}));
vi.mock('../src/services/UnionApiService', () => ({
  unionApi: { promoSend: vi.fn(), sendToClub: vi.fn() },
}));

import UnionWalletModal from '../src/components/union/UnionWalletModal';

const roster = [
  {
    user_id: 'u-2',
    username: 'fish',
    display_name: 'Fish',
    avatar_url: null,
    club_id: 'c-2',
    club_name: 'SHARK',
    member_role: 'member',
    member_status: 'active',
  },
];
const base = {
  isOpen: true,
  onClose: vi.fn(),
  unionId: UNION_ID,
  walletKey: 'chips' as const,
  walletLabel: 'Union Bank',
  balance: 5000,
};
/** Exactly what postgrest-js 2.x resolves with when fetch() itself fails. */
const lostResponse = () =>
  Promise.resolve({
    data: null,
    error: { message: 'TypeError: Failed to fetch', details: '', hint: '', code: '' },
    count: null,
    status: 0,
    statusText: '',
  });
/** A RAISE in the function: a real refusal, carried on a 4xx with an SQL code. */
const sqlRefusal = () =>
  Promise.resolve({
    data: null,
    error: { message: 'Insufficient balance in the selected union wallet.', code: 'P0001' },
    status: 400,
  });

const opIds = (fn: string) =>
  rpc.mock.calls
    .filter(([name]) => name === fn)
    .map(([, args]) => (args as { p_op_id: string }).p_op_id);

beforeEach(() => {
  window.localStorage.clear();
  rpc.mockReset();
});

async function sendToFish(amount = '250') {
  await waitFor(() => expect(screen.getByText('Fish')).toBeTruthy());
  fireEvent.click(screen.getByText('Fish'));
  fireEvent.click(screen.getByRole('button', { name: /send out to fish/i }));
  fireEvent.change(screen.getByPlaceholderText('Amount'), { target: { value: amount } });
  fireEvent.click(screen.getByRole('button', { name: /send to fish/i }));
}

describe('a member send whose response is lost keeps its operation id', () => {
  it('retries a committed send under the SAME id, and says the outcome is not yet confirmed', async () => {
    let attempt = 0;
    rpc.mockImplementation((fn: string) => {
      if (fn === 'fn_union_player_directory') return Promise.resolve({ data: roster, error: null });
      if (fn === 'fn_union_send_to_member') {
        attempt += 1;
        return attempt === 1
          ? lostResponse()
          : Promise.resolve({ data: { success: true, replayed: true }, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    });
    render(<UnionWalletModal {...base} />);
    await sendToFish();
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/Not Yet Confirmed/);
    expect(alert.textContent).not.toMatch(/Failed To Fetch|Refused/i);

    fireEvent.click(screen.getByRole('button', { name: /send to fish/i }));
    expect((await screen.findByRole('status')).textContent).toMatch(/Sent 250/);
    const ids = opIds('fn_union_send_to_member');
    expect(ids).toHaveLength(2);
    expect(ids[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(ids[1]).toBe(ids[0]);
  });

  it('still retires the id after a real SQL refusal, so a corrected send is new', async () => {
    let attempt = 0;
    rpc.mockImplementation((fn: string) => {
      if (fn === 'fn_union_player_directory') return Promise.resolve({ data: roster, error: null });
      if (fn === 'fn_union_send_to_member') {
        attempt += 1;
        return attempt === 1
          ? sqlRefusal()
          : Promise.resolve({ data: { success: true }, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    });
    render(<UnionWalletModal {...base} />);
    await sendToFish();
    expect((await screen.findByRole('alert')).textContent).toMatch(/Insufficient/i);
    fireEvent.click(screen.getByRole('button', { name: /send to fish/i }));
    await screen.findByRole('status');
    const ids = opIds('fn_union_send_to_member');
    expect(ids).toHaveLength(2);
    expect(ids[1]).not.toBe(ids[0]);
  });

  it('holds the id across a 503 gateway answer as well', async () => {
    let attempt = 0;
    rpc.mockImplementation((fn: string) => {
      if (fn === 'fn_union_player_directory') return Promise.resolve({ data: roster, error: null });
      if (fn === 'fn_union_send_to_member') {
        attempt += 1;
        return attempt === 1
          ? Promise.resolve({
              data: null,
              error: { message: 'upstream', code: 'PGRST000' },
              status: 503,
            })
          : Promise.resolve({ data: { success: true }, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    });
    render(<UnionWalletModal {...base} />);
    await sendToFish();
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: /send to fish/i }));
    await screen.findByRole('status');
    const ids = opIds('fn_union_send_to_member');
    expect(ids[1]).toBe(ids[0]);
  });
});

describe('a clawback whose response is lost keeps its operation id', () => {
  it('pulls again under the SAME id', async () => {
    let attempt = 0;
    rpc.mockImplementation((fn: string) => {
      if (fn === 'fn_union_player_directory') return Promise.resolve({ data: roster, error: null });
      if (fn === 'fn_union_clawback_from_club') {
        attempt += 1;
        return attempt === 1
          ? lostResponse()
          : Promise.resolve({ data: { success: true, union_balance: 5010 }, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    });
    render(<UnionWalletModal {...base} />);
    await waitFor(() => expect(screen.getByText('SHARK CLUB')).toBeTruthy());
    fireEvent.click(screen.getByText('SHARK CLUB'));
    fireEvent.click(screen.getByRole('button', { name: /pull back from shark club/i }));
    fireEvent.change(screen.getByPlaceholderText('Amount'), { target: { value: '10' } });
    fireEvent.click(screen.getByRole('button', { name: /pull from shark club/i }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/Not Yet Confirmed/);

    fireEvent.click(screen.getByRole('button', { name: /pull from shark club/i }));
    await screen.findByRole('status');
    const ids = opIds('fn_union_clawback_from_club');
    expect(ids).toHaveLength(2);
    expect(ids[1]).toBe(ids[0]);
  });
});
