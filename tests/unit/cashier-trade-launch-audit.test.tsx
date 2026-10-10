/**
 * Club Arena Cashier launch audit (2026-10-09), Trade Cashier fixes.
 *
 * Source-only candidate: the mounted CashierTradePage against synthetic
 * Supabase replies. Each case pins one audit finding so the regression fails
 * before it can ship: P-03 stale Claim Back list, P-04 decimal keypad, P-10
 * exact confirmation figures, P-12 picker ARIA, P-15 Title Case, P-16 cents
 * sums, P-17 badge truth, P-18 one reload, P-20 comma amounts, P-24 wallet
 * cents, S-06 deterministic batch reason, L-03 document titles.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const CLUB_A = '11111111-1111-4111-8111-111111111111';
const CLUB_B = '22222222-2222-4222-8222-222222222222';
const USER_ID = '33333333-3333-4333-8333-333333333333';
const PLAYER_IDS = [
  '44444444-4444-4444-8444-444444444441',
  '44444444-4444-4444-8444-444444444442',
  '44444444-4444-4444-8444-444444444443',
  '44444444-4444-4444-8444-444444444444',
  '44444444-4444-4444-8444-444444444445',
];

type TableCall = {
  table: string;
  columns: string;
  head: boolean;
  filters: Array<[string, unknown]>;
  cap: number;
};

const state = vi.hoisted(() => ({
  agentWallet: 500,
  roster: [] as Array<Record<string, unknown>>,
  chipRequests: [] as Array<Record<string, unknown>>,
  pendingHead: 0,
  reversible: null as null | ((clubId: string) => Promise<unknown>),
  batch: null as null | ((args: Record<string, unknown>) => Promise<unknown>),
  rpcCalls: [] as Array<{ name: string; args: Record<string, unknown> }>,
  tableCalls: [] as TableCall[],
}));
const toastMocks = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));

vi.mock('../../src/hooks/useAuthUser', () => ({
  useAuthUser: () => ({ user: { id: USER_ID }, isHydrating: false }),
}));
vi.mock('../../src/components/common/Toast', () => ({ useToast: () => toastMocks }));
vi.mock('../../src/components/wallet/WalletCashierModal', () => ({ default: () => null }));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
/**
 * A live bus, not the setup file's inert one: P-18 is about the reload the
 * BALANCE_UPDATED event already performs, so the event has to reach the page.
 */
const bus = vi.hoisted(() => {
  const handlers = new Map<string, Set<(payload: unknown) => void>>();
  return {
    handlers,
    subscribe: (event: string, handler: (payload: unknown) => void) => {
      const set = handlers.get(event) ?? new Set();
      set.add(handler);
      handlers.set(event, set);
      return () => set.delete(handler);
    },
    emit: (event: string, payload: unknown) => {
      for (const handler of handlers.get(event) ?? []) handler(payload);
    },
  };
});
vi.mock('../../src/core/MasterBus', () => ({
  masterBus: {
    subscribe: vi.fn(bus.subscribe),
    subscribeDebounced: vi.fn(bus.subscribe),
    emit: vi.fn(bus.emit),
  },
  useMasterBusSubscription: vi.fn(),
}));
vi.mock('../../src/services/UnionService', () => ({
  UnionService: { getOwnedUnions: vi.fn(async () => []) },
}));
vi.mock('../../src/utils/clubIdResolver', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/utils/clubIdResolver')>()),
  resolveClubUUID: vi.fn(async (id: string) => id),
}));

import { supabase } from '../../src/lib/supabase';
import CashierTradePage from '../../src/pages/CashierTradePage';
import { exactChipFigure, parseTradeAmount, sumChips } from '../../src/utils/cashierAmount';
import { WalletPlate } from '../../src/pages/PlayerWalletPage';

const read = (path: string) => readFileSync(path, 'utf8');
const TRADE = read('src/pages/CashierTradePage.tsx');
const WALLET = read('src/pages/PlayerWalletPage.tsx');

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function player(index: number, chipBalance: number, name = `Player ${index + 1}`) {
  return {
    user_id: PLAYER_IDS[index],
    name,
    username: `player_${index + 1}`,
    avatar_url: null,
    role: 'player',
    role_rank: 0,
    chip_balance: chipBalance,
    is_horse: false,
    depth: 1,
    player_number: `P-${index + 1}`,
  };
}

function NavigateClub() {
  const navigate = useNavigate();
  return <button onClick={() => navigate(`/clubs/${CLUB_B}/cashier`)}>Switch Fixture Club</button>;
}

function mountCashier() {
  return render(
    <MemoryRouter initialEntries={[`/clubs/${CLUB_A}/cashier`]}>
      <Routes>
        <Route
          path="/clubs/:clubId/cashier"
          element={
            <>
              <CashierTradePage />
              <NavigateClub />
            </>
          }
        />
      </Routes>
    </MemoryRouter>
  );
}

async function synchronized() {
  await waitFor(() => expect(screen.getByText('Balances Synchronized')).toBeInTheDocument());
}

async function openSendOut(amount: string, picks: number) {
  for (let index = 0; index < picks; index += 1) {
    fireEvent.click(
      await screen.findByRole('checkbox', { name: new RegExp(`Player ${index + 1}`) })
    );
  }
  fireEvent.click(screen.getByRole('button', { name: 'Send Out' }));
  const dialog = await screen.findByRole('dialog', { name: /Send Out/ });
  fireEvent.change(screen.getByRole('spinbutton', { name: 'Amount Per Player' }), {
    target: { value: amount },
  });
  return dialog;
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  document.title = 'Poker Arena | Smarter Poker';
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
  state.agentWallet = 500;
  state.roster = [player(0, 75)];
  state.chipRequests = [];
  state.pendingHead = 0;
  state.reversible = null;
  state.batch = null;
  state.rpcCalls = [];
  state.tableCalls = [];

  vi.mocked(supabase.from).mockImplementation((table: string) => {
    const call: TableCall = { table, columns: '', head: false, filters: [], cap: Infinity };
    state.tableCalls.push(call);
    const builder: Record<string, unknown> = {};
    const chain = () => builder;
    for (const method of ['in', 'or', 'order', 'range', 'gte', 'lte'])
      builder[method] = vi.fn(chain);
    builder.select = vi.fn((columns: string, opts?: { head?: boolean }) => {
      call.columns = columns;
      call.head = Boolean(opts?.head);
      return builder;
    });
    builder.eq = vi.fn((key: string, value: unknown) => {
      call.filters.push([key, value]);
      return builder;
    });
    builder.limit = vi.fn((cap: number) => {
      call.cap = cap;
      return builder;
    });
    builder.maybeSingle = vi.fn(async () =>
      table === 'club_members'
        ? { data: { role: 'owner', chip_balance: 250 }, error: null }
        : table === 'agents'
          ? { data: { agent_wallet_balance: state.agentWallet }, error: null }
          : { data: null, error: null }
    );
    builder.then = (done: (value: unknown) => unknown, fail: (reason: unknown) => unknown) => {
      let value: unknown = { data: [], error: null, count: 0 };
      if (table === 'club_members' && call.columns.includes('clubs:club_id')) {
        value = {
          data: [CLUB_A, CLUB_B].map((clubId, index) => ({
            club_id: clubId,
            role: 'owner',
            chip_balance: 250,
            clubs: {
              name: index === 0 ? 'Alpha Club' : 'Bravo Club',
              club_id: 100 + index,
              slug: index === 0 ? 'alpha' : 'bravo',
              logo_url: null,
              is_union: false,
              owner_id: USER_ID,
            },
          })),
          error: null,
        };
      } else if (table === 'chip_requests' && call.head) {
        value = { data: null, error: null, count: state.pendingHead };
      } else if (table === 'chip_requests') {
        value = { data: state.chipRequests.slice(0, call.cap), error: null };
      } else if (table === 'profiles') {
        value = {
          data: PLAYER_IDS.map((id, index) => ({ id, display_name: `Player ${index + 1}` })),
          error: null,
        };
      }
      return Promise.resolve(value).then(done, fail);
    };
    return builder as never;
  });

  vi.mocked(supabase.rpc).mockImplementation((name: string, args?: unknown) => {
    const params = (args ?? {}) as Record<string, unknown>;
    state.rpcCalls.push({ name, args: params });
    if (name === 'fn_club_cashier_members_page_v3') {
      return Promise.resolve({ data: state.roster, error: null }) as never;
    }
    if (name === 'fn_agent_wallet_reversible' && state.reversible) {
      return state.reversible(params.p_club_id as string) as never;
    }
    if (name === 'fn_respond_chip_request') {
      return Promise.resolve({ data: { success: true }, error: null }) as never;
    }
    if (name === 'fn_cashier_batch_transfer') {
      if (state.batch) return state.batch(params) as never;
      const items = params.p_items as Array<{ user_id: string }>;
      return Promise.resolve({
        data: {
          success: true,
          results: items.map((item) => ({ user_id: item.user_id, success: true })),
        },
        error: null,
      }) as never;
    }
    return Promise.resolve({ data: [], error: null }) as never;
  });
});

describe('the deployed reconciliation witness belongs to the real cashier region', () => {
  it('resolves the maintained browser locator against the mounted Trade page', async () => {
    mountCashier();
    await synchronized();
    // Exercise the actual E2E locator against the real page, rather than
    // asserting that a string exists in two source files. The directory
    // layout moved this status out of the retired painted-console region.
    const spec = read('tests/e2e/routes/cashier-deep.spec.ts');
    const regionName = spec.match(/getByRole\('region', \{ name: '([^']+)' \}\)/)?.[1];
    expect(regionName).toBeTruthy();
    const region = screen.getByRole('region', { name: regionName });
    const status = within(region).getByRole('status');
    expect(status).toHaveTextContent(/^Balances Synchronized$/);
    expect(region).toContainElement(status);
    const reconciliation = screen.getByRole('region', { name: 'Reconciliation Console' });
    expect(within(reconciliation).queryByText('Not Yet Verified', { exact: true })).toBeNull();
  });
});

describe('P-03: the Claim Back list belongs to the club it was read from', () => {
  it("drops club A's late reply after switching to club B, rows and loading flag alike", async () => {
    const replies = new Map<string, ReturnType<typeof deferred<unknown>>>();
    state.reversible = (clubId) => {
      const gate = deferred<unknown>();
      replies.set(clubId, gate);
      return gate.promise;
    };
    mountCashier();
    await synchronized();

    fireEvent.click(screen.getByRole('button', { name: 'Claim Back' }));
    await screen.findByRole('dialog', { name: /Claim Back/ });
    await waitFor(() => expect(replies.has(CLUB_A)).toBe(true));

    fireEvent.click(screen.getByText('Switch Fixture Club'));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Current Club: Bravo Club/ })).toBeInTheDocument()
    );
    await synchronized();
    fireEvent.click(screen.getByRole('button', { name: 'Claim Back' }));
    const dialog = await screen.findByRole('dialog', { name: /Claim Back/ });
    await waitFor(() => expect(replies.has(CLUB_B)).toBe(true));
    expect(within(dialog).getByText('Reading Your Recent Sends...')).toBeInTheDocument();

    // A's reply lands first: it must neither paint A's send nor hide B's read.
    await act(async () => {
      replies.get(CLUB_A)!.resolve({
        data: [
          {
            transaction_id: 'a1',
            to_user_id: PLAYER_IDS[0],
            to_name: 'Alpha Recipient',
            amount: 100,
            claimed_back: 0,
            remaining: 100,
            destination: 'player_wallet',
            created_at: '2026-10-09T00:00:00Z',
            reversible_until: '2026-10-09T00:10:00Z',
            seconds_left: 500,
          },
        ],
        error: null,
      });
    });
    expect(screen.queryByText('Alpha Recipient')).not.toBeInTheDocument();
    expect(within(dialog).getByText('Reading Your Recent Sends...')).toBeInTheDocument();

    await act(async () => {
      replies.get(CLUB_B)!.resolve({
        data: [
          {
            transaction_id: 'b1',
            to_user_id: PLAYER_IDS[1],
            to_name: 'Bravo Recipient',
            amount: 40,
            claimed_back: 0,
            remaining: 40,
            destination: 'player_wallet',
            created_at: '2026-10-09T00:00:00Z',
            reversible_until: '2026-10-09T00:10:00Z',
            seconds_left: 500,
          },
        ],
        error: null,
      });
    });
    expect(await within(dialog).findByText('Bravo Recipient')).toBeInTheDocument();
    expect(screen.queryByText('Alpha Recipient')).not.toBeInTheDocument();
    expect(within(dialog).queryByText('Reading Your Recent Sends...')).not.toBeInTheDocument();
    expect(TRADE).toContain('++reversibleSeqRef.current;');
    expect(TRADE).toContain('if (!isMounted.current || seq !== reversibleSeqRef.current) return;');
  });
});

describe('P-10: the figure a user confirms is the figure that moves', () => {
  it('prints the exact two-decimal total and per-target amounts in the Send Out confirmation', async () => {
    state.roster = PLAYER_IDS.map((_, index) => player(index, 10));
    state.agentWallet = 20000;
    mountCashier();
    await synchronized();
    const dialog = await openSendOut('1999.99', 5);
    // The head zone keeps the console's compact reading; the confirmation
    // body prints the figure that moves.
    const total = within(dialog).getByText(/Total: 9,999\.95/);
    expect(total.textContent).not.toContain('9.9K');
    expect(within(dialog).getAllByText('1,999.99')).toHaveLength(5);
  });

  it('names the exact holding on an Insufficient Chips refusal', async () => {
    state.roster = PLAYER_IDS.map((_, index) => player(index, 10));
    state.agentWallet = 1234.5;
    mountCashier();
    await synchronized();
    await openSendOut('1999.99', 5);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() =>
      expect(toastMocks.error).toHaveBeenCalledWith(
        'Insufficient Chips: Sending 9,999.95 Needs More Than Your Agent Wallet Holds, 1,234.50'
      )
    );
    expect(
      vi.mocked(supabase.rpc).mock.calls.some(([name]) => name === 'fn_cashier_batch_transfer')
    ).toBe(false);
  });

  it('formats exact chip figures with grouped thousands and two places only when cents are held', () => {
    expect(exactChipFigure(9999.95)).toBe('9,999.95');
    expect(exactChipFigure(1234.5)).toBe('1,234.50');
    expect(exactChipFigure(1000000)).toBe('1,000,000');
    expect(exactChipFigure(0.1 + 0.2)).toBe('0.30');
    expect(exactChipFigure(-42.1)).toBe('-42.10');
    expect(exactChipFigure(Number.NaN)).toBe('0');
    expect(TRADE).toContain('{exactChipFigure(receipt.amount)}');
    // Head zones and list rows keep the console reading.
    expect(TRADE).toContain('const fmt = compactChips;');
  });
});

describe('P-20: a comma-grouped amount is understood, any other comma is named', () => {
  it('accepts conventional grouping and sends the plain number', async () => {
    state.agentWallet = 5000;
    mountCashier();
    await synchronized();
    await openSendOut('1,000', 1);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() =>
      expect(state.rpcCalls.some((call) => call.name === 'fn_cashier_batch_transfer')).toBe(true)
    );
    const batch = state.rpcCalls.find((call) => call.name === 'fn_cashier_batch_transfer')!;
    expect((batch.args.p_items as Array<{ amount: number }>)[0].amount).toBe(1000);
  });

  it("refuses a stray comma with the classic cashier's own words", async () => {
    mountCashier();
    await synchronized();
    await openSendOut('1,0', 1);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() =>
      expect(toastMocks.error).toHaveBeenCalledWith('Enter The Amount Without Commas')
    );
    expect(parseTradeAmount('1,234,567.89')).toEqual({ ok: true, value: 1234567.89 });
    expect(parseTradeAmount('12,34')).toEqual({
      ok: false,
      error: 'Enter The Amount Without Commas',
    });
    expect(parseTradeAmount('')).toEqual({ ok: false, error: 'Enter A Positive Amount' });
    expect(parseTradeAmount('-5')).toEqual({ ok: false, error: 'Enter A Positive Amount' });
  });
});

describe('G-06: the Trade route module exports only its page', () => {
  it('keeps the amount helpers in src/utils/cashierAmount.ts', () => {
    expect(TRADE.match(/^export (?!default)/gm) ?? []).toHaveLength(0);
    expect(TRADE).toContain(
      "import { exactChipFigure, parseTradeAmount, sumChips } from '../utils/cashierAmount';"
    );
    const helpers = read('src/utils/cashierAmount.ts');
    for (const name of ['exactChipFigure', 'sumChips', 'parseTradeAmount'])
      expect(helpers).toContain(`export function ${name}(`);
  });
});

describe('G-08: the Trade amount is read on its spelling, not by Number()', () => {
  const digits = { ok: false, error: 'Enter The Amount As Digits, With Up To Two Decimals' };

  it('refuses exponent, hex, signed and over-precise spellings', () => {
    expect(parseTradeAmount('1e3')).toEqual(digits);
    expect(parseTradeAmount('1E9')).toEqual(digits);
    expect(parseTradeAmount('0x10')).toEqual(digits);
    expect(parseTradeAmount('+5')).toEqual(digits);
    expect(parseTradeAmount('.5')).toEqual(digits);
    expect(parseTradeAmount('5.')).toEqual(digits);
    expect(parseTradeAmount('10.005')).toEqual(digits);
    expect(parseTradeAmount('1,000.123')).toEqual(digits);
  });

  it('still accepts plain and grouped amounts with up to two decimals', () => {
    expect(parseTradeAmount('1000')).toEqual({ ok: true, value: 1000 });
    expect(parseTradeAmount(' 12.5 ')).toEqual({ ok: true, value: 12.5 });
    expect(parseTradeAmount('0.07')).toEqual({ ok: true, value: 0.07 });
    expect(parseTradeAmount('1,000.50')).toEqual({ ok: true, value: 1000.5 });
  });

  it('a Send Out typed as 1e3 is refused and nothing moves', async () => {
    state.agentWallet = 5000;
    mountCashier();
    await synchronized();
    await openSendOut('1e3', 1);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() =>
      expect(toastMocks.error).toHaveBeenCalledWith(
        'Enter The Amount As Digits, With Up To Two Decimals'
      )
    );
    expect(state.rpcCalls.some((call) => call.name === 'fn_cashier_batch_transfer')).toBe(false);
  });
});

describe('S-06: the batch-send reason is the same on every retry', () => {
  it('sends a constant reason, never a display name or a UUID; op_id is the identity (G-07)', async () => {
    state.roster = [player(0, 10, 'Mutable Alias')];
    state.agentWallet = 5000;
    let attempt = 0;
    state.batch = (args) => {
      attempt += 1;
      const items = args.p_items as Array<{ user_id: string }>;
      return Promise.resolve({
        data: {
          success: true,
          results: items.map((item) => ({
            user_id: item.user_id,
            success: attempt > 1,
            error: attempt > 1 ? undefined : 'Outcome Not Yet Confirmed',
          })),
        },
        error: null,
      });
    };
    mountCashier();
    await synchronized();
    fireEvent.click(await screen.findByRole('checkbox', { name: /Mutable Alias/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Send Out' }));
    await screen.findByRole('dialog', { name: /Send Out/ });
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Amount Per Player' }), {
      target: { value: '10' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(attempt).toBe(1));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Confirm' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(attempt).toBe(2));

    const batches = state.rpcCalls.filter((call) => call.name === 'fn_cashier_batch_transfer');
    expect(batches).toHaveLength(2);
    const [first, second] = batches.map(
      (call) => (call.args.p_items as Array<{ reason: string; op_id: string }>)[0]
    );
    expect(first.reason).toBe('Cashier Send Out');
    expect(first.reason).not.toContain('Mutable Alias');
    expect(first.reason).not.toContain(String(batches[0].args.p_batch_id));
    expect(first.reason).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
    expect(second.reason).toBe(first.reason);
    expect(first.op_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
    expect(second.op_id).toBe(first.op_id);
    expect(batches[1].args.p_batch_id).toBe(batches[0].args.p_batch_id);
    expect(TRADE).toContain("const CASHIER_SEND_OUT_REASON = 'Cashier Send Out';");
    expect(TRADE).toContain('reason: CASHIER_SEND_OUT_REASON,');
  });
});

describe('P-16: money on the page is summed in cents', () => {
  it('sumChips never carries binary drift', () => {
    expect(sumChips([0.1, 0.2])).toBe(0.3);
    expect(sumChips([100.1, 200.2, -300.3])).toBe(0);
    expect(sumChips([Number.NaN, 5])).toBe(5);
    expect(TRADE).toContain('sumChips(recipients.map((r) => r.chipBalance))');
    expect(TRADE).toContain("sumChips(amountsIn('in'))");
    expect(TRADE).toContain('sumChips(picked.map((r) => r.chipBalance))');
    expect(TRADE).toContain('sumChips(downline.filter((r) => r.isMine).map((r) => r.chipBalance))');
    expect(TRADE).not.toMatch(/reduce\(\(sum, r\) => sum \+/);
  });

  it('computes the ledger net in cents so cancelling legs read +0, never -0', () => {
    expect(TRADE).toContain(
      'const net = (Math.round(incoming * 100) - Math.round(outgoing * 100)) / 100;'
    );
    const incoming = sumChips([100.1, 200.2]);
    const outgoing = sumChips([300.3]);
    const net = (Math.round(incoming * 100) - Math.round(outgoing * 100)) / 100;
    expect(net >= 0 ? '+' : '-').toBe('+');
    expect(Object.is(net, -0)).toBe(false);
  });
});

describe('P-17: the Chip Requests badge keeps the exact head count', () => {
  it('does not lower a head count of 140 to the 100-row page', async () => {
    state.pendingHead = 140;
    state.chipRequests = Array.from({ length: 100 }, (_, index) => ({
      id: `req-${index}`,
      requester_id: PLAYER_IDS[index % PLAYER_IDS.length],
      approver_id: USER_ID,
      amount: 10,
      note: null,
      status: 'pending',
      created_at: '2026-10-09T00:00:00Z',
    }));
    mountCashier();
    await synchronized();
    const tab = screen.getByRole('tab', { name: /Chip Requests/ });
    await waitFor(() => expect(tab).toHaveTextContent('140'));
    fireEvent.click(tab);
    await waitFor(() => expect(screen.getAllByText('Approve')).toHaveLength(100));
    expect(tab).toHaveTextContent('140');
    expect(screen.getAllByText('140 Waiting').length).toBeGreaterThan(0);
    expect(screen.queryByText('100 Waiting')).not.toBeInTheDocument();
  });

  it('a short page is the whole queue and corrects the badge', async () => {
    state.pendingHead = 3;
    state.chipRequests = [
      {
        id: 'req-1',
        requester_id: PLAYER_IDS[0],
        approver_id: USER_ID,
        amount: 10,
        note: null,
        status: 'pending',
        created_at: '2026-10-09T00:00:00Z',
      },
    ];
    mountCashier();
    await synchronized();
    const tab = screen.getByRole('tab', { name: /Chip Requests/ });
    await waitFor(() => expect(tab).toHaveTextContent('3'));
    fireEvent.click(tab);
    await waitFor(() => expect(screen.getAllByText('Approve')).toHaveLength(1));
    await waitFor(() => expect(tab).toHaveTextContent('1'));
  });
});

describe('P-18: answering a chip request reloads the club once', () => {
  it('runs one roster read after Approve, driven by the bus event alone', async () => {
    state.chipRequests = [
      {
        id: 'req-1',
        requester_id: PLAYER_IDS[0],
        approver_id: USER_ID,
        amount: 10,
        note: null,
        status: 'pending',
        created_at: '2026-10-09T00:00:00Z',
      },
    ];
    state.pendingHead = 1;
    mountCashier();
    await synchronized();
    fireEvent.click(screen.getByRole('tab', { name: /Chip Requests/ }));
    const approve = await screen.findByRole('button', { name: 'Approve' });
    const rosterReads = () =>
      state.rpcCalls.filter((call) => call.name === 'fn_club_cashier_members_page_v3').length;
    const before = rosterReads();
    fireEvent.click(approve);
    await waitFor(() => expect(toastMocks.success).toHaveBeenCalledWith('Request Approved'));
    await waitFor(() => expect(rosterReads()).toBe(before + 1));
    await act(async () => {
      await new Promise((done) => setTimeout(done, 50));
    });
    expect(rosterReads()).toBe(before + 1);

    const respond = TRADE.slice(
      TRADE.indexOf('const respondToRequest ='),
      TRADE.indexOf('const askForChips =')
    );
    // A call statement, not the comment that explains its absence.
    expect(respond).not.toMatch(/^\s*loadClub\(\);/m);
    const modal = TRADE.slice(
      TRADE.indexOf('<WalletCashierModal'),
      TRADE.indexOf('{/* Amount modal */}')
    );
    expect(modal).not.toMatch(/^\s*loadClub\(\);/m);
  });
});

describe('P-04, P-12, P-15, L-03: the Trade page is reachable and truthful', () => {
  it('offers the decimal keypad on every two-decimal amount input', async () => {
    mountCashier();
    await synchronized();
    await openSendOut('1', 1);
    const amount = screen.getByRole('spinbutton', { name: 'Amount Per Player' });
    expect(amount).toHaveAttribute('inputmode', 'decimal');
    expect(amount).toHaveAttribute('step', '0.01');
    for (const tag of TRADE.match(/<input[^>]*type="number"[^>]*>/gs) ?? []) {
      expect(tag).toContain('inputMode="decimal"');
      expect(tag).toContain('step="0.01"');
    }
  });

  it("points the switcher's aria-controls at the listbox and prints its label in Title Case", async () => {
    mountCashier();
    await synchronized();
    const trigger = screen.getByRole('button', { name: /Open Another Club Cashier/ });
    expect(trigger).toHaveAttribute('aria-haspopup', 'listbox');
    fireEvent.click(trigger);
    const listbox = await screen.findByRole('listbox', { name: 'Club Cashiers' });
    expect(listbox.id).toBe(trigger.getAttribute('aria-controls'));
    expect(screen.getByText('Open Cashier For')).toBeInTheDocument();
    expect(TRADE).not.toContain('OPEN CASHIER FOR');
  });

  it('names the document', async () => {
    mountCashier();
    await synchronized();
    expect(document.title).toBe('Cashier | Smarter Poker');
    expect(read('src/pages/CashierStatementsPage.tsx')).toContain(
      "document.title = 'Cashier Statement | Smarter Poker';"
    );
  });
});

describe('P-11, P-15, P-24: the player wallet', () => {
  it('keeps both cent digits on a chip plate and prints whole chips whole', () => {
    render(
      <WalletPlate type="PLAYER" available={12.3} locked={0} total={12.3} totalOfAll={12.3} />
    );
    expect(
      screen.getByLabelText('Player Wallet: 12.30 Available, 0 Locked, 12.30 Total')
    ).toBeInTheDocument();
    expect(screen.getAllByText('12.30').length).toBeGreaterThan(0);
    expect(WALLET).toContain('maximumFractionDigits: 2');
  });

  it('claims only the ledger state it actually read, in Title Case', () => {
    expect(WALLET).not.toContain('WALLET LEDGER // SYNCHRONIZED');
    expect(WALLET).toContain("synced: { status: 'Wallet Ledger // Synced', ink: 'green' }");
    expect(WALLET).toContain(
      "unavailable: { status: 'Wallet Ledger // Unavailable', ink: 'gold' }"
    );
    expect(WALLET).toContain("offline: { status: 'Wallet Ledger // Offline', ink: 'red' }");
    expect(WALLET).toContain('status={LEDGER_STATUS[ledgerState].status}');
    expect(WALLET).toContain(
      "const ledgerState: LedgerReadState | 'offline' = isOnline ? ledgerRead : 'offline';"
    );
    // Every read the page starts is the wrapped one, so its outcome is seen.
    expect(WALLET).toContain('loadBalances: storeLoadBalances,');
    expect(WALLET).toContain('await storeLoadBalances(userId, opts);');
    expect(WALLET.match(/\bstoreLoadBalances\(/g)).toHaveLength(1);
    expect(WALLET).toContain(
      "setLedgerRead(held && (advanced || servedFromCache) ? 'synced' : 'unavailable');"
    );
  });

  it('gives every wallet word control the 44px thumb target', () => {
    const css = read('src/pages/PlayerWalletPage.css');
    expect(css).toMatch(/\.vault-btn\.small \{[^}]*min-height: 44px/);
    expect(css).toMatch(/\.wallet-plate__cta \{[^}]*min-height: 44px/);
    expect(css).not.toMatch(/\.vault-btn\.small \{[^}]*min-height: 34px/);
    expect(css).not.toMatch(/\.wallet-plate__cta \{[^}]*min-height: 40px/);
  });
});
