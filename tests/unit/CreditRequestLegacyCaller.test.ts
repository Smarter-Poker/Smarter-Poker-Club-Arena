import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ actor: 'requester', listeners: [] as Array<(event: any) => void>,
  from: vi.fn(), submit: vi.fn(), queries: [] as unknown[][] }));
vi.mock('../../src/core/IdentityDNA', () => ({ getIdentityDNAStatus: () => ({ loaded: true, authenticated: true, userId: m.actor }) }));
vi.mock('../../src/core/MasterBus', () => ({ masterBus: { emit: vi.fn(), subscribe: (_event: string, callback: (event: any) => void) => { m.listeners.push(callback); return () => {}; } } }));
vi.mock('../../src/lib/supabase', () => ({ supabase: { from: m.from, rpc: vi.fn() } }));
vi.mock('../../src/services/CreditRequestService', () => ({ creditRequestService: { submitRequest: m.submit } }));
vi.mock('../../src/services/WalletService', () => ({ WalletService: {} }));
vi.mock('../../src/services/SettlementService', () => ({ SettlementService: {} }));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
vi.mock('../../src/utils/clubIdResolver', () => ({ resolveClubUUID: vi.fn() }));
import { CreditService, type CreditAccount } from '../../src/services/CreditService';

const account: CreditAccount = { agentId: 'agent', userId: 'requester', clubId: 'club',
  agentName: 'Requester', creditLimit: 100, currentBalance: 50, isPrepaid: false,
  status: 'good_standing', utilizationPercent: 0, nextSettlementDate: '2026-09-21' };
const receipt = { id: 'request', requesterId: 'requester', approverId: 'owner', clubId: 'club',
  requestedAmount: 125.25, status: 'pending', reason: 'More capacity', createdAt: '2026-09-15T04:00:00Z' };
function switchAccount(actor: string) {
  m.actor = actor;
  m.listeners.forEach(listener => listener({ payload: { isAuthenticated: true, userId: actor } }));
}
function owners(response: Promise<any>) {
  m.from.mockImplementation((table: string) => {
    m.queries.push(['from', table]);
    if (table !== 'clubs') throw new Error('Legacy creation attempted a direct request write');
    return { select: (columns: string) => { m.queries.push(['select', columns]);
      return { eq: (...args: unknown[]) => { m.queries.push(['eq', ...args]);
        return { limit: (count: number) => { m.queries.push(['limit', count]); return response; } }; } }; } };
  });
}
beforeEach(() => {
  vi.clearAllMocks();m.queries = [];
  switchAccount('requester');
  vi.spyOn(CreditService, 'getCreditAccount').mockResolvedValue(account);
  owners(Promise.resolve({ data: [{ id: 'club', owner_id: 'owner' }], error: null }));
  m.submit.mockResolvedValue(receipt);
});
afterEach(() => vi.restoreAllMocks());

describe('legacy credit creation shares the canonical service', () => {
  it('resolves the exact club owner and delegates the user identity once', async () => {
    const result = await CreditService.requestCreditIncrease('agent', 125.25, 'More capacity');
    expect(m.queries).toEqual([['from', 'clubs'], ['select', 'id, owner_id'], ['eq', 'id', 'club'], ['limit', 2]]);
    expect(m.submit).toHaveBeenCalledExactlyOnceWith('requester', { clubId: 'club', approverId: 'owner', requestedAmount: 125.25, reason: 'More capacity' });
    expect(result).toMatchObject({ id: 'request', agentId: 'agent', requestedLimit: 125.25, currentLimit: 100, status: 'pending' });
  });
  it.each([[], [{ id: 'club', owner_id: null }], [{ id: 'club', owner_id: 'requester' }],
    [{ id: 'other', owner_id: 'owner' }], [{ id: 'club', owner_id: 'owner' }, { id: 'club', owner_id: 'other' }]])
  ('refuses missing, self, wrong-club or ambiguous owners', async (...rows) => {
    owners(Promise.resolve({ data: rows, error: null }));
    await expect(CreditService.requestCreditIncrease('agent', 125.25, 'More capacity')).rejects.toThrow('Different Current Club Owner');
    expect(m.submit).not.toHaveBeenCalled();
  });
  it('refuses a different user account before resolving the owner', async () => {
    vi.mocked(CreditService.getCreditAccount).mockResolvedValue({ ...account, userId: 'other' });
    await expect(CreditService.requestCreditIncrease('agent', 125.25, 'More capacity')).rejects.toThrow('Does Not Match');
    expect(m.from).not.toHaveBeenCalled();expect(m.submit).not.toHaveBeenCalled();
  });
  it.each([['other'], ['other', 'requester']])('refuses an account change during account resolution %j', async (...actors) => {
    let resolve!: (value: CreditAccount) => void;
    vi.mocked(CreditService.getCreditAccount).mockReturnValue(new Promise(done => { resolve = done; }));
    const pending = CreditService.requestCreditIncrease('agent', 125.25, 'More capacity');
    for (const actor of actors) switchAccount(actor);
    resolve(account);
    await expect(pending).rejects.toThrow('May Have Committed');
    expect(m.from).not.toHaveBeenCalled();expect(m.submit).not.toHaveBeenCalled();
  });
  it('refuses an account change during owner resolution before creating', async () => {
    let resolve!: (value: any) => void;
    let started!: () => void;
    const startedOwner = new Promise<void>(done => { started = done; });
    owners(new Promise(done => { resolve = done; }));
    const original = m.from.getMockImplementation()!;
    m.from.mockImplementation((table: string) => { const query = original(table);started();return query; });
    const pending = CreditService.requestCreditIncrease('agent', 125.25, 'More capacity');
    await startedOwner;switchAccount('other');
    resolve({ data: [{ id: 'club', owner_id: 'owner' }], error: null });
    await expect(pending).rejects.toThrow('May Have Committed');expect(m.submit).not.toHaveBeenCalled();
  });
  it('does not return a creation receipt after an account change', async () => {
    let resolve!: (value: any) => void;let started!: () => void;
    const startedCreation = new Promise<void>(done => { started = done; });
    m.submit.mockImplementation(() => { started();return new Promise(done => { resolve = done; }); });
    const pending = CreditService.requestCreditIncrease('agent', 125.25, 'More capacity');
    await startedCreation;switchAccount('other');resolve(receipt);
    await expect(pending).rejects.toThrow('May Have Committed');
    expect(m.submit).toHaveBeenCalledTimes(1);
  });
});
