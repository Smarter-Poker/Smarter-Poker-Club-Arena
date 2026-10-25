import { recoveryCanonical } from '../../src/services/CashierDurableRecovery';
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
const TOURNEY_ID = '99999999-9999-4999-8999-999999999999';
const PLAYER_IDS = [
  '44444444-4444-4444-8444-444444444441',
  '44444444-4444-4444-8444-444444444442',
  '44444444-4444-4444-8444-444444444443',
  '44444444-4444-4444-8444-444444444444',
  '44444444-4444-4444-8444-444444444445',
];

// Model the durable server journal, including exact intent and compare-and-ack.
const durableRows = new Map<string, Record<string, any>>();
function recoveryReply(name: string, args: Record<string, any>) {
  if (!name.startsWith('fn_cashier_browser_recovery_')) return undefined;
  const scope = `${args.p_actor_id}:${args.p_club_id}:${args.p_kind}:`;
  const key = scope + args.p_intent_key;
  const row = durableRows.get(key);
  const identity = (value: Record<string, any>) => value.operationId ?? value.submissionId;
  const intent = (value: Record<string, any>, identifiers = false) => {
    const {
      failures: _failures,
      createdAt: _created,
      operationId,
      submissionId,
      opIds,
      ...rest
    } = value;
    return recoveryCanonical(identifiers ? { ...rest, operationId, submissionId, opIds } : rest);
  };
  let data: unknown;
  switch (name.split('_').at(-1)) {
    case 'read':
      data = [...durableRows]
        .filter(([key]) => key.startsWith(scope))
        .map(([, value]) => structuredClone(value));
      break;
    case 'reserve':
      if (row && intent(row) !== intent(args.p_envelope))
        throw new Error('Recovery Intent Mismatch');
      if (!row) durableRows.set(key, structuredClone(args.p_envelope));
      data = structuredClone(durableRows.get(key));
      break;
    case 'update':
      data =
        !!row &&
        identity(row) === args.p_identity &&
        intent(row, true) === intent(args.p_envelope, true) &&
        args.p_envelope.failures.every((failure: any) =>
          row.failures.some((original: any) => original.userId === failure.userId)
        );
      if (data) durableRows.set(key, structuredClone(args.p_envelope));
      break;
    case 'ack':
      data = !!row && identity(row) === args.p_identity;
      if (data) durableRows.delete(key);
      break;
    default:
      throw new Error('Unexpected Recovery RPC');
  }
  return Promise.resolve({ data, error: null });
}

type TableCall = {
  table: string;
  columns: string;
  head: boolean;
  filters: Array<[string, unknown]>;
  cap: number;
};

const state = vi.hoisted(() => ({
  resolveClub: null as null | ((id: string) => Promise<string>),
  frozen: false,
  agentWallet: 500,
  myRole: 'owner',
  myBalance: 250,
  roster: [] as Array<Record<string, unknown>>,
  chipRequests: [] as Array<Record<string, unknown>>,
  recentMoves: [] as Array<Record<string, unknown>>,
  pendingHead: 0,
  reversible: null as null | ((clubId: string) => Promise<unknown>),
  batch: null as null | ((args: Record<string, unknown>) => Promise<unknown>),
  rpcCalls: [] as Array<{ name: string; args: Record<string, unknown> }>,
  tableCalls: [] as TableCall[],
}));
const toastMocks = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));

vi.mock('../../src/hooks/useMasterBusChannel', () => ({ useMasterBusChannel: vi.fn() }));
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
vi.mock('../../src/services/cashierBalanceRead', async (original) => ({
  ...(await original<typeof import('../../src/services/cashierBalanceRead')>()),
  readCashierBalances: vi.fn(async () => ({
    bank: state.agentWallet,
    clubBank: 1000,
    promoFloat: 300,
    promoPot: 400,
    credit: 0,
    hasFloat: true,
    clubId: CLUB_A,
    name: 'Alpha Club',
    inUnion: false,
  })),
}));
vi.mock('../../src/services/UnionService', () => ({
  UnionService: { getOwnedUnions: vi.fn(async () => []) },
}));
vi.mock('../../src/utils/clubIdResolver', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/utils/clubIdResolver')>()),
  resolveClubUUID: vi.fn(async (id: string) => (state.resolveClub ? state.resolveClub(id) : id)),
}));

import { supabase } from '../../src/lib/supabase';
import { useMasterBusChannel } from '../../src/hooks/useMasterBusChannel';
import {
  restoreDurableCashierTransfers,
  writeCashierTransferRecovery,
  readCashierTransferRecovery,
  readCashierTransferRecoveries,
} from '../../src/services/CashierResilience';
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
  return (
    <>
      <button onClick={() => navigate(`/clubs/${CLUB_B}/cashier`)}>Switch Fixture Club</button>
      <button onClick={() => navigate('/clubs/resolving-club/cashier')}>
        Switch Unresolved Club
      </button>
    </>
  );
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
  const advanced = screen.queryByRole('button', { name: /^Advanced(?: \([\d,]+\))?$/ });
  if (advanced) fireEvent.click(advanced);
  await waitFor(() => expect(screen.getByText('Balances Synchronized')).toBeInTheDocument());
}

/** Send Ticket is bought into one tournament (Dan 2026-10-15). */
async function chooseTournament(dialog: HTMLElement) {
  await within(dialog).findByRole('option', { name: /Test Event/ });
  fireEvent.change(within(dialog).getByRole('combobox', { name: 'Tournament' }), {
    target: { value: TOURNEY_ID },
  });
}

async function openSendOut(amount: string, picks: number) {
  for (let index = 0; index < picks; index += 1) {
    fireEvent.click(
      await screen.findByRole('checkbox', { name: new RegExp(`Player ${index + 1}`) })
    );
  }
  fireEvent.click(screen.getByRole('button', { name: 'Send Out' }));
  const dialog = await screen.findByRole('dialog', { name: /Send Out/ });
  fireEvent.change(screen.getByRole('textbox', { name: 'Amount' }), {
    target: { value: amount },
  });
  return dialog;
}

beforeEach(async () => {
  durableRows.clear();
  state.frozen = false;
  vi.clearAllMocks();
  localStorage.clear();
  document.title = 'Poker Arena | Smarter Poker';
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
  state.resolveClub = null;
  state.agentWallet = 500;
  state.myRole = 'owner';
  state.myBalance = 250;
  state.roster = [player(0, 75)];
  state.chipRequests = [];
  state.recentMoves = [];
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
        ? { data: { role: state.myRole, chip_balance: state.myBalance }, error: null }
        : table === 'agents'
          ? {
              data: { agent_wallet_balance: state.agentWallet, promo_wallet_balance: 300 },
              error: null,
            }
          : { data: null, error: null }
    );
    builder.then = (done: (value: unknown) => unknown, fail: (reason: unknown) => unknown) => {
      let value: unknown = { data: [], error: null, count: 0 };
      if (table === 'club_members' && call.columns.includes('clubs:club_id')) {
        value = {
          data: [CLUB_A, CLUB_B].map((clubId, index) => ({
            club_id: clubId,
            role: 'owner',
            chip_balance: state.myBalance,
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
      } else if (table === 'club_members' && call.columns === 'user_id, chip_balance') {
        value = { data: state.roster, error: null };
      } else if (table === 'agents' && call.columns.includes('user_id,')) {
        value = {
          data: state.roster
            .filter((row) => row.role !== 'player')
            .map((row) => ({
              user_id: row.user_id,
              agent_wallet_balance: 340,
              promo_wallet_balance: 80,
            })),
          error: null,
        };
      } else if (table === 'chip_requests' && call.head) {
        value = { data: null, error: null, count: state.pendingHead };
      } else if (table === 'chip_requests') {
        value = { data: state.chipRequests.slice(0, call.cap), error: null };
      } else if (table === 'chip_transactions') {
        value = { data: state.recentMoves, error: null };
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
    const recovery = recoveryReply(name, params);
    if (recovery) return recovery as never;
    if (name === 'fn_platform_frozen') return Promise.resolve({ data: state.frozen, error: null });
    if (name === 'fn_cashier_recipient_wallet_balances')
      return Promise.resolve({
        data: state.roster.map((row) => ({
          user_id: row.user_id,
          player_wallet: row.chip_balance,
          agent_wallet: row.role !== 'player' ? 340 : null,
          promo_wallet: row.role !== 'player' ? 80 : null,
        })),
        error: null,
      }) as never;
    if (name === 'fn_cashier_conservation_report') {
      return Promise.resolve({
        data: {
          schema_version: 1,
          club_id: params.p_club_id,
          scope: 'bank_and_player_baselines',
          as_of: '2026-10-11T12:00:00Z',
          bank: {
            status: 'verified',
            actual: '500',
            expected: '500',
            drift: '0',
            baseline_at: '2026-01-01T00:00:00Z',
          },
          players: {
            status: 'incomplete',
            positions: 2,
            checked: 1,
            missing: 1,
            mismatches: 0,
            actual: '75',
            expected: '75',
            net_drift: '0',
            absolute_drift: '0',
          },
          inventory: {
            agent_wallets: '500',
            promo_wallets: '0',
            held_chips: '0',
            cash_stacks: '0',
          },
        },
        error: null,
      }) as never;
    }
    if (name === 'fn_club_cashier_members_page_v3') {
      const after = params.p_after_user_id
        ? state.roster.findIndex((row) => row.user_id === params.p_after_user_id) + 1
        : 0;
      return Promise.resolve({
        data: state.roster.slice(after, after + Number(params.p_limit)),
        error: null,
      }) as never;
    }
    if (name === 'fn_agent_wallet_reversible' && state.reversible) {
      return state.reversible(params.p_club_id as string) as never;
    }
    if (name === 'fn_cashier_ticketable_tournaments') {
      return Promise.resolve({
        data: {
          success: true,
          club_id: params.p_club_id,
          count: 1,
          tournaments: [
            {
              tournament_id: TOURNEY_ID,
              name: 'Test Event',
              start_time: '2026-12-01T00:00:00Z',
              status: 'REGISTERING',
              late_registration: false,
              price: 10,
              entry_prize: 9,
              entry_bounty: 0,
              entry_fee: 1,
              is_union_event: false,
              current_players: 0,
              max_players: 100,
            },
          ],
        },
        error: null,
      }) as never;
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
  await restoreDurableCashierTransfers(USER_ID, CLUB_A);
  await restoreDurableCashierTransfers(USER_ID, CLUB_B);
});

describe('large cashier roster stays complete and progressively rendered', () => {
  it('keeps every exact recipient and receipt across the 25-item server boundary', async () => {
    state.roster = Array.from({ length: 26 }, (_, index) => ({
      ...player(0, 100 - index, `Batch Player ${index}`),
      user_id: `44444444-4444-4444-8444-${String(index).padStart(12, '0')}`,
    }));
    mountCashier();
    await synchronized();
    fireEvent.click(screen.getByRole('button', { name: 'Load More (1 Hidden)' }));
    for (const checkbox of screen.getAllByRole('checkbox', { name: /^Include / }))
      fireEvent.click(checkbox);
    fireEvent.click(screen.getByRole('button', { name: 'Send Out' }));
    const dialog = await screen.findByRole('dialog', { name: 'Send Out' });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Amount' }), {
      target: { value: '0.20' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Send Out' })).toBeNull());
    const calls = state.rpcCalls.filter((call) => call.name === 'fn_cashier_batch_transfer');
    expect(calls).toHaveLength(2);
    expect(calls[0].args.p_items as unknown[]).toHaveLength(25);
    expect(calls[1].args.p_items as unknown[]).toHaveLength(1);
    expect(calls[1].args.p_batch_id).toBe(calls[0].args.p_batch_id);
    const items = calls.flatMap(
      (call) => call.args.p_items as Array<{ user_id: string; amount: number; op_id: string }>
    );
    expect(items.map((item) => item.user_id)).toEqual(state.roster.map((row) => row.user_id));
    expect(items.every((item) => item.amount === 0.2)).toBe(true);
    expect(new Set(items.map((item) => item.op_id)).size).toBe(26);
    expect(screen.getByText('Confirmed Total: 5.20 Chips')).toBeInTheDocument();
    expect(screen.getAllByText('Confirmed', { exact: true })).toHaveLength(26);
  });

  it('finds the last member across four server pages while initially mounting only 25 rows', async () => {
    state.roster = Array.from({ length: 2000 }, (_, index) => ({
      ...player(0, 2000 - index, `Roster Player ${index}`),
      user_id: `44444444-4444-4444-8444-${String(index).padStart(12, '0')}`,
      player_number: `940${index}`,
      username: `roster_member_${index}`,
    }));
    mountCashier();
    await synchronized();
    await screen.findByRole('searchbox', { name: 'Search 2000 Members' });
    expect(screen.getAllByRole('checkbox', { name: /^Include / })).toHaveLength(25);
    expect(screen.getByRole('button', { name: 'Load More (1975 Hidden)' })).toBeEnabled();
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: '9401999' } });
    const member = await screen.findByRole('link', { name: 'Manage Roster Player 1999' });
    expect(member).toHaveAttribute(
      'href',
      `/clubs/${CLUB_A}/members/44444444-4444-4444-8444-000000001999`
    );
    expect(screen.getAllByRole('checkbox', { name: /^Include / })).toHaveLength(1);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Include Roster Player 1999' }));
    fireEvent.click(screen.getByRole('button', { name: 'Send Out', exact: true }));
    const dialog = await screen.findByRole('dialog', { name: 'Send Out' });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Amount' }), {
      target: { value: '0.20' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm' }));
    await waitFor(() =>
      expect(
        state.rpcCalls.filter((call) => call.name === 'fn_cashier_batch_transfer')
      ).toHaveLength(1)
    );
    expect(
      state.rpcCalls.find((call) => call.name === 'fn_cashier_batch_transfer')?.args.p_items
    ).toEqual([
      expect.objectContaining({
        user_id: state.roster[1999].user_id,
        amount: 0.2,
        destination: 'player_wallet',
      }),
    ]);
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
    expect(within(reconciliation).queryByText('Not Yet Refreshed', { exact: true })).toBeNull();
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
    expect(within(dialog).getAllByRole('textbox', { name: /^Amount For/ })).toHaveLength(5);
    for (const field of within(dialog).getAllByRole('textbox', { name: /^Amount For/ }))
      expect(field).toHaveValue('1,999.99');
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

  it('counts the recipients in the verdict the wallet funding each action owes', async () => {
    // Send Out spends the agent wallet; Send Ticket spends the caller's own
    // chips (250 in this fixture). The production canary's identity holds
    // neither, so the deterministic proof of both verdicts lives here.
    state.roster = [player(0, 75), player(1, 50)];
    state.agentWallet = 0;
    mountCashier();
    await synchronized();
    const dialog = await openSendOut('10', 2);
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Amount For Player 2' }), {
      target: { value: '0.20' },
    });
    expect(within(dialog).getByText(/Total: 10\.20/)).toBeInTheDocument();
    expect(within(dialog).getByText('Insufficient Chips In The Funding Wallet')).toHaveAttribute(
      'role',
      'status'
    );
    expect(within(dialog).queryByText(/Recipients Ready For Server Verification/)).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send Ticket' }));
    const ticket = await screen.findByRole('dialog', { name: /Send Ticket/ });
    // A ticket's value is the tournament's price, the same for everyone.
    expect(
      within(ticket).getByText('Choose A Tournament', { selector: '[role="status"]' })
    ).toBeInTheDocument();
    await chooseTournament(ticket);
    expect(within(ticket).getByText(/Total: 20/)).toBeInTheDocument();
    expect(within(ticket).getByRole('button', { name: 'Confirm' })).toBeEnabled();
  });

  it('reads a covered Send Out batch as ready for server verification', async () => {
    state.roster = [player(0, 75), player(1, 50)];
    state.agentWallet = 20000;
    mountCashier();
    await synchronized();
    const dialog = await openSendOut('10', 2);
    expect(within(dialog).getByRole('button', { name: 'Confirm' })).toBeEnabled();
    expect(within(dialog).queryByText('Insufficient Chips In The Funding Wallet')).toBeNull();
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

  it('normalizes edited grouping while the submitted parser still refuses malformed spelling', async () => {
    mountCashier();
    await synchronized();
    await openSendOut('1,0', 1);
    expect(screen.getByRole('textbox', { name: 'Amount', exact: true })).toHaveValue('10');
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() =>
      expect(state.rpcCalls.some((call) => call.name === 'fn_cashier_batch_transfer')).toBe(true)
    );
    const batch = state.rpcCalls.find((call) => call.name === 'fn_cashier_batch_transfer')!;
    expect((batch.args.p_items as Array<{ amount: number }>)[0].amount).toBe(10);
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
    expect(TRADE).toMatch(
      /import \{[^}]*exactChipFigure[^}]*parseTradeAmount[^}]*sumChips[^}]*\} from '\.\.\/utils\/cashierAmount'/
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
    fireEvent.change(screen.getByRole('textbox', { name: 'Amount' }), {
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
    expect(TRADE).toContain('sumChips(picked.map((r) => r.chipBalance))');
    expect(TRADE).toContain('sumChips(downline.filter((r) => r.isMine).map((r) => r.chipBalance))');
    expect(TRADE).not.toMatch(/reduce\(\(sum, r\) => sum \+/);
  });

  // The Transaction History's In / Out / Net now come from the server over the
  // whole filtered book (fn_cashier_history_summary sums in numeric, exact to
  // the cent), not from the rows on screen (Dan 2026-10-24, "true totals").
  it('computes the ledger net in cents so cancelling legs read +0, never -0', () => {
    expect(TRADE).toContain("supabase.rpc('fn_cashier_history_summary'");
    expect(TRADE).not.toContain("sumChips(amountsIn('in'))");
    expect(TRADE).toContain("wallet.net >= 0 ? '+' : '-'");
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

describe('Cashier never reloads its working roster on background balance events', () => {
  it('keeps the working roster after Approve and unrelated balance events', async () => {
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
    await waitFor(() => expect(rosterReads()).toBe(before));
    await act(async () => {
      await new Promise((done) => setTimeout(done, 50));
    });
    expect(rosterReads()).toBe(before);

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
    const amount = screen.getByRole('textbox', { name: 'Amount' });
    expect(amount).toHaveAttribute('inputmode', 'decimal');
    expect(amount).toHaveAttribute('type', 'text');
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
    // The Cashier dock's own line prints it (Dan 2026-10-16, the wallet desk).
    expect(WALLET).toContain("{LEDGER_STATUS[ledgerState].status.replace(' // ', ' ')}");
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

it('removes the previous club recipients and transfer dialog while the next slug resolves', async () => {
  const resolution = deferred<string>();
  mountCashier();
  await synchronized();
  await openSendOut('25', 1);
  state.resolveClub = (id) => (id === 'resolving-club' ? resolution.promise : Promise.resolve(id));
  fireEvent.click(screen.getByRole('button', { name: 'Switch Unresolved Club' }));
  await waitFor(() =>
    expect(screen.queryByRole('dialog', { name: /Send Out/ })).not.toBeInTheDocument()
  );
  expect(screen.queryByRole('checkbox', { name: /Player 1/ })).not.toBeInTheDocument();
  expect(state.rpcCalls.some((call) => call.name === 'fn_cashier_batch_transfer')).toBe(false);
  await act(async () => resolution.resolve(CLUB_B));
  await synchronized();
});

it('keeps a late uncertain transfer in its original club instead of poisoning the next cashier', async () => {
  const batch = deferred<unknown>();
  state.batch = () => batch.promise;
  mountCashier();
  await synchronized();
  await openSendOut('25', 1);
  fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
  await waitFor(() =>
    expect(state.rpcCalls.some((call) => call.name === 'fn_cashier_batch_transfer')).toBe(true)
  );
  fireEvent.click(screen.getByRole('button', { name: 'Switch Fixture Club' }));
  await synchronized();
  await act(async () => batch.resolve({ data: null, error: { message: 'Connection Lost' } }));
  expect(screen.queryByText(/Nothing Was Sent/)).not.toBeInTheDocument();
  expect(screen.getByRole('checkbox', { name: 'Include Player 1' })).toBeEnabled();
  fireEvent.click(screen.getByRole('checkbox', { name: 'Include Player 1' }));
  fireEvent.click(screen.getByRole('button', { name: 'Send Out', exact: true }));
  expect(await screen.findByRole('dialog', { name: /Send Out/ })).toBeInTheDocument();
});

it('restores the original server envelope after a quota-blocked uncertain send and retries its original keys', async () => {
  const storage = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
    throw new DOMException('Quota Exceeded', 'QuotaExceededError');
  });
  try {
    const priorRpc = vi.mocked(supabase.rpc).getMockImplementation()!;
    vi.mocked(supabase.rpc).mockImplementation((name, args) =>
      name === 'fn_cashier_recovery_receipts'
        ? (Promise.resolve({ data: { operations: [], tickets: [] }, error: null }) as never)
        : priorRpc(name, args)
    );
    state.batch = async () => ({ data: null, error: { message: 'Connection Lost' } });
    const first = mountCashier();
    await synchronized();
    const dialog = await openSendOut('25', 1);
    const confirm = within(dialog).getByRole('button', { name: 'Confirm' });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    await waitFor(() =>
      expect(
        state.rpcCalls.filter((call) => call.name === 'fn_cashier_batch_transfer')
      ).toHaveLength(1)
    );
    await screen.findByText('Transfer Recovery Required');
    const original = state.rpcCalls.find((call) => call.name === 'fn_cashier_batch_transfer')!.args;
    expect(durableRows.size).toBe(1);
    expect(localStorage.length).toBe(0);
    first.unmount();
    mountCashier();
    await synchronized();
    fireEvent.click(await screen.findByRole('button', { name: 'Review And Retry' }));
    const retry = await screen.findByRole('dialog', { name: /Send Out/ });
    fireEvent.click(within(retry).getByRole('button', { name: 'Confirm' }));
    await waitFor(() =>
      expect(
        state.rpcCalls.filter((call) => call.name === 'fn_cashier_batch_transfer')
      ).toHaveLength(2)
    );
    const repeated = state.rpcCalls.filter((call) => call.name === 'fn_cashier_batch_transfer')[1]
      .args;
    expect(repeated.p_batch_id).toBe(original.p_batch_id);
    expect(repeated.p_items).toEqual(original.p_items);
    expect(durableRows.size).toBe(1);
  } finally {
    storage.mockRestore();
  }
});

it('Phase 2: editing an uncertain transfer preserves its original journal and honest outcome', async () => {
  state.batch = async () => ({ data: null, error: { message: 'Connection Lost' } });
  mountCashier();
  await synchronized();
  const dialog = await openSendOut('10', 1);
  fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm' }));
  await waitFor(() => expect(screen.getByText('Transfer Recovery Required')).toBeInTheDocument());
  const journalKeys = Array.from(
    { length: localStorage.length },
    (_, i) => localStorage.key(i)!
  ).filter((key) => key.includes('cashier-transfer-recovery'));
  expect(journalKeys).toHaveLength(1);
  const original = localStorage.getItem(journalKeys[0]);
  expect(toastMocks.error.mock.calls.flat().join(' ')).not.toContain('Nothing Was Sent');
  fireEvent.change(screen.getByRole('textbox', { name: 'Amount' }), {
    target: { value: '11' },
  });
  await waitFor(() => expect(localStorage.getItem(journalKeys[0])).toBe(original));
  expect(screen.getByText('Transfer Recovery Required')).toBeInTheDocument();
});

it('Phase 2: withdrawing operator role refreshes an open cashier and prevents a fresh batch', async () => {
  mountCashier();
  await synchronized();
  await openSendOut('10', 1);
  await act(async () =>
    bus.emit('MEMBER_ROLE_CHANGED', { clubId: CLUB_A, userId: USER_ID, newRole: 'player' })
  );
  await waitFor(() =>
    expect(screen.queryByRole('checkbox', { name: /Player 1/ })).not.toBeInTheDocument()
  );
  expect(state.rpcCalls.some((call) => call.name === 'fn_cashier_batch_transfer')).toBe(false);
});

it('Phase 2: a balance-only realtime update leaves the open transfer authorized', async () => {
  mountCashier();
  await synchronized();
  const dialog = await openSendOut('10', 1);
  const hook = vi
    .mocked(useMasterBusChannel)
    .mock.calls.map(([options]) => options)
    .findLast((options) => options.channelName?.startsWith('cashier-member-authority:'))!;
  await act(async () =>
    hook.onPayload?.({
      eventType: 'UPDATE',
      new: {
        club_id: CLUB_A,
        role: 'owner',
        status: 'active',
        chip_balance: 490,
      },
      old: {},
    } as never)
  );
  expect(within(dialog).getByRole('button', { name: 'Confirm' })).toBeEnabled();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm' }));
  await waitFor(() =>
    expect(state.rpcCalls.filter((call) => call.name === 'fn_cashier_batch_transfer')).toHaveLength(
      1
    )
  );
});

it('Phase 2: a partial recovery skips an already committed removed recipient and preserves the remaining original key and destination', async () => {
  const firstId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
  const secondId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';
  const submissionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  expect(
    writeCashierTransferRecovery({
      version: 1,
      userId: USER_ID,
      clubId: CLUB_A,
      kind: 'send',
      amount: 10,
      targetIds: PLAYER_IDS.slice(0, 2),
      failures: PLAYER_IDS.slice(0, 2).map((userId) => ({
        userId,
        name: 'Original Recipient',
        message: 'Unknown',
      })),
      submissionId,
      opIds: { [PLAYER_IDS[0]]: firstId, [PLAYER_IDS[1]]: secondId },
      destinations: { [PLAYER_IDS[0]]: 'player_wallet', [PLAYER_IDS[1]]: 'agent_wallet' },
      ticketNote: 'Cashier Ticket',
      createdAt: Date.now(),
    })
  ).toBe(true);
  state.roster = [player(1, 100)]; // Today the remaining player has a different role.
  mountCashier();
  await synchronized();
  const priorRpc = vi.mocked(supabase.rpc).getMockImplementation()!;
  vi.mocked(supabase.rpc).mockImplementation((name, args) =>
    name === 'fn_cashier_recovery_receipts'
      ? (Promise.resolve({
          data: {
            operations: [{ operation_id: firstId, receipt: { success: true } }],
            tickets: [],
          },
          error: null,
        }) as never)
      : priorRpc(name, args)
  );
  fireEvent.click(screen.getByRole('button', { name: 'Review And Retry' }));
  const dialog = await screen.findByRole('dialog', { name: /Send Out/ });
  expect(readCashierTransferRecovery(USER_ID, CLUB_A)?.targetIds).toEqual(PLAYER_IDS.slice(0, 2));
  // The simplified dialog names only where the chips come from; the original
  // destination is proved below on the replayed item itself.
  expect(
    within(dialog).getByRole('region', { name: 'From Your Agent Wallet' })
  ).toBeInTheDocument();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm' }));
  await waitFor(() =>
    expect(state.rpcCalls.filter((call) => call.name === 'fn_cashier_batch_transfer')).toHaveLength(
      1
    )
  );
  expect(
    state.rpcCalls.find((call) => call.name === 'fn_cashier_batch_transfer')?.args.p_items
  ).toEqual([
    expect.objectContaining({
      user_id: PLAYER_IDS[1],
      amount: 10,
      destination: 'agent_wallet',
      op_id: secondId,
    }),
  ]);
});

it('wires the real Trade reconcile action through refreshed authority into the validated accounting RPC', async () => {
  mountCashier();
  await synchronized();
  expect(state.rpcCalls.some((call) => call.name === 'fn_cashier_conservation_report')).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Reconcile Now' }));
  const report = await screen.findByRole('region', { name: 'Accounting Report' });
  expect(within(report).getByRole('status')).toHaveTextContent('Coverage Incomplete');
  expect(state.rpcCalls.filter((call) => call.name === 'fn_cashier_conservation_report')).toEqual([
    { name: 'fn_cashier_conservation_report', args: { p_club_id: CLUB_A } },
  ]);
  expect(toastMocks.success).not.toHaveBeenCalledWith('Cashier Balances Reconciled');
});

it('Phase 4: clears search and filters, retains focus, and prunes hidden selections', async () => {
  state.roster = [
    player(0, 120, 'First Player'),
    { ...player(1, 240, 'Second Agent'), role: 'agent', role_rank: 3 },
  ];
  mountCashier();
  await synchronized();
  fireEvent.click(screen.getByRole('checkbox', { name: 'Include First Player' }));
  fireEvent.change(screen.getByRole('combobox', { name: 'Filter Roster By Role' }), {
    target: { value: 'agent' },
  });
  expect(screen.queryByRole('link', { name: 'Manage First Player' })).toBeNull();
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Send Out', exact: true })).toBeDisabled()
  );
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'no-match' } });
  fireEvent.click(screen.getByRole('button', { name: 'Clear Search' }));
  expect(screen.getByRole('searchbox')).toHaveFocus();
  expect(screen.getByRole('combobox', { name: 'Filter Roster By Role' })).toHaveValue('agent');
  fireEvent.click(screen.getByRole('button', { name: 'Clear Filters' }));
  expect(screen.getByRole('link', { name: 'Manage First Player' })).toBeInTheDocument();
  expect(screen.getByRole('searchbox')).toHaveFocus();
});
it('Phase 4: shows the selected identity, separate player balance and actual send destination', async () => {
  state.roster = [{ ...player(0, 120, 'First Agent'), role: 'agent', role_rank: 3 }];
  mountCashier();
  await synchronized();
  fireEvent.click(screen.getByRole('checkbox', { name: 'Include First Agent' }));
  fireEvent.click(screen.getByRole('button', { name: 'Send Out', exact: true }));
  const dialog = await screen.findByRole('dialog', { name: 'Send Out' });
  // Dan 2026-10-15: a large name, the player number, a large balance and the
  // sender's own balance, and no paragraph of words.
  const card = within(dialog).getByRole('region', { name: 'Selected Player' });
  expect(card).toHaveTextContent('First Agent');
  await waitFor(() => expect(card).toHaveTextContent('340'));
  // Dan 2026-10-17: no extra balance strip between the player frame and the
  // funding frame; each frame prints its balance once and the selector
  // options carry the rest.
  expect(
    within(dialog).queryByRole('region', { name: 'Selected Player Wallet Balances' })
  ).toBeNull();
  expect(dialog.textContent?.match(/340\.00/g)?.length ?? 0).toBeLessThanOrEqual(2);
  expect(within(card).getByRole('option', { name: 'Agent Wallet: 340.00' })).toBeInTheDocument();
  expect(within(card).getByRole('option', { name: 'Player Wallet: 120.00' })).toBeInTheDocument();
  expect(
    within(card).getByRole('combobox', { name: 'Recipient Wallet For First Agent' })
  ).toHaveValue('agent_wallet');
  // The one native control is a direct child of the frame, allowing its
  // transparent hit area to cover the avatar, identity and balance together.
  const selector = within(card).getByRole('combobox');
  expect(selector.parentElement).toBe(card);
  selector.focus();
  expect(selector).toHaveFocus();
  const face = card.cloneNode(true) as HTMLElement;
  face.querySelector('select')!.remove();
  expect(face.textContent).toContain('Agent Wallet');
  expect(face.textContent?.match(/340\.00/g)).toHaveLength(1);
  expect(card).not.toHaveTextContent('Sending To');
  expect(within(card).getByRole('option', { name: 'Promo Wallet: 80.00' })).toBeInTheDocument();
  fireEvent.change(within(card).getByRole('combobox'), { target: { value: 'player_wallet' } });
  expect(within(card).getByRole('option', { name: 'Player Wallet: 120.00' })).toBeInTheDocument();
  const changedFace = card.cloneNode(true) as HTMLElement;
  changedFace.querySelector('select')!.remove();
  expect(changedFace.textContent).toContain('Player Wallet');
  expect(changedFace.textContent?.match(/120\.00/g)).toHaveLength(1);
  expect(within(dialog).getByRole('region', { name: 'From Your Agent Wallet' })).toHaveTextContent(
    '500'
  );
  const funding = within(dialog).getByRole('region', { name: 'From Your Agent Wallet' });
  const source = within(funding).getByRole('combobox', { name: 'Send From' });
  expect(source.parentElement).toBe(funding);
  const fundingFace = funding.cloneNode(true) as HTMLElement;
  fundingFace.querySelector('select')!.remove();
  expect(fundingFace.textContent).toContain('From Your Agent Wallet');
  expect(fundingFace.textContent?.match(/500\.00/g)).toHaveLength(1);
  expect(
    within(source).getByRole('option', { name: 'From Your Agent Wallet: 500.00' })
  ).toBeInTheDocument();
  expect(dialog).not.toHaveTextContent('Amount Per Player');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Send Ticket' }));
  expect(within(dialog).getByRole('region', { name: 'From Your Player Wallet' })).toHaveTextContent(
    '250'
  );
  expect(within(dialog).getByRole('combobox', { name: 'Tournament' })).toBeInTheDocument();
});
it('Phase 4: places the working roster before the read-only reconciliation report', async () => {
  mountCashier();
  await synchronized();
  const roster = screen.getByRole('tabpanel', { name: 'Trade' });
  const report = screen.getByRole('region', { name: 'Reconciliation Console' });
  expect(roster.compareDocumentPosition(report) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

it('Phase 5: sends exact individual amounts and displays only the acknowledged total and references', async () => {
  state.roster = [player(0, 75), player(1, 50)];
  state.agentWallet = 0.3;
  state.batch = async (args) => ({
    data: {
      success: true,
      results: (args.p_items as Array<{ user_id: string }>).map((item, index) => ({
        user_id: item.user_id,
        success: true,
        transaction_id: `receipt-${index}`,
      })),
    },
    error: null,
  });
  mountCashier();
  await synchronized();
  const dialog = await openSendOut('0.10', 2);
  fireEvent.change(within(dialog).getByRole('textbox', { name: 'Amount For Player 2' }), {
    target: { value: '0.20' },
  });
  expect(within(dialog).getByText(/Total: 0.30/)).toBeInTheDocument();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm' }));
  const receipt = await screen.findByRole('region', { name: 'Batch Transfer Receipt' });
  expect(receipt).toHaveTextContent('Confirmed Total: 0.30 Chips');
  expect(receipt).toHaveTextContent('Reference: receipt-0');
  expect(receipt).toHaveTextContent('Reference: receipt-1');
  expect(
    state.rpcCalls.find((call) => call.name === 'fn_cashier_batch_transfer')?.args.p_items
  ).toEqual([
    expect.objectContaining({ user_id: PLAYER_IDS[0], amount: 0.1 }),
    expect.objectContaining({ user_id: PLAYER_IDS[1], amount: 0.2 }),
  ]);
});

it('Phase 5: rejects an invalid individual amount before sending any recipient', async () => {
  state.roster = [player(0, 75), player(1, 50)];
  mountCashier();
  await synchronized();
  const dialog = await openSendOut('10', 2);
  fireEvent.change(within(dialog).getByRole('textbox', { name: 'Amount For Player 2' }), {
    target: { value: '10.005' },
  });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm' }));
  expect(state.rpcCalls.some((call) => call.name === 'fn_cashier_batch_transfer')).toBe(false);
  expect(toastMocks.error).toHaveBeenCalledWith(
    'Enter The Amount As Digits, With Up To Two Decimals'
  );
  expect(within(dialog).getByRole('textbox', { name: 'Amount For Player 2' })).toHaveAttribute(
    'aria-invalid',
    'true'
  );
  expect(within(dialog).getByRole('status')).toHaveTextContent(
    'Amount For Player 2: Enter The Amount As Digits'
  );
});

it('Phase 5: preserves individual amounts and original retry keys after lost responses and a reload', async () => {
  state.roster = [player(0, 75), player(1, 50)];
  state.batch = async () => ({ data: null, error: { message: 'Connection Lost' } });
  const mounted = mountCashier();
  await synchronized();
  let dialog = await openSendOut('10', 2);
  fireEvent.change(within(dialog).getByRole('textbox', { name: 'Amount For Player 2' }), {
    target: { value: '21.05' },
  });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm' }));
  await screen.findByRole('region', { name: 'Batch Transfer Receipt' });
  expect(screen.getByRole('region', { name: 'Batch Transfer Receipt' })).toHaveTextContent(
    'Outcome Needs Verification'
  );
  expect(screen.queryByText(/Did Not Go Through/)).toBeNull();
  const first = state.rpcCalls.find((call) => call.name === 'fn_cashier_batch_transfer')!;
  const saved = readCashierTransferRecovery(USER_ID, CLUB_A)!;
  expect(saved.targetAmounts).toEqual({ [PLAYER_IDS[0]]: 10, [PLAYER_IDS[1]]: 21.05 });
  mounted.unmount();
  mountCashier();
  await synchronized();
  const priorRpc = vi.mocked(supabase.rpc).getMockImplementation()!;
  vi.mocked(supabase.rpc).mockImplementation((name, args) =>
    name === 'fn_cashier_recovery_receipts'
      ? (Promise.resolve({ data: { operations: [], tickets: [] }, error: null }) as never)
      : priorRpc(name, args)
  );
  fireEvent.click(screen.getByRole('button', { name: 'Review And Retry' }));
  dialog = await screen.findByRole('dialog', { name: /Send Out/ });
  expect(within(dialog).getByRole('textbox', { name: 'Amount For Player 2' })).toHaveValue('21.05');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm' }));
  await waitFor(() =>
    expect(state.rpcCalls.filter((call) => call.name === 'fn_cashier_batch_transfer')).toHaveLength(
      2
    )
  );
  const retry = state.rpcCalls.filter((call) => call.name === 'fn_cashier_batch_transfer')[1];
  expect(retry.args.p_items).toEqual(first.args.p_items);
  expect(retry.args.p_batch_id).toBe(first.args.p_batch_id);
});

it('Phase 5: reports partial refusals separately from duplicate or missing acknowledgements', async () => {
  state.roster = [player(0, 75), player(1, 50), player(2, 25)];
  state.batch = async () => ({
    data: {
      success: true,
      results: [
        { user_id: PLAYER_IDS[0], success: true, transaction_id: 'real-receipt' },
        { user_id: PLAYER_IDS[1], success: false, error: 'Recipient Changed' },
        { user_id: PLAYER_IDS[2], success: true },
        { user_id: PLAYER_IDS[2], success: true },
      ],
    },
    error: null,
  });
  mountCashier();
  await synchronized();
  const dialog = await openSendOut('10', 3);
  fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm' }));
  const receipt = await screen.findByRole('region', { name: 'Batch Transfer Receipt' });
  expect(receipt).toHaveTextContent('Confirmed Total: 10 Chips');
  expect(receipt).toHaveTextContent('Refused');
  expect(receipt).toHaveTextContent('Outcome Needs Verification');
  // The refusal is definitive and is not journaled; only the unknown outcome is.
  expect(readCashierTransferRecovery(USER_ID, CLUB_A)?.failures).toEqual([
    expect.objectContaining({ userId: PLAYER_IDS[2] }),
  ]);
});

it('Phase 5: amounts cannot change while a batch acknowledgement is pending', async () => {
  state.roster = [player(0, 75), player(1, 50)];
  const pending = deferred<unknown>();
  state.batch = () => pending.promise;
  mountCashier();
  await synchronized();
  const dialog = await openSendOut('10', 2);
  fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm' }));
  for (const input of within(dialog).getAllByRole('textbox')) expect(input).toBeDisabled();
  await act(async () => pending.resolve({ data: null, error: { message: 'Connection Lost' } }));
});

it('Phase 5: a mismatched batch acknowledgement never confirms money movement', async () => {
  state.batch = async () => ({
    data: { success: true, batch_id: CLUB_B, results: [{ user_id: PLAYER_IDS[0], success: true }] },
    error: null,
  });
  mountCashier();
  await synchronized();
  const dialog = await openSendOut('10', 1);
  fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm' }));
  const receipt = await screen.findByRole('region', { name: 'Batch Transfer Receipt' });
  expect(receipt).toHaveTextContent('Confirmed Total: 0 Chips');
  expect(receipt).toHaveTextContent('Outcome Needs Verification');
  expect(readCashierTransferRecovery(USER_ID, CLUB_A)).not.toBeNull();
});

it('Phase 5: tournament ticket keys are bound to the tournament and survive a reload', async () => {
  state.roster = [player(0, 75), player(1, 50)];
  state.batch = async () => ({ data: null, error: { message: 'Connection Lost' } });
  const mounted = mountCashier();
  await synchronized();
  let dialog = await openSendOut('10', 2);
  fireEvent.click(within(dialog).getByRole('button', { name: 'Send Ticket' }));
  await chooseTournament(dialog);
  fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm' }));
  await screen.findByRole('region', { name: 'Batch Transfer Receipt' });
  const first = state.rpcCalls.find((call) => call.name === 'fn_cashier_batch_transfer')!;
  expect(first.args.p_kind).toBe('ticket');
  expect(first.args.p_items).toEqual([
    expect.objectContaining({
      user_id: PLAYER_IDS[0],
      tournament_id: TOURNEY_ID,
      amount: 10,
      idempotency_key: expect.stringContaining(`:tournament:${TOURNEY_ID}`),
    }),
    expect.objectContaining({
      user_id: PLAYER_IDS[1],
      tournament_id: TOURNEY_ID,
      amount: 10,
      idempotency_key: expect.stringContaining(`:tournament:${TOURNEY_ID}`),
    }),
  ]);
  expect(readCashierTransferRecoveries(USER_ID, CLUB_A)[0].tournamentId).toBe(TOURNEY_ID);
  mounted.unmount();
  mountCashier();
  await synchronized();
  const priorRpc = vi.mocked(supabase.rpc).getMockImplementation()!;
  vi.mocked(supabase.rpc).mockImplementation((name, args) =>
    name === 'fn_cashier_recovery_receipts'
      ? (Promise.resolve({ data: { operations: [], tickets: [] }, error: null }) as never)
      : priorRpc(name, args)
  );
  fireEvent.click(screen.getByRole('button', { name: 'Review And Retry' }));
  dialog = await screen.findByRole('dialog', { name: /Send Ticket/ });
  const lookup = vi
    .mocked(supabase.rpc)
    .mock.calls.find(([name]) => name === 'fn_cashier_recovery_receipts')!;
  expect(lookup[1]?.p_ticket_keys).toEqual(
    (first.args.p_items as Array<{ idempotency_key: string }>).map((item) => item.idempotency_key)
  );
  await within(dialog).findByRole('option', { name: /Test Event/ });
  await waitFor(() =>
    expect(within(dialog).getByRole('combobox', { name: 'Tournament' })).toHaveValue(TOURNEY_ID)
  );
  fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm' }));
  await waitFor(() =>
    expect(state.rpcCalls.filter((call) => call.name === 'fn_cashier_batch_transfer')).toHaveLength(
      2
    )
  );
  expect(
    state.rpcCalls.filter((call) => call.name === 'fn_cashier_batch_transfer')[1].args
  ).toEqual(first.args);
});

it('Phase 5: confirmed removed recipients retain their own amount while only the original pending intent retries', async () => {
  const submissionId = '55555555-5555-4555-8555-555555555555';
  const keys = {
    [PLAYER_IDS[0]]: '66666666-6666-4666-8666-666666666661',
    [PLAYER_IDS[1]]: '66666666-6666-4666-8666-666666666662',
  };
  state.roster = [player(1, 50)];
  writeCashierTransferRecovery({
    version: 1,
    userId: USER_ID,
    clubId: CLUB_A,
    kind: 'send',
    amount: 10,
    targetAmounts: { [PLAYER_IDS[0]]: 10, [PLAYER_IDS[1]]: 21.05 },
    targetIds: PLAYER_IDS.slice(0, 2),
    failures: PLAYER_IDS.slice(0, 2).map((userId) => ({
      userId,
      name: 'Original Recipient',
      message: 'Unknown',
    })),
    submissionId,
    opIds: keys,
    destinations: { [PLAYER_IDS[0]]: 'player_wallet', [PLAYER_IDS[1]]: 'player_wallet' },
    createdAt: Date.now(),
  });
  state.batch = async () => ({ data: null, error: { message: 'Connection Lost' } });
  mountCashier();
  await synchronized();
  const priorRpc = vi.mocked(supabase.rpc).getMockImplementation()!;
  vi.mocked(supabase.rpc).mockImplementation((name, args) =>
    name === 'fn_cashier_recovery_receipts'
      ? (Promise.resolve({
          data: {
            operations: [{ operation_id: keys[PLAYER_IDS[0]], receipt: { success: true } }],
            tickets: [],
          },
          error: null,
        }) as never)
      : priorRpc(name, args)
  );
  fireEvent.click(screen.getByRole('button', { name: 'Review And Retry' }));
  const dialog = await screen.findByRole('dialog', { name: /Send Out/ });
  expect(within(dialog).getByText(/Total: 21.05/)).toBeInTheDocument();
  expect(within(dialog).getByRole('textbox', { name: 'Amount' })).toHaveValue('21.05');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm' }));
  await waitFor(() =>
    expect(state.rpcCalls.some((call) => call.name === 'fn_cashier_batch_transfer')).toBe(true)
  );
  const request = state.rpcCalls.find((call) => call.name === 'fn_cashier_batch_transfer')!;
  expect(request.args.p_batch_id).toBe(submissionId);
  expect(request.args.p_items).toEqual([
    expect.objectContaining({ user_id: PLAYER_IDS[1], amount: 21.05, op_id: keys[PLAYER_IDS[1]] }),
  ]);
  const receipt = screen.getByRole('region', { name: 'Batch Transfer Receipt' });
  expect(receipt).toHaveTextContent('Confirmed Total: 10 Chips');
  expect(readCashierTransferRecovery(USER_ID, CLUB_A)?.targetAmounts).toEqual({
    [PLAYER_IDS[0]]: 10,
    [PLAYER_IDS[1]]: 21.05,
  });
});

it('Phase 5: editing one individual amount creates a new intent without erasing the old uncertain receipt', async () => {
  state.roster = [player(0, 75), player(1, 50)];
  state.batch = async () => ({ data: null, error: { message: 'Connection Lost' } });
  mountCashier();
  await synchronized();
  const dialog = await openSendOut('10', 2);
  fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm' }));
  await screen.findByRole('region', { name: 'Batch Transfer Receipt' });
  const first = state.rpcCalls.find((call) => call.name === 'fn_cashier_batch_transfer')!;
  fireEvent.change(within(dialog).getByRole('textbox', { name: 'Amount For Player 2' }), {
    target: { value: '21.05' },
  });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm' }));
  await waitFor(() =>
    expect(state.rpcCalls.filter((call) => call.name === 'fn_cashier_batch_transfer')).toHaveLength(
      2
    )
  );
  const next = state.rpcCalls.filter((call) => call.name === 'fn_cashier_batch_transfer')[1];
  expect(next.args.p_batch_id).not.toBe(first.args.p_batch_id);
  const recoveries = readCashierTransferRecoveries(USER_ID, CLUB_A);
  expect(recoveries).toHaveLength(2);
  expect(
    recoveries.find((row) => row.submissionId === first.args.p_batch_id)?.targetAmounts
  ).toEqual({ [PLAYER_IDS[0]]: 10, [PLAYER_IDS[1]]: 10 });
  expect(
    recoveries.find((row) => row.submissionId === next.args.p_batch_id)?.targetAmounts
  ).toEqual({ [PLAYER_IDS[0]]: 10, [PLAYER_IDS[1]]: 21.05 });
});

it('Phase 7: associates a single send amount refusal with its field', async () => {
  state.roster = [player(0, 75)];
  mountCashier();
  await synchronized();
  await openSendOut('10.005', 1);
  const field = screen.getByRole('textbox', { name: 'Amount' });
  expect(field).toHaveAttribute('aria-invalid', 'true');
  expect(field).toHaveAccessibleDescription(/Enter The Amount As Digits, With Up To Two Decimals/);
  expect(state.rpcCalls.some((call) => call.name === 'fn_cashier_batch_transfer')).toBe(false);
  fireEvent.change(field, { target: { value: '0.20' } });
  expect(field).toHaveAttribute('aria-invalid', 'false');
  expect(field).toHaveAccessibleDescription('');
});

it('Phase 7: a ticket is priced by its tournament and waits for one to be chosen', async () => {
  state.roster = [player(0, 75)];
  mountCashier();
  await synchronized();
  const dialog = await openSendOut('10.005', 1);
  fireEvent.click(within(dialog).getByRole('button', { name: 'Send Ticket', exact: true }));
  expect(within(dialog).queryByRole('textbox', { name: 'Amount' })).toBeNull();
  expect(within(dialog).getByRole('button', { name: 'Confirm' })).toBeDisabled();
  await chooseTournament(dialog);
  expect(within(dialog).getByText(/Total: 10/)).toBeInTheDocument();
  expect(within(dialog).getByRole('button', { name: 'Confirm' })).toBeEnabled();
  expect(state.rpcCalls.some((call) => call.name === 'fn_cashier_batch_transfer')).toBe(false);
});

it('Phase 7: the native player composer traps both Tab directions and returns focus on Escape', async () => {
  state.roster = [player(0, 75)];
  mountCashier();
  await synchronized();
  fireEvent.click(screen.getByRole('checkbox', { name: 'Include Player 1', exact: true }));
  const trigger = screen.getByRole('button', { name: 'Send Out', exact: true });
  trigger.focus();
  fireEvent.click(trigger);
  const dialog = await screen.findByRole('dialog', { name: 'Send Out', exact: true });
  const field = within(dialog).getByRole('textbox', { name: 'Amount' });
  fireEvent.change(field, { target: { value: '10' } });
  await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
  expect(document.body.style.overflow).toBe('hidden');
  const controls = dialog.querySelectorAll<HTMLElement>(
    'button:not(:disabled), input:not(:disabled)'
  );
  controls[controls.length - 1].focus();
  fireEvent.keyDown(document, { key: 'Tab' });
  expect(document.activeElement).toBe(controls[0]);
  fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
  expect(document.activeElement).toBe(controls[controls.length - 1]);
  fireEvent.keyDown(document, { key: 'Escape' });
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(trigger));
  expect(document.body.style.overflow).not.toBe('hidden');
  expect(state.rpcCalls.some((call) => call.name === 'fn_cashier_batch_transfer')).toBe(false);
});

describe('Simple Cashier Default', () => {
  it('defaults to the compact roster, keeps all three actions, and restores Advanced tools', async () => {
    const { container } = mountCashier();
    await waitFor(() => expect(screen.getByText('Balances Synchronized')).toBeInTheDocument());
    expect(container.querySelector('[data-cashier-mode="simple"]')).not.toBeNull();
    expect(screen.queryByRole('tablist', { name: 'Cashier Actions' })).toBeNull();
    for (const name of ['Claim Back', 'Send Ticket', 'Send Out']) {
      expect(screen.getByRole('button', { name, exact: true })).toBeInTheDocument();
    }
    expect(screen.getByPlaceholderText('Search Name Or ID Number')).toBeInTheDocument();
    expect(screen.getByText('ID: P-1').parentElement?.querySelector('img')).not.toBeNull();
    expect(
      within(screen.getByRole('link', { name: 'Manage Player 1' }).parentElement!).getByText(
        '75.00',
        {
          exact: true,
        }
      )
    ).toBeInTheDocument();
    const css = readFileSync('src/pages/CashierTradePage.module.css', 'utf8');
    expect(css).toContain('.page.simple .glass .rowSub:not(.simpleId)');
    expect(css).not.toContain('.page.simple .rowSub:not(.simpleId)');
    fireEvent.click(screen.getByRole('button', { name: /^Advanced/ }));
    expect(screen.getByRole('tablist', { name: 'Cashier Actions' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reconcile Now' })).toBeInTheDocument();
    fireEvent.change(screen.getByRole('combobox', { name: /Role/ }), {
      target: { value: 'agent' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Simple', exact: true }));
    expect(container.querySelector('[data-cashier-mode="simple"]')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^Advanced/ }));
    expect(screen.getByRole('combobox', { name: /Role/ })).toHaveValue('all');
  });
});

describe('Simple And Advanced Action Recovery Audit', () => {
  const recentSend = {
    transaction_id: '77777777-7777-4777-8777-777777777777',
    to_user_id: PLAYER_IDS[0],
    to_name: 'Recent Recipient',
    amount: 40,
    claimed_back: 0,
    remaining: 40,
    destination: 'player_wallet',
    seconds_left: 500,
  };

  it('names the actual Promo Wallet on a reversible Agent Wallet send', async () => {
    state.myRole = 'agent';
    state.reversible = async () => ({
      data: [{ ...recentSend, destination: 'promo_wallet' }],
      error: null,
    });
    mountCashier();
    await synchronized();
    fireEvent.click(screen.getByRole('button', { name: 'Claim Back', exact: true }));
    const dialog = await screen.findByRole('dialog', { name: 'Claim Back', exact: true });
    await within(dialog).findByText('Recent Recipient');
    expect(dialog).toHaveTextContent('Promo Wallet');
  });

  it('reports a rejected Claim Back read and allows a successful Retry', async () => {
    state.reversible = async () => {
      throw new Error('Transport Rejected');
    };
    mountCashier();
    await synchronized();
    fireEvent.click(screen.getByRole('button', { name: 'Claim Back', exact: true }));
    const dialog = await screen.findByRole('dialog', { name: 'Claim Back', exact: true });
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Could Not Read Your Recent Sends.'
    );
    expect(within(dialog).queryByText('Reading Your Recent Sends...')).toBeNull();
    state.reversible = async () => ({ data: [recentSend], error: null });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Retry' }));
    expect(await within(dialog).findByText('Recent Recipient')).toBeInTheDocument();
    expect(within(dialog).queryByRole('alert')).toBeNull();
  });

  it('hides the previous Claim Back rows until a same-club reread completes', async () => {
    state.reversible = async () => ({ data: [recentSend], error: null });
    mountCashier();
    await synchronized();
    fireEvent.click(screen.getByRole('button', { name: 'Claim Back', exact: true }));
    let dialog = await screen.findByRole('dialog', { name: 'Claim Back', exact: true });
    await within(dialog).findByText('Recent Recipient');
    fireEvent.keyDown(document, { key: 'Escape' });
    const reread = deferred<unknown>();
    state.reversible = () => reread.promise;
    fireEvent.click(screen.getByRole('button', { name: 'Claim Back', exact: true }));
    dialog = await screen.findByRole('dialog', { name: 'Claim Back', exact: true });
    expect(within(dialog).getByText('Reading Your Recent Sends...')).toBeInTheDocument();
    expect(within(dialog).queryByText('Recent Recipient')).toBeNull();
    expect(within(dialog).queryByRole('button', { name: 'Claim Back', exact: true })).toBeNull();
    await act(async () => reread.resolve({ data: [], error: null }));
    expect(
      await within(dialog).findByText(/Nothing Is Still Inside Its Ten Minute Window/)
    ).toBeInTheDocument();
  });

  it.each([
    ['send', false],
    ['send', true],
    ['ticket', false],
    ['ticket', true],
  ] as const)(
    'keeps an unresolved %s journal when the other action is submitted in Advanced=%s',
    async (firstKind, advanced) => {
      state.batch = async () => ({ data: null, error: { message: 'Connection Lost' } });
      mountCashier();
      await waitFor(() => expect(screen.getByText('Balances Synchronized')).toBeInTheDocument());
      if (advanced) fireEvent.click(screen.getByRole('button', { name: /^Advanced/ }));
      let dialog = await openSendOut('10', 1);
      if (firstKind === 'ticket') {
        fireEvent.click(within(dialog).getByRole('button', { name: 'Send Ticket', exact: true }));
        await chooseTournament(dialog);
      }
      fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm', exact: true }));
      await screen.findByRole('region', { name: 'Batch Transfer Receipt' });
      const original = readCashierTransferRecoveries(USER_ID, CLUB_A)[0];
      expect(original.kind).toBe(firstKind);
      fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel', exact: true }));
      const nextKind = firstKind === 'send' ? 'ticket' : 'send';
      fireEvent.click(
        screen.getByRole('button', {
          name: nextKind === 'send' ? 'Send Out' : 'Send Ticket',
          exact: true,
        })
      );
      dialog = await screen.findByRole('dialog', {
        name: nextKind === 'send' ? 'Send Out' : 'Send Ticket',
        exact: true,
      });
      if (nextKind === 'ticket') await chooseTournament(dialog);
      state.batch = async (params) => ({
        data: {
          success: true,
          results: (params.p_items as Array<{ user_id: string }>).map((item) => ({
            user_id: item.user_id,
            success: true,
          })),
        },
        error: null,
      });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm', exact: true }));
      await waitFor(() =>
        expect(
          state.rpcCalls.filter((call) => call.name === 'fn_cashier_batch_transfer')
        ).toHaveLength(2)
      );
      const calls = state.rpcCalls.filter((call) => call.name === 'fn_cashier_batch_transfer');
      expect(calls[1].args.p_kind).toBe(nextKind);
      expect(calls[1].args.p_batch_id).not.toBe(calls[0].args.p_batch_id);
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(readCashierTransferRecoveries(USER_ID, CLUB_A)).toEqual([original]);
      expect(screen.getByRole('button', { name: 'Review And Retry' })).toBeInTheDocument();
      expect(toastMocks.error).not.toHaveBeenCalledWith(
        'Cashier Safety Storage Is Unavailable. Free Browser Storage And Try Again'
      );
    }
  );

  it.each([false, true])(
    'claims the original send once in Advanced=%s and retains its key on an uncertain retry',
    async (advanced) => {
      state.reversible = async () => ({ data: [recentSend], error: null });
      mountCashier();
      await waitFor(() => expect(screen.getByText('Balances Synchronized')).toBeInTheDocument());
      if (advanced) fireEvent.click(screen.getByRole('button', { name: /^Advanced/ }));
      const originalRpc = vi.mocked(supabase.rpc).getMockImplementation()!;
      const firstReply = deferred<unknown>();
      const claimCalls: Array<Record<string, unknown>> = [];
      vi.mocked(supabase.rpc).mockImplementation((name, args) => {
        if (name !== 'fn_agent_wallet_claim_back') return originalRpc(name, args);
        claimCalls.push(args as Record<string, unknown>);
        return (
          claimCalls.length === 1
            ? firstReply.promise
            : Promise.resolve({ data: { success: true, amount: 40, replayed: true }, error: null })
        ) as never;
      });
      fireEvent.click(screen.getByRole('button', { name: 'Claim Back', exact: true }));
      const dialog = await screen.findByRole('dialog', { name: 'Claim Back', exact: true });
      const claim = await within(dialog).findByRole('button', { name: 'Claim Back', exact: true });
      fireEvent.click(claim);
      fireEvent.click(claim);
      await waitFor(() => expect(claimCalls).toHaveLength(1));
      expect(claimCalls[0]).toEqual(
        expect.objectContaining({
          p_club_id: CLUB_A,
          p_transaction_id: recentSend.transaction_id,
          p_amount: null,
        })
      );
      await act(async () =>
        firstReply.resolve({ data: null, error: { message: 'Connection Lost' } })
      );
      await waitFor(() =>
        expect(
          within(dialog).getByRole('button', { name: 'Claim Back', exact: true })
        ).toBeEnabled()
      );
      fireEvent.click(within(dialog).getByRole('button', { name: 'Claim Back', exact: true }));
      await waitFor(() => expect(claimCalls).toHaveLength(2));
      expect(claimCalls[1]).toEqual(claimCalls[0]);
      await waitFor(() =>
        expect(toastMocks.success).toHaveBeenCalledWith(
          expect.stringContaining('That Claim Had Already Gone Through'),
          undefined,
          undefined,
          expect.any(String)
        )
      );
    }
  );
});

it('the sender chooses a recipient agent player wallet and the batch retains that destination', async () => {
  state.roster = [{ ...player(0, 10, 'Player 1'), role: 'agent' }];
  state.agentWallet = 5000;
  mountCashier();
  await synchronized();
  const dialog = await openSendOut('5', 1);
  fireEvent.change(
    within(dialog).getByRole('combobox', { name: 'Recipient Wallet For Player 1' }),
    {
      target: { value: 'player_wallet' },
    }
  );
  fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm', exact: true }));
  await waitFor(() =>
    expect(state.rpcCalls.some((call) => call.name === 'fn_cashier_batch_transfer')).toBe(true)
  );
  const batch = state.rpcCalls.find((call) => call.name === 'fn_cashier_batch_transfer')!;
  expect(batch.args.p_items).toEqual([
    expect.objectContaining({ user_id: PLAYER_IDS[0], destination: 'player_wallet' }),
  ]);
});

it('preloads the most recent own ticket, send and claim counterparties before high balances', async () => {
  state.roster = [player(0, 9000), player(1, 5), player(2, 10)];
  state.recentMoves = [
    {
      from_user_id: USER_ID,
      to_user_id: PLAYER_IDS[2],
      transaction_type: 'tournament_ticket_issue',
    },
    { from_user_id: USER_ID, to_user_id: PLAYER_IDS[1], transaction_type: 'agent_wallet_send' },
    { from_user_id: PLAYER_IDS[0], to_user_id: USER_ID, transaction_type: 'agent_wallet_send' },
    { from_user_id: PLAYER_IDS[2], to_user_id: USER_ID, transaction_type: 'club_bank_claim_back' },
  ];
  mountCashier();
  await synchronized();
  await waitFor(() =>
    expect(
      screen
        .getAllByRole('checkbox', { name: /^Include Player/ })
        .map((button) => button.getAttribute('aria-label'))
    ).toEqual(['Include Player 3', 'Include Player 2', 'Include Player 1'])
  );
});

it('background balance events and browser wake preserve a typed transfer', async () => {
  mountCashier();
  await synchronized();
  const dialog = await openSendOut('100000', 1);
  const field = within(dialog).getByRole('textbox', { name: 'Amount' });
  expect(field).toHaveValue('100,000');
  const before = state.rpcCalls.filter(
    (call) => call.name === 'fn_club_cashier_members_page_v3'
  ).length;
  act(() => {
    bus.emit('BALANCE_UPDATED', { clubId: CLUB_A });
    window.dispatchEvent(new Event('focus'));
    document.dispatchEvent(new Event('visibilitychange'));
  });
  expect(field).toHaveValue('100,000');
  expect(
    state.rpcCalls.filter((call) => call.name === 'fn_club_cashier_members_page_v3')
  ).toHaveLength(before);
  expect(screen.getByRole('dialog', { name: 'Send Out' })).toBe(dialog);
});

it.each(['player', 'agent'])(
  'Simple Cashier opens the amount-based cashout sheet for a %s',
  async (role) => {
    state.myRole = role;
    state.myBalance = 6000;
    mountCashier();
    const entry = await screen.findByRole('button', { name: 'Request Cash Out' });
    await waitFor(() => expect(entry).toHaveTextContent('6,000.00 Chips'));
    fireEvent.click(entry);
    const sheet = await screen.findByRole('dialog', { name: 'Request Cashout' });
    expect(within(sheet).getByText('Available Balance')).toBeInTheDocument();
    expect(within(sheet).getByText('6,000.00 Chips')).toBeInTheDocument();
    expect(within(sheet).getByRole('textbox', { name: /Amount/i })).toBeInTheDocument();
    expect(
      within(sheet).getByText(/Chips Will Be Locked Until Your Agent Approves/i)
    ).toBeInTheDocument();
    expect(state.rpcCalls.some((call) => call.name === 'fn_cashout_request_v2')).toBe(false);
  }
);

it.each(['club_bank', 'promo_wallet', 'club_promo_wallet', 'player_wallet'] as const)(
  'Send Out binds selected %s source, balance and recipient promo wallet',
  async (source) => {
    state.roster = [{ ...player(0, 120), role: 'agent' }];
    mountCashier();
    await synchronized();
    const dialog = await openSendOut('5', 1);
    const sourceSelect = within(dialog).getByRole('combobox', { name: 'Send From' });
    expect(sourceSelect).toHaveValue('agent_wallet');
    await waitFor(() =>
      expect(
        within(sourceSelect).getByRole('option', { name: /From The Main Bank: 1,000\.00/ })
      ).toBeInTheDocument()
    );
    fireEvent.change(sourceSelect, { target: { value: source } });
    fireEvent.change(
      within(dialog).getByRole('combobox', { name: 'Recipient Wallet For Player 1' }),
      { target: { value: 'promo_wallet' } }
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm', exact: true }));
    await waitFor(() =>
      expect(state.rpcCalls.some((call) => call.name === 'fn_cashier_batch_transfer')).toBe(true)
    );
    expect(
      state.rpcCalls.find((call) => call.name === 'fn_cashier_batch_transfer')?.args.p_items
    ).toEqual([expect.objectContaining({ source, destination: 'promo_wallet', amount: 5 })]);
  }
);
it('Send Out gives an agent only their own sending wallets', async () => {
  state.myRole = 'agent';
  mountCashier();
  await synchronized();
  const dialog = await openSendOut('5', 1);
  const source = within(dialog).getByRole('combobox', { name: 'Send From' });
  expect(within(source).getAllByRole('option')).toHaveLength(3);
  expect(source).toHaveValue('agent_wallet');
  expect(within(source).queryByRole('option', { name: /Main Bank/ })).toBeNull();
});

it('keeps each batch recipient identity, selected wallet and current balance together', async () => {
  state.roster = [0, 1].map((index) => ({ ...player(index, 10), role: 'agent' }));
  mountCashier();
  await synchronized();
  const dialog = await openSendOut('5', 2);
  const cards = within(dialog).getAllByRole('region', { name: 'Selected Player' });
  expect(cards).toHaveLength(2);
  for (let index = 0; index < 2; index++) {
    expect(cards[index]).toHaveTextContent(`Player ${index + 1}`);
    expect(cards[index]).toHaveTextContent(`ID: P-${index + 1}`);
    await waitFor(() =>
      expect(
        within(cards[index]).getByRole('option', { name: 'Agent Wallet: 340.00' })
      ).toBeInTheDocument()
    );
    expect(within(cards[index]).getByRole('combobox')).toHaveValue('agent_wallet');
  }
  fireEvent.change(within(cards[1]).getByRole('combobox'), { target: { value: 'promo_wallet' } });
  expect(within(cards[0]).getByRole('combobox')).toHaveValue('agent_wallet');
  expect(within(cards[1]).getByRole('combobox')).toHaveValue('promo_wallet');
  expect(within(dialog).getByRole('textbox', { name: 'Amount For Player 2' })).toHaveValue('5');
});

it('reports a rolled-back maintenance refusal without retaining an uncertain transfer', async () => {
  state.frozen = true;
  state.batch = async () => ({
    data: {
      success: true,
      results: [
        { user_id: PLAYER_IDS[0], success: false, error: 'Transfer Failed', error_code: 'P0001' },
      ],
    },
    error: null,
  });
  mountCashier();
  await synchronized();
  fireEvent.click(screen.getByRole('checkbox', { name: 'Include Player 1' }));
  fireEvent.click(screen.getByRole('button', { name: 'Send Out', exact: true }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Amount' }), { target: { value: '1' } });
  fireEvent.click(screen.getByRole('button', { name: 'Confirm', exact: true }));
  await waitFor(() =>
    expect(
      screen.getByText('Paused For Maintenance. No Chips Were Moved. Try Again When Play Resumes')
    ).toBeInTheDocument()
  );
  expect(toastMocks.error).toHaveBeenCalledWith(
    '1 Transfers Were Refused. No Chips Were Moved For Those Recipients'
  );
  expect(readCashierTransferRecovery(USER_ID, CLUB_A)).toBeNull();
});
