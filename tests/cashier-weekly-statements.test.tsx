/**
 * Source-only candidate: mounted CashierTradePage plus its real weekly reader
 * and canonical account-generation guard. Database/role responses are synthetic;
 * this does not qualify PostgREST projection syntax, RLS or actual weekly books.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WEEKLY_ID as ID, weeklyStatementRow } from './helpers/clubWeeklyStatement';

const state = vi.hoisted(() => ({
  userId: null as string | null,
  auth: undefined as undefined | ((event: { payload: { isAuthenticated: boolean; userId?: string } }) => void),
  role: 'owner', rows: [] as Record<string, unknown>[],
  reply: null as null | (() => Promise<unknown>),
  calls: [] as Array<{ table: string; filters: Array<[string, unknown]>; cap: number }>,
}));
vi.mock('../src/hooks/useAuthUser', () => ({ useAuthUser: () => ({ user: state.userId ? { id: state.userId } : null, isHydrating: false }) }));
vi.mock('../src/core/IdentityDNA', () => ({ getIdentityDNAStatus: () => ({ loaded: !!state.userId, authenticated: !!state.userId, userId: state.userId }) }));
vi.mock('../src/core/MasterBus', () => ({ masterBus: {
  emit: vi.fn(), subscribe: vi.fn((event, callback) => {
    if (event === 'AUTH_STATE_CHANGED') state.auth = callback;
    return vi.fn();
  }),
} }));
vi.mock('../src/services/UnionService', () => ({ UnionService: { getOwnedUnions: vi.fn(async () => []) } }));
vi.mock('../src/utils/clubIdResolver', () => ({
  resolveClubUUID: vi.fn(async id => id),
  isUUID: (id: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id),
}));
vi.mock('../src/components/common/Toast', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }));
vi.mock('../src/components/wallet/WalletCashierModal', () => ({ default: () => null }));
vi.mock('../src/utils/errorReporter', () => ({ reportError: vi.fn() }));

import { supabase } from '../src/lib/supabase';
import CashierTradePage from '../src/pages/CashierTradePage';
import styles from '../src/pages/CashierTradePage.module.css';

function signIn(userId: string | null) {
  state.userId = userId;
  state.auth?.({ payload: { isAuthenticated: !!userId, userId: userId ?? undefined } });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function NavigateClub() {
  const navigate = useNavigate();
  return <button onClick={() => navigate(`/clubs/${ID.otherClub}/cashier`)}>Switch Fixture Club</button>;
}
function mountCashier() {
  return render(<MemoryRouter initialEntries={[`/clubs/${ID.club}/cashier`]}>
    <Routes><Route path="/clubs/:clubId/cashier" element={<><CashierTradePage /><NavigateClub /></>} /></Routes>
  </MemoryRouter>);
}
async function openWeeklyStatements() {
  await screen.findByText('Balances synchronized');
  fireEvent.click(screen.getByRole('tab', { name:'Settlement Record' }));
  return screen.getByRole('tabpanel', { name:'Settlement Record' });
}
beforeEach(() => {
  vi.clearAllMocks(); localStorage.clear();
  state.role = 'owner'; state.rows = []; state.reply = null; state.calls = [];
  signIn(null); signIn(ID.actor);
  Object.defineProperty(navigator, 'onLine', { configurable:true, value:true });
  vi.mocked(supabase.rpc).mockResolvedValue({ data:[], error:null } as never);
  vi.mocked(supabase.from).mockImplementation((table: string) => {
    const call = { table, filters: [] as Array<[string, unknown]>, cap: Infinity };
    state.calls.push(call);
    let columns = '';
    const builder: Record<string, unknown> = {};
    const chain = () => builder;
    for (const method of ['in','or','order','range','gte','lte']) builder[method] = vi.fn(chain);
    builder.select = vi.fn((value: string) => { columns = value; return builder; });
    builder.eq = vi.fn((key: string, value: unknown) => { call.filters.push([key,value]); return builder; });
    builder.limit = vi.fn((limit: number) => { call.cap = limit; return builder; });
    builder.maybeSingle = vi.fn(async () => table === 'club_members'
      ? { data:{ role:state.role,chip_balance:250 },error:null }
      : table === 'agents' ? { data:{ agent_wallet_balance:500 },error:null } : { data:null,error:null });
    builder.then = (done: (value: unknown) => unknown, fail: (reason: unknown) => unknown) => {
      if (table === 'settlement_invoices') {
        const reply = state.reply ? state.reply() : Promise.resolve({
          data:state.rows.filter(row=>call.filters.every(([key,value])=>row[key]===value)).slice(0,call.cap),error:null,
        });
        return reply.then(done,fail);
      }
      const data = table === 'club_members' && columns.includes('clubs:club_id') ? [
        { club_id:ID.club,role:state.role,chip_balance:250,
          clubs:{ name:'Weekly Fixture Club',club_id:101,slug:'weekly-fixture',logo_url:null,is_union:false,owner_id:ID.actor } },
      ] : [];
      return Promise.resolve({ data,error:null,count:0 }).then(done,fail);
    };
    return builder as never;
  });
});

describe('cashier club weekly statement boundary', () => {
  it('shows only scoped weekly funding, club payments and neutral retained chips', async () => {
    state.rows = [weeklyStatementRow({ invoice_type:'accounting_correction',net_amount:'999.00' }),
      weeklyStatementRow({ invoice_type:'club_to_agent',net_amount:'888.00' }),
      weeklyStatementRow({ club_id:ID.otherClub,net_amount:'777.00' }),weeklyStatementRow()];
    mountCashier(); const panel = await openWeeklyStatements();
    expect(await within(panel).findByText('Retained 40.05')).not.toHaveClass(styles.amtIn,styles.amtOut);
    expect(within(panel).getByText('Latest Up To 50 Weekly Statements')).toBeInTheDocument();
    expect(within(panel).getByText('Club Weekly Accounting')).toBeInTheDocument();
    expect(within(panel).getByText(/Rake Funding 100.25/)).toHaveTextContent('Paid By Club 60.20');
    expect(panel).not.toHaveTextContent(/999\.00|888\.00|777\.00|\+40\.05/);
    expect(state.calls.filter(call=>call.table==='settlement_invoices')).toEqual([
      { table:'settlement_invoices',filters:[['club_id',ID.club],['invoice_type','club_weekly_accounting']],cap:50 },
    ]);
  });
  it.each([
    { data:[weeklyStatementRow({ club_id:ID.otherClub })],error:null },
    { data:[weeklyStatementRow({ gross_amount:null })],error:null },
    { data:null,error:{ message:'read unavailable' } },
  ])('shows unavailable for a bad read instead of a zero balance or empty history: %j', async reply => {
    state.reply = async () => reply; mountCashier(); const panel = await openWeeklyStatements();
    expect(await within(panel).findByRole('alert')).toHaveTextContent('Weekly Statements Are Unavailable.');
    expect(within(panel).queryByText(/Retained /)).not.toBeInTheDocument();
    expect(panel).not.toHaveTextContent('No Settlement Records Yet');
  });
  it('retries an unavailable weekly read through the same scoped reader', async () => {
    state.reply = async () => ({ data:null,error:{ message:'offline' } });
    mountCashier(); const panel = await openWeeklyStatements(); await within(panel).findByRole('alert');
    state.reply = null; state.rows = [weeklyStatementRow()];
    fireEvent.click(within(panel).getByRole('button', { name:'Retry' }));
    expect(await within(panel).findByText('Retained 40.05')).toBeInTheDocument();
    expect(within(panel).queryByRole('alert')).not.toBeInTheDocument();
  });
  it('discards an old response through an auth ABA without an intermediate render', async () => {
    const old = deferred<unknown>(); let reads = 0;
    // A later read in the renewed account epoch is separate and unavailable.
    // The old successful response must never become that new read's data.
    state.reply = () => ++reads === 1 ? old.promise : Promise.resolve({ data:null,error:{ message:'new epoch unavailable' } });
    mountCashier(); const panel = await openWeeklyStatements(); await waitFor(()=>expect(reads).toBe(1));
    await act(async () => { signIn(ID.otherActor); signIn(ID.actor); old.resolve({ data:[weeklyStatementRow()],error:null }); });
    expect(await within(panel).findByRole('alert')).toHaveTextContent('Weekly Statements Are Unavailable');
    expect(within(panel).queryByText('Retained 40.05')).not.toBeInTheDocument();
  });
  it('removes the first club statement on navigation while the next club read is unresolved', async () => {
    state.rows = [weeklyStatementRow()]; mountCashier(); const first = await openWeeklyStatements();
    await within(first).findByText('Retained 40.05');
    const pending = deferred<unknown>(); state.reply = () => pending.promise;
    fireEvent.click(screen.getByRole('button', { name:'Switch Fixture Club' }));
    expect(screen.queryByText('Retained 40.05')).not.toBeInTheDocument();
    await waitFor(()=>expect(supabase.rpc).toHaveBeenCalledWith('fn_club_cashier_members_page_v3',
      expect.objectContaining({ p_club_id:ID.otherClub })));
    await screen.findByText('Balances synchronized');
    fireEvent.click(screen.getByRole('tab', { name:'Settlement Record' }));
    const next = screen.getByRole('tabpanel', { name:'Settlement Record' });
    expect(next).not.toHaveTextContent('Retained 40.05');
    await waitFor(()=>expect(state.calls.filter(call=>call.table==='settlement_invoices').at(-1)?.filters)
      .toContainEqual(['club_id',ID.otherClub]));
    await act(async () => { pending.resolve({ data:[],error:null }); });
    expect(await within(next).findByText(/No Settlement Records Yet/)).toBeInTheDocument();
  });
  it('preserves the existing player tab restriction without fetching weekly club documents', async () => {
    state.role = 'player'; mountCashier(); await screen.findByText('Balances synchronized');
    expect(screen.queryByRole('tab', { name:'Settlement Record' })).not.toBeInTheDocument();
    expect(state.calls.some(call=>call.table==='settlement_invoices')).toBe(false);
  });
});
