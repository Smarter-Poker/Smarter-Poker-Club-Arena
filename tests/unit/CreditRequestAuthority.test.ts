import { beforeEach, describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn(), emit: vi.fn(),
  actor: 'owner', listeners: [] as Array<(event: any) => void> }));
vi.mock('../../src/core/IdentityDNA', () => ({ getIdentityDNAStatus: () => ({ loaded: true, authenticated: true, userId: calls.actor }) }));
vi.mock('../../src/lib/supabase', () => ({ supabase: { rpc: calls.rpc, from: calls.from } }));
vi.mock('../../src/core/MasterBus', () => ({ masterBus: { emit: calls.emit, subscribe: (_event: string, listener: (event: any) => void) => { calls.listeners.push(listener); return () => {}; } } }));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
import { creditRequestService } from '../../src/services/CreditRequestService';

function switchAccount(actor: string) {
  calls.actor = actor;
  calls.listeners.forEach(listener => listener({ payload: { isAuthenticated: true, userId: actor } }));
}

const request = {
  id: 'request', requester_id: 'requester', approver_id: 'owner', club_id: 'club',
  requested_amount: '125.25', approved_amount: '125.25', reason: 'More capacity',
  status: 'approved', decision_authority_version: 1, reviewed_by: 'owner', reviewed_at: '2026-09-15T04:00:00Z',
  created_at: '2026-09-15T03:00:00Z', reviewer_notes: null,
};
beforeEach(() => {
  vi.clearAllMocks();
  switchAccount('owner');
  calls.rpc.mockResolvedValue({ data: { success: true, replayed: false, request }, error: null });
  calls.from.mockImplementation((table: string) => {
    if (table !== 'profiles') throw new Error(`Unexpected direct table access: ${table}`);
    return { select: () => ({ in: async () => ({ data: [], error: null }) }) };
  });
});

describe('one credit request review authority', () => {
  it('sends one atomic decision with an expected account fence and no direct writes', async () => {
    await creditRequestService.approveRequest('request', 'owner');
    expect(calls.rpc).toHaveBeenCalledExactlyOnceWith('fn_review_credit_request', {
      p_request_id: 'request', p_expected_actor_id: 'owner', p_decision: 'approved', p_notes: null,
    });
    expect(calls.emit).toHaveBeenCalledWith('CREDIT_UPDATED', {
      clubId: 'club', userId: 'requester', amount: 125.25,
    });
    expect(calls.from).toHaveBeenCalledExactlyOnceWith('profiles');
  });
  it.each([0, -1, NaN, Infinity, 0.001, 90071992547409.90, 90071992547409.91])('never substitutes a falsey/invalid limit %s', async amount => {
    await expect(creditRequestService.approveRequest('request', 'owner', amount)).rejects.toThrow('Positive Credit Limit');
    expect(calls.rpc).not.toHaveBeenCalled();
  });
  it('preserves an explicit amount and notes on retry', async () => {
    calls.rpc.mockResolvedValue({ data: { success: true, replayed: true, request: { ...request, approved_amount: '20.00', reviewer_notes: 'Reviewed' } }, error: null });
    await creditRequestService.approveRequest('request', 'owner', 20, 'Reviewed');
    expect(calls.rpc).toHaveBeenCalledExactlyOnceWith('fn_review_credit_request', {
      p_request_id: 'request', p_expected_actor_id: 'owner', p_decision: 'approved', p_approved_amount: '20.00', p_notes: 'Reviewed',
    });
  });
  it.each([
    { success: false, request },
    { success: true },
    { success: true, request: { ...request, id: 'other' } },
    { success: true, request: { ...request, status: 'pending' } },
    { success: true, request: { ...request, reviewed_by: null } },
    { success: true, request: { ...request, reviewed_by: 'other-owner' } },
    { success: true, request: { ...request, decision_authority_version: null } },
    { success: true, request: { ...request, approved_amount: 125.25 } },
    { success: true, request: { ...request, approved_amount: '125.25' + '0'.repeat(129) } },
    { success: true, request: { ...request, approved_amount: '90071992547409.90', requested_amount: '90071992547409.90' } },
    { success: true, request: { ...request, approved_amount: '90071992547409.91', requested_amount: '90071992547409.91' } },
    { success: true, request: { ...request, approved_amount: null } },
    { success: true, request: { ...request, approved_amount: '125.24' } },
  ])('does not emit success for an incomplete or mismatched receipt', async data => {
    calls.rpc.mockResolvedValue({ data, error: null });
    await expect(creditRequestService.approveRequest('request', 'owner')).rejects.toThrow('Not Confirmed');
    expect(calls.emit).not.toHaveBeenCalled();
  });
  it('leaves network uncertainty visible and does not submit a second money operation', async () => {
    calls.rpc.mockResolvedValue({ data: null, error: new Error('transport unknown') });
    await expect(creditRequestService.approveRequest('request', 'owner')).rejects.toThrow('transport unknown');
    expect(calls.rpc).toHaveBeenCalledTimes(1);
    expect(calls.emit).not.toHaveBeenCalled();
  });
  it.each([['other-owner'], ['other-owner', 'owner']])('rejects a completed receipt after account transitions %j', async (...actors) => {
    let resolve!: (value: any) => void;
    calls.rpc.mockReturnValue(new Promise(done => { resolve = done; }));
    const pending = creditRequestService.approveRequest('request', 'owner');
    for (const actor of actors) switchAccount(actor);
    resolve({ data: { success: true, request }, error: null });
    await expect(pending).rejects.toThrow('May Have Committed');
    expect(calls.emit).not.toHaveBeenCalled();
    expect(calls.from).not.toHaveBeenCalled();
  });
  it('does not consume names or emit when the account changes during name lookup', async () => {
    let resolve!: (value: any) => void;
    const names = new Promise(done => { resolve = done; });
    let started!: () => void;
    const startedNames = new Promise<void>(done => { started = done; });
    calls.from.mockReturnValue({ select: () => ({ in: () => { started(); return names; } }) });
    const pending = creditRequestService.approveRequest('request', 'owner');
    await startedNames;
    switchAccount('other-owner');
    resolve({ data: [{ id: 'requester', username: 'Private Name' }], error: null });
    await expect(pending).rejects.toThrow('May Have Committed');
    expect(calls.emit).not.toHaveBeenCalled();
  });
  it('denial and cancellation use the same server authority', async () => {
    calls.rpc.mockResolvedValueOnce({ data: { success: true, request: { ...request, status: 'denied', approved_amount: null, reviewer_notes: 'Declined' } }, error: null });
    await creditRequestService.denyRequest('request', 'owner', 'Declined');
    calls.rpc.mockResolvedValueOnce({ data: { success: true, request: { ...request, status: 'cancelled', approved_amount: null, reviewed_by: 'requester' } }, error: null });
    switchAccount('requester');
    await creditRequestService.cancelRequest('request', 'requester');
    expect(calls.rpc).toHaveBeenNthCalledWith(1, 'fn_review_credit_request', { p_request_id: 'request', p_expected_actor_id: 'owner', p_decision: 'denied', p_notes: 'Declined' });
    expect(calls.rpc).toHaveBeenNthCalledWith(2, 'fn_review_credit_request', { p_request_id: 'request', p_expected_actor_id: 'requester', p_decision: 'cancelled', p_notes: null });
    expect(calls.emit).not.toHaveBeenCalled();
  });
  it('can cancel a pending legacy request with an exact zero requested amount', async () => {
    switchAccount('requester');
    calls.rpc.mockResolvedValue({ data: { success: true, request: { ...request, status: 'cancelled',
      requested_amount: '0', approved_amount: null, reviewed_by: 'requester' } }, error: null });
    await creditRequestService.cancelRequest('request', 'requester');
    expect(calls.emit).not.toHaveBeenCalled();
  });
});

describe('credit request creation and club reads', () => {
  const pendingRow = { ...request, requester_id: 'owner', approver_id: 'approver',
    status: 'pending', approved_amount: null, reviewed_by: null, reviewed_at: null,
    decision_authority_version: null };
  const intent = { clubId: 'club', approverId: 'approver', requestedAmount: 125.25, reason: 'More capacity' };
  function creation(response: Promise<any> = Promise.resolve({ data: pendingRow, error: null })) {
    const select = vi.fn((_fields: string) => ({ maybeSingle: () => response }));
    const insert = vi.fn(() => ({ select }));
    calls.from.mockImplementation((table: string) => table === 'credit_requests' ? { insert }
      : { select: () => ({ in: async () => ({ data: [], error: null }) }) });
    return { insert, select };
  }
  it('creates a pending request for the canonical user and club with exact decimal text', async () => {
    const { insert, select } = creation();
    const result = await creditRequestService.submitRequest('owner', intent);
    expect(insert).toHaveBeenCalledExactlyOnceWith({ requester_id: 'owner', approver_id: 'approver',
      club_id: 'club', requested_amount: '125.25', reason: 'More capacity', status: 'pending' });
    expect(select.mock.calls[0][0]).toContain('requested_amount::text');
    expect(select.mock.calls[0][0]).toContain('approved_amount::text');
    expect(result).toMatchObject({ clubId: 'club', requesterId: 'owner', requestedAmount: 125.25 });
    expect(calls.rpc).not.toHaveBeenCalled();
    expect(calls.emit).not.toHaveBeenCalled();
  });
  it.each([
    { ...intent, clubId: undefined }, { ...intent, approverId: '' }, { ...intent, approverId: 'owner' },
    { ...intent, requestedAmount: 0 }, { ...intent, requestedAmount: 0.001 },
  ])('refuses an incomplete creation intent before inserting', async incomplete => {
    const { insert } = creation();
    await expect(creditRequestService.submitRequest('owner', incomplete)).rejects.toThrow('Positive Credit Limit');
    expect(insert).not.toHaveBeenCalled();
  });
  it('refuses an account-mismatched creation intent before inserting', async () => {
    const { insert } = creation();
    await expect(creditRequestService.submitRequest('requester', intent)).rejects.toThrow('Sign In');
    expect(insert).not.toHaveBeenCalled();
  });
  it.each([
    null, { ...pendingRow, club_id: 'other' }, { ...pendingRow, requester_id: 'other' },
    { ...pendingRow, requested_amount: 125.25 }, { ...pendingRow, requested_amount: '125.24' },
    { ...pendingRow, status: 'approved' }, { ...pendingRow, decision_authority_version: 1 },
  ])('does not accept a missing or mismatched pending receipt', async data => {
    creation(Promise.resolve({ data, error: null }));
    await expect(creditRequestService.submitRequest('owner', intent)).rejects.toThrow('Not Confirmed');
    expect(calls.from).toHaveBeenCalledExactlyOnceWith('credit_requests');
  });
  it.each([['other-owner'], ['other-owner', 'owner']])('rejects creation completion after account transitions %j', async (...actors) => {
    let resolve!: (value: any) => void;
    creation(new Promise(done => { resolve = done; }));
    const pending = creditRequestService.submitRequest('owner', intent);
    for (const actor of actors) switchAccount(actor);
    resolve({ data: pendingRow, error: null });
    await expect(pending).rejects.toThrow('May Have Committed');
    expect(calls.from).toHaveBeenCalledExactlyOnceWith('credit_requests');
  });
  it('rejects creation after an account switch during name resolution', async () => {
    creation();
    let resolve!: (value: any) => void;
    let started!: () => void;
    const names = new Promise(done => { resolve = done; });
    const startedNames = new Promise<void>(done => { started = done; });
    calls.from.mockReturnValueOnce({ insert: () => ({ select: () => ({ maybeSingle: async () => ({ data: pendingRow, error: null }) }) }) })
      .mockReturnValueOnce({ select: () => ({ in: () => { started(); return names; } }) });
    const pending = creditRequestService.submitRequest('owner', intent);
    await startedNames;
    switchAccount('other-owner');
    resolve({ data: [{ id: 'owner', username: 'Private Name' }], error: null });
    await expect(pending).rejects.toThrow('May Have Committed');
    expect(calls.emit).not.toHaveBeenCalled();
  });
  function reading(rows: any[]) {
    const operations: unknown[][] = [];
    const query: any = {};
    for (const method of ['select', 'eq', 'order']) query[method] = (...args: unknown[]) => { operations.push([method, ...args]); return query; };
    query.limit = (...args: unknown[]) => { operations.push(['limit', ...args]); return Promise.resolve({ data: rows, error: null }); };
    calls.from.mockImplementation((table: string) => table === 'credit_requests' ? query
      : { select: () => ({ in: async () => ({ data: [], error: null }) }) });
    return operations;
  }
  it.each(['getMyRequests', 'getRequestsForApprover'] as const)('scopes %s to the requested club before order and limit', async method => {
    const operations = reading([pendingRow]);
    const rows = await creditRequestService[method]('owner', 'club');
    const clubFilter = operations.findIndex(operation => operation[0] === 'eq' && operation[1] === 'club_id');
    expect(operations[clubFilter]).toEqual(['eq', 'club_id', 'club']);
    expect(clubFilter).toBeLessThan(operations.findIndex(operation => operation[0] === 'order'));
    expect(clubFilter).toBeLessThan(operations.findIndex(operation => operation[0] === 'limit'));
    expect(operations[0][1]).toContain('requested_amount::text');
    expect(rows[0].requestedAmount).toBe(125.25);
  });
  it.each([125.25, '90071992547409.90', '90071992547409.91', '0.001', null])('rejects an inexact reader amount %s', async requestedAmount => {
    reading([{ ...pendingRow, requested_amount: requestedAmount }]);
    await expect(creditRequestService.getMyRequests('owner', 'club')).rejects.toThrow('Not Confirmed');
  });
  it('lets the current manager read pending requests addressed to an earlier manager', async () => {
    const operations = reading([{ ...pendingRow, approver_id: 'former-owner' }]);
    const rows = await creditRequestService.getPendingForClub('club', 'owner');
    expect(rows[0].approverId).toBe('former-owner');
    expect(operations).toContainEqual(['eq', 'club_id', 'club']);
    expect(operations).toContainEqual(['eq', 'status', 'pending']);
    expect(operations.some(operation => operation[0] === 'eq' && operation[1] === 'approver_id')).toBe(false);
  });
  it.each([{ ...pendingRow, club_id: 'other' }, { ...pendingRow, status: 'approved' }])
  ('rejects a manager inbox response outside its pending club scope', async row => {
    reading([row]);
    await expect(creditRequestService.getPendingForClub('club', 'owner')).rejects.toThrow('Not Confirmed');
    expect(calls.from).toHaveBeenCalledExactlyOnceWith('credit_requests');
  });
  it.each([['other'], ['other', 'owner']])('rejects a manager inbox result after account transitions %j', async (...actors) => {
    let resolve!: (value: any) => void;
    const result = new Promise(done => { resolve = done; });
    const query: any = {};
    for (const operation of ['select', 'eq', 'order']) query[operation] = () => query;
    query.limit = () => result;
    calls.from.mockReturnValue(query);
    const pending = creditRequestService.getPendingForClub('club', 'owner');
    for (const actor of actors) switchAccount(actor);
    resolve({ data: [pendingRow], error: null });
    await expect(pending).rejects.toThrow('Account Changed');
    expect(calls.from).toHaveBeenCalledExactlyOnceWith('credit_requests');
  });
});
