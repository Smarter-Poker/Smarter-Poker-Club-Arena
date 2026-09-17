/** Source-only candidate. Real reader/export code; synthetic database responses. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WEEKLY_ID as ID, weeklyStatementRow } from '../helpers/clubWeeklyStatement';
const state = vi.hoisted(() => ({ userId: null as string | null,
  auth: undefined as undefined | ((event: { payload: { isAuthenticated: boolean; userId?: string } }) => void),
  rows: [] as Record<string, unknown>[], calls: [] as unknown[][], ignoreFilters: false,
  reply: null as null | (() => Promise<unknown>),
}));
vi.mock('../../src/core/IdentityDNA', () => ({ getIdentityDNAStatus: () => ({ loaded: !!state.userId, authenticated: !!state.userId, userId: state.userId }) }));
vi.mock('../../src/core/MasterBus', () => ({ masterBus: { emit: vi.fn(), subscribe: vi.fn((name, fn) => {
  if (name === 'AUTH_STATE_CHANGED') state.auth = fn; return vi.fn();
}) } }));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
vi.mock('../../src/utils/clubIdResolver', () => ({ resolveClubUUID: vi.fn(async id => id) }));
vi.mock('../../src/lib/supabase', () => ({ supabase: { rpc: vi.fn(), from: vi.fn((table: string) => {
  state.calls.push(['from', table]); const filters: Array<[string, unknown]> = []; let cap = Infinity;
  const chain: any = {};
  for (const method of ['select','order','gte','lte','or']) chain[method] = (...args: unknown[]) => { state.calls.push([method,...args]); return chain; };
  chain.is = (key: string, value: unknown) => { filters.push([key,value]); state.calls.push(['is',key,value]); return chain; };
  chain.eq = (key: string, value: unknown) => { filters.push([key,value]); state.calls.push(['eq',key,value]); return chain; };
  chain.limit = (limit: number) => { cap = limit; state.calls.push(['limit',limit]); return chain; };
  chain.then = (done: (value: unknown) => unknown, fail: (error: unknown) => unknown) => {
    const reply = state.reply ? state.reply() : Promise.resolve({ data: state.rows.filter(row => state.ignoreFilters || filters.every(([key,value]) => row[key] === value)).slice(0,cap), error: null });
    return reply.then(done,fail);
  };
  return chain;
}) } }));
import { readClubWeeklyStatements, formatWeeklyChips } from '../../src/services/ClubWeeklyAccountingReader';
import { FinancialExportService } from '../../src/services/FinancialExportService';
import { resolveClubUUID } from '../../src/utils/clubIdResolver';
function signIn(userId: string | null) { state.userId = userId; state.auth?.({ payload: { isAuthenticated: !!userId, userId: userId ?? undefined } }); }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
beforeEach(() => { vi.clearAllMocks(); state.rows = []; state.calls = []; state.reply = null; state.ignoreFilters = false;
  vi.mocked(resolveClubUUID).mockReset().mockImplementation(async id => id); signIn(null); signIn(ID.actor); });

describe('one canonical club weekly read boundary', () => {
  it('filters correction and individual invoices before the bounded weekly read and preserves factory amounts', async () => {
    state.rows = [weeklyStatementRow({ invoice_type: 'accounting_correction', net_amount: '999.00' }),
      weeklyStatementRow({ invoice_type: 'club_to_agent', net_amount: '500.00' }), weeklyStatementRow(),
      weeklyStatementRow({ club_id: ID.otherClub })];
    const result = await readClubWeeklyStatements({ clubId: ID.club.toUpperCase(), userId: ID.actor });
    expect(result).toMatchObject({ limit: 50, rows: [{ clubId: ID.club, rakeFunding: '100.25', paidByClub: '60.20', retainedByClub: '40.05' }] });
    const typeFilter = state.calls.findIndex(call => call[0] === 'eq' && call[1] === 'invoice_type' && call[2] === 'club_weekly_accounting');
    expect(typeFilter).toBeGreaterThan(-1); expect(typeFilter).toBeLessThan(state.calls.findIndex(call => call[0] === 'limit'));
    expect(state.calls.filter(call => call[0] === 'order')).toEqual([['order','created_at',{ ascending:false }],['order','id',{ ascending:false }]]);
    expect(state.calls.find(call => call[0] === 'select')?.[1]).toContain('gross_amount::text');
    expect(state.calls.find(call => call[0] === 'select')?.[1]).toContain('total_rake_funding:breakdown->>total_rake_funding');
  });
  it.each([
    { club_id: ID.otherClub }, { invoice_type: 'accounting_correction' }, { summary_club_id: ID.otherClub },
    { summary_period_id: ID.invoice }, { ready_to_issue: 'false' }, { status: 'paid' }, { message_sent: false },
    { from_entity_id: ID.actor }, { accounting_version: null }, { gross_amount: null }, { net_amount: 'NaN' },
    { deductions: 'Infinity' }, { gross_amount: 100.25 }, { net_amount: '40.051' },
    { net_amount: '41.05' }, { total_rake_funding: '101.25' }, { created_at: '2026-02-30T08:00:00Z' },
  ])('refuses a mismatched or malformed response %j without inventing zero', async fault => {
    state.ignoreFilters = true; state.rows = [weeklyStatementRow(fault)];
    await expect(readClubWeeklyStatements({ clubId: ID.club })).rejects.toThrow(/Weekly Statement/);
  });
  it('keeps a negative retained amount exact without labelling a payment', async () => {
    state.rows = [weeklyStatementRow({ deductions:'101.20', total_paid_by_club:'101.2000', net_amount:'-0.95', retained_by_club:'-0.9500' })];
    const { rows } = await readClubWeeklyStatements({ clubId: ID.club });
    expect(rows[0].retainedByClub).toBe('-0.95'); expect(formatWeeklyChips(rows[0].retainedByClub)).toBe('-0.95');
  });
  it('preserves the captured numeric(12,2) maximum exactly and refuses amounts outside it', async () => {
    state.rows = [weeklyStatementRow({ gross_amount:'9999999999.99', total_rake_funding:'9999999999.9900',
      deductions:'0.00', total_paid_by_club:'0', net_amount:'9999999999.99', retained_by_club:'9999999999.99' })];
    const { rows } = await readClubWeeklyStatements({ clubId:ID.club });
    expect(rows[0].retainedByClub).toBe('9999999999.99');
    expect(formatWeeklyChips(rows[0].retainedByClub)).toBe('9,999,999,999.99');
    state.rows = [weeklyStatementRow({ gross_amount:'10000000000.00' })];
    await expect(readClubWeeklyStatements({ clubId:ID.club })).rejects.toThrow(/Amount Is Unavailable/);
  });
  it('preserves validated date-only export windows without changing their midnight filter meaning', async () => {
    state.rows = [weeklyStatementRow()];
    const result = await FinancialExportService.fetchClubSettlements({ type:'settlement_club',clubId:ID.club,
      periodStart:'2026-09-14',periodEnd:'2026-09-15' });
    expect(result.rows).toHaveLength(1);
    expect(state.calls).toContainEqual(['gte','created_at','2026-09-14T00:00:00Z']);
    expect(state.calls).toContainEqual(['lte','created_at','2026-09-15T00:00:00Z']);
    const rowQueryStart = state.calls.findIndex(call=>call[0]==='select' && String(call[1]).includes('gross_amount::text'));
    expect(rowQueryStart).toBeGreaterThan(-1);
    const rowQuery = state.calls.slice(rowQueryStart);
    expect(rowQuery.findIndex(call=>call[0]==='lte')).toBeGreaterThan(-1);
    expect(rowQuery.findIndex(call=>call[0]==='lte')).toBeLessThan(rowQuery.findIndex(call=>call[0]==='limit'));
  });
  it.each([
    { periodStart:'2026-02-30' }, { periodEnd:'2025-02-29' }, { periodStart:'2026-13-01' },
    { periodStart:'2026-09-15',periodEnd:'2026-09-14' }, { periodStart:'' },
  ])('refuses invalid date windows before a query: %j', async window => {
    await expect(readClubWeeklyStatements({ clubId:ID.club,...window })).rejects.toThrow(/Date Window/);
    expect(state.calls).toEqual([]);
  });
  it('refuses a returned row outside the requested window instead of exporting it', async () => {
    state.rows = [weeklyStatementRow()];
    await expect(readClubWeeklyStatements({ clubId:ID.club,periodEnd:'2026-09-14' })).rejects.toThrow(/Date Scope/);
  });
  it('preserves microsecond precision when checking the requested window', async () => {
    state.rows = [weeklyStatementRow()];
    await expect(readClubWeeklyStatements({ clubId:ID.club,periodEnd:'2026-09-14T08:00:00.000000+00:00' })).rejects.toThrow(/Date Scope/);
    await expect(readClubWeeklyStatements({ clubId:ID.club,periodStart:'2026-09-14T08:00:00.000002+00:00',
      periodEnd:'2026-09-14T08:00:00.000001+00:00' })).rejects.toThrow(/Date Window/);
  });
  it.each([null, {}, 'unavailable'])('refuses malformed result %j', async data => {
    state.reply = async () => ({ data, error:null });
    await expect(readClubWeeklyStatements({ clubId:ID.club })).rejects.toThrow(/Rows Could Not Be Verified/);
  });
  it('does not translate transport errors into an empty statement list', async () => {
    state.reply = async () => ({ data:null, error:{ message:'offline' } });
    await expect(readClubWeeklyStatements({ clubId:ID.club })).rejects.toThrow(/Unavailable/);
  });
  it('refuses duplicate weekly periods and invalid bounds', async () => {
    state.rows = [weeklyStatementRow(),weeklyStatementRow({ id:ID.actor })];
    await expect(readClubWeeklyStatements({ clubId:ID.club })).rejects.toThrow(/Scope/);
    for (const limit of [0,-1,1001,NaN,1.5]) await expect(readClubWeeklyStatements({ clubId:ID.club,limit })).rejects.toThrow(/Limit/);
  });
  it('holds account ABA through alias resolution before a query can be made', async () => {
    const gate = deferred<string>(); vi.mocked(resolveClubUUID).mockReturnValueOnce(gate.promise);
    const result = readClubWeeklyStatements({ clubId:ID.club }); signIn(ID.otherActor); signIn(ID.actor); gate.resolve(ID.club);
    await expect(result).rejects.toThrow(/Account Or Club Changed/); expect(state.calls).toEqual([]);
  });
  it('discards a response after account or view retirement', async () => {
    const gate = deferred<unknown>(), started = deferred<void>(); let current = true;
    state.reply = () => { started.resolve(); return gate.promise; };
    const result = readClubWeeklyStatements({ clubId:ID.club,isCurrent:()=>current }); await started.promise;
    current = false; gate.resolve({ data:[weeklyStatementRow()],error:null });
    await expect(result).rejects.toThrow(/Account Or Club Changed/);
  });
  it('exports only bounded weekly funding, club payments and retained exact cents', async () => {
    state.rows = [weeklyStatementRow({ invoice_type:'accounting_correction' }),weeklyStatementRow()];
    const result = await FinancialExportService.fetchClubSettlements({ type:'settlement_club',clubId:ID.club,limit:7 });
    expect(result.rows).toHaveLength(1); expect(result.rows[0]).toMatchObject({ rake_funding:'100.25',paid_by_club:'60.20',retained_by_club:'40.05',export_page_size:7 });
    const csv = FinancialExportService.generateCSV(result.columns,result.rows);
    expect(csv).toContain('"Retained By Club (Chips)"'); expect(csv).toContain('"100.25","60.20","40.05"');
    expect(csv).toContain('club_weekly_summaries'); expect(csv).not.toContain('accounting_correction');
  });
  it('never downloads an export after the account changes during its read', async () => {
    const gate = deferred<unknown>(), started = deferred<void>(); state.reply = () => { started.resolve(); return gate.promise; };
    const createElement = vi.spyOn(document,'createElement');
    const result = FinancialExportService.exportCSV({ type:'settlement_club',clubId:ID.club }); await started.promise;
    signIn(ID.otherActor); signIn(ID.actor); gate.resolve({ data:[weeklyStatementRow()],error:null });
    try {
      expect(await result).toMatchObject({ success:false });
      expect(createElement.mock.calls.filter(([tag])=>tag==='a')).toEqual([]);
    } finally { createElement.mockRestore(); }
  });
  it('narrows weekly continuation by exact actor/club/microsecond tuple without changing the 50-row default', async () => {
    const boundary = { createdAt:'2026-09-14T08:00:00.000002+00:00', id:ID.invoice, clubId:ID.club, actorId:ID.actor };
    state.rows=[weeklyStatementRow()];
    const result=await readClubWeeklyStatements({clubId:ID.club,cursor:boundary});
    expect(result.limit).toBe(50);expect(result.rows).toHaveLength(1);
    expect(state.calls).toContainEqual(['or',`created_at.lt.${boundary.createdAt},and(created_at.eq.${boundary.createdAt},id.lt.${boundary.id})`]);
    state.rows=[weeklyStatementRow({created_at:boundary.createdAt})];
    await expect(readClubWeeklyStatements({clubId:ID.club,cursor:boundary})).rejects.toThrow(/Page Order/);
  });
  it('refuses cursor scope changes and filter syntax before the invoice query',async()=>{
    for(const fault of [{actorId:ID.otherActor},{clubId:ID.otherClub},{id:'x),id.neq.null'},{createdAt:'2026-09-14T08:00:00Z,or(x)'}]){
      state.calls=[];
      await expect(readClubWeeklyStatements({clubId:ID.club,cursor:{createdAt:'2026-09-14T08:00:00Z',id:ID.invoice,clubId:ID.club,actorId:ID.actor,...fault}})).rejects.toThrow(/Cursor Scope/);
      expect(state.calls).toEqual([]);
    }
  });

});
