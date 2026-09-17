import { beforeEach,afterEach,describe,it,expect,vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { CREDIT_ID as ID,creditSnapshot,creditEnvelope } from '../helpers/creditReductionReceipt';
const auth = vi.hoisted(() => ({ user:null as string | null, handlers:new Set<(event:any) => void>() }));
vi.mock('../../src/core/IdentityDNA',() => ({ getIdentityDNAStatus:() => ({ loaded:true,authenticated:!!auth.user,userId:auth.user }) }));
vi.mock('../../src/core/MasterBus',() => ({ masterBus:{ emit:vi.fn(), subscribe:vi.fn((name,handler) => {
  if (name === 'AUTH_STATE_CHANGED') auth.handlers.add(handler); return () => auth.handlers.delete(handler);
}) } }));
vi.mock('../../src/lib/supabase',() => ({ supabase:{ rpc:vi.fn(),from:vi.fn() } }));
vi.mock('../../src/utils/errorReporter',() => ({ reportError:vi.fn() }));
vi.mock('../../src/utils/clubIdResolver',() => ({ resolveClubUUID:async (id:string) => id }));
vi.mock('../../src/utils/strictClubIdResolver',() => ({ resolveClubUUIDStrict:vi.fn() }));
import { supabase } from '../../src/lib/supabase';
import { masterBus } from '../../src/core/MasterBus';
import { resolveClubUUIDStrict } from '../../src/utils/strictClubIdResolver';
import { prepareCreditReduction,captureCreditReduction,recoverCreditReduction,runCreditReduction,
  listPendingCreditReductions,capturePendingCreditReduction,retireCreditReduction } from '../../src/services/CreditReductionOperation';
const transport = vi.mocked(supabase.rpc), lookup = vi.fn(), apply = vi.fn(), retire = vi.fn(), snapshot = vi.fn();
const input = { actorId:ID.actor,clubId:ID.club,targetUserId:ID.target,amount:'250.00',reason:null,
  isCurrent:() => true,receiptViewCurrent:() => true };
const indexPrefix = 'smarter-poker:credit-reduction-pending:v1:';
function signIn(user:string|null) {
  auth.user = user; for (const handler of auth.handlers) handler({ payload:{ isAuthenticated:!!user,userId:user } });
}
function deferred<T>() {
  let resolve!:(value:T) => void, reject!:(error:Error) => void;
  const promise = new Promise<T>((yes,no) => { resolve = yes; reject = no; }); return { promise,resolve,reject };
}
function allStorage() { return Array.from({ length:localStorage.length },(_,i) => [localStorage.key(i)!,localStorage.getItem(localStorage.key(i)!)!]); }
function index() { return JSON.parse(allStorage().find(([key]) => key.startsWith(indexPrefix))![1]); }
async function start(value = input) { return captureCreditReduction(await prepareCreditReduction(value)); }
async function pendingStart() {
  const rows = await listPendingCreditReductions(ID.actor,ID.club,() => true);
  expect(rows).toHaveLength(1); return capturePendingCreditReduction(rows[0]);
}
beforeEach(() => {
  signIn(null); signIn(ID.actor); localStorage.clear(); sessionStorage.clear();
  vi.stubGlobal('crypto',webcrypto); vi.mocked(masterBus.emit).mockClear(); vi.mocked(supabase.from).mockClear();
  vi.mocked(resolveClubUUIDStrict).mockReset().mockImplementation(async id => id);
  snapshot.mockReset().mockImplementation(async () => ({ data:creditSnapshot(),error:null }));
  lookup.mockReset().mockImplementation(async (_name,args) => ({ data:creditEnvelope(args),error:null }));
  apply.mockReset().mockImplementation(async (_name,args) => ({ data:creditEnvelope(args,'recorded',{},false),error:null }));
  retire.mockReset().mockImplementation(async (_name,args) => ({ data:creditEnvelope(args,'retired',{},false),error:null }));
  transport.mockReset().mockImplementation((name,args) => {
    const handlers: Record<string, typeof snapshot> = {
    fn_agent_credit_reduction_snapshot_v1:snapshot,fn_agent_credit_reduction_receipt_v1:lookup,
    fn_reduce_agent_credit_v1:apply,fn_retire_agent_credit_reduction_v1:retire,
    }; return (handlers[name] ?? (() => { throw new Error('Unexpected RPC'); }))(name,args);
  });
  const locks = new Map<string,Promise<unknown>>();
  Object.defineProperty(navigator,'locks',{ configurable:true,value:{ request:(key:string,_options:unknown,fn:() => unknown) => {
    const next = (locks.get(key) ?? Promise.resolve()).then(fn); locks.set(key,next.catch(() => undefined)); return next;
  } } });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

// Real operation/coordinator/identity/receipt code with a serialized Web Locks shim.
// These authored cases are not native browser multi-tab or database qualification.
describe('credit reduction original-operation recovery',() => {
  it('applies the exact prepared text intent and reports actual reduction with one invalidation and no value overwrite',async () => {
    const captured = await start();
    const result = await runCreditReduction(captured);
    expect(result.state).toBe('recorded'); expect(result.receipt?.applied_reduction).toBe('100.00');
    expect(apply).toHaveBeenCalledExactlyOnceWith('fn_reduce_agent_credit_v1',{
      p_expected_actor_id:ID.actor,p_operation_id:captured.operationId,p_club_id:ID.club,p_agent_id:ID.agent,p_target_user_id:ID.target,
      p_requested_reduction:'250.00',p_expected_credit_limit:'100.00',p_expected_credit_used:'0.00',p_expected_is_prepaid:false,
      p_expected_revision:'0',p_reason:null,
    });
    expect(masterBus.emit).toHaveBeenCalledExactlyOnceWith('CREDIT_UPDATED',{ clubId:ID.club,userId:ID.target });
    expect(supabase.from).not.toHaveBeenCalled(); expect(index().records[0].state).toBe('settled');
  });
  it('keeps an unknown stable lane across changed amount, reason, revision and agent-row replacement',async () => {
    apply.mockRejectedValueOnce(new Error('lost'));
    const original = await start(); await expect(runCreditReduction(original)).rejects.toThrow(/Lost/);
    for (const changed of [{ ...input,amount:'1.00' },{ ...input,reason:'different' }]) {
      await expect(prepareCreditReduction(changed)).rejects.toThrow(/Pending Credit Change/);
    }
    snapshot.mockResolvedValueOnce({ data:creditSnapshot({ control_revision:'1' }),error:null });
    await expect(prepareCreditReduction(input)).rejects.toThrow(/Pending Credit Change/);
    snapshot.mockResolvedValueOnce({ data:creditSnapshot({ agent_id:ID.receipt }),error:null });
    await expect(prepareCreditReduction(input)).rejects.toThrow(/Pending Credit Change/);
    expect(index().records).toHaveLength(1); expect(index().records[0].reference.operationId).toBe(original.operationId);
    expect(apply).toHaveBeenCalledTimes(1);
  });
  it('allows changed drafts before admission but refuses a competing accepted lane without replacing its operation',async () => {
    const a = await start(), b = await start({ ...input,amount:'1.00' });
    expect(localStorage.getItem(allStorage().find(([key]) => key.startsWith(indexPrefix))?.[0] ?? 'absent')).toBeNull();
    await recoverCreditReduction(a);
    await expect(recoverCreditReduction(b)).rejects.toThrow(/Pending Credit Change/);
    expect(index().records).toHaveLength(1); expect(lookup).toHaveBeenCalledTimes(1);
  });
  it('persists opaque references only, with no amounts, notes, target or actor plaintext',async () => {
    const privateNote = 'Confidential agent arrangement';
    const captured = await start({ ...input,reason:privateNote }); await recoverCreditReduction(captured);
    const bytes = JSON.stringify(allStorage());
    for (const value of [privateNote,ID.actor,ID.club,ID.agent,ID.target,'250.00','100.00']) expect(bytes).not.toContain(value);
    expect(bytes).toContain(captured.operationId);
  });
  it('reloads an original receipt without querying a now-deleted target and never dispatches from a receipt-only handle',async () => {
    apply.mockRejectedValueOnce(new Error('lost')); const original = await start();
    await expect(runCreditReduction(original)).rejects.toThrow(); sessionStorage.clear();
    snapshot.mockRejectedValue(new Error('Agent deleted'));
    const check = await pendingStart();
    lookup.mockImplementationOnce(async (_name,args) => ({ data:creditEnvelope(args,'recorded'),error:null }));
    expect((await runCreditReduction(check)).receipt?.after_limit).toBe('0.00');
    expect(check.operationId).toBe(original.operationId); expect(snapshot).toHaveBeenCalledTimes(1); expect(apply).toHaveBeenCalledTimes(1);
  });
  it('does not clear or dispatch a receipt-only absent operation, even on repeated explicit checks',async () => {
    await recoverCreditReduction(await start()); sessionStorage.clear();
    const check = await pendingStart(); expect((await recoverCreditReduction(check)).state).toBe('absent');
    await expect(runCreditReduction(check)).rejects.toThrow(/Only Be Checked Or Cancelled/);
    expect((await recoverCreditReduction(await pendingStart())).state).toBe('absent');
    expect(apply).not.toHaveBeenCalled(); expect(index().records[0].state).toBe('active');
  });
  it('retains malformed, failed and unknown lookups instead of turning them into absent or a new operation',async () => {
    const captured = await start(); lookup.mockResolvedValueOnce({ data:{ found:false },error:null });
    await expect(runCreditReduction(captured)).rejects.toThrow(/Unconfirmed/);
    await expect(runCreditReduction(captured)).rejects.toThrow(/Unconfirmed/);
    expect(lookup).toHaveBeenCalledTimes(1); expect(apply).not.toHaveBeenCalled();
    lookup.mockRejectedValueOnce(new Error('lost'));
    await expect(recoverCreditReduction(await pendingStart())).rejects.toThrow(/Lost/);
    expect(index().records[0].state).toBe('active');
  });
  it('validates the full retained digest on reload, including exact NULL versus empty reason',async () => {
    await recoverCreditReduction(await start()); sessionStorage.clear();
    lookup.mockImplementationOnce(async (_name,args) => ({ data:creditEnvelope(args,'recorded',{ reason:'' }),error:null }));
    await expect(recoverCreditReduction(await pendingStart())).rejects.toThrow(/Unconfirmed/);
    expect(index().records[0].state).toBe('active'); expect(masterBus.emit).not.toHaveBeenCalled();
  });
  it('only canonical retirement releases an absent lane, while an applied retirement response preserves the real receipt',async () => {
    const original = await start(); await recoverCreditReduction(original);
    const result = await retireCreditReduction(await pendingStart());
    expect(result.state).toBe('retired'); expect(retire.mock.calls[0][1].p_operation_id).toBe(original.operationId);
    expect(index().records[0].state).toBe('settled');
    const newer = await start(); expect(newer.operationId).not.toBe(original.operationId);
    await recoverCreditReduction(newer);
    retire.mockImplementationOnce(async (_name,args) => ({ data:creditEnvelope(args,'recorded'),error:null }));
    expect((await retireCreditReduction(await pendingStart())).state).toBe('recorded');
    expect(apply).not.toHaveBeenCalled();
  });
  it('does not resume dispatch after an explicit retirement starts, including its uncertain failure',async () => {
    const original = await start(); await recoverCreditReduction(original);
    const delayed = deferred<any>(); retire.mockReturnValueOnce(delayed.promise);
    const cancelling = retireCreditReduction(original);
    await vi.waitFor(() => expect(retire).toHaveBeenCalledTimes(1));
    await expect(runCreditReduction(original)).rejects.toThrow(/Only Be Checked Or Cancelled/);
    delayed.reject(new Error('lost')); await expect(cancelling).rejects.toThrow(/Lost/);
    await expect(runCreditReduction(original)).rejects.toThrow(/Only Be Checked Or Cancelled/);
    expect(apply).not.toHaveBeenCalled(); expect(index().records[0].state).toBe('active');
  });
  it('refuses acknowledged-generation plus absent contradiction without another apply',async () => {
    const preparation = await prepareCreditReduction(input);
    await runCreditReduction(captureCreditReduction(preparation));
    await expect(runCreditReduction(captureCreditReduction(preparation))).rejects.toThrow(/Unconfirmed/);
    expect(apply).toHaveBeenCalledTimes(1);
  });
  it('keeps a known result when local acknowledgment fails, with the lane retained for receipt recovery',async () => {
    const captured = await start(); const originalSet = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype,'setItem').mockImplementation(function (this:Storage,key,value) {
      if (key.startsWith(indexPrefix) && value.includes('"settled"')) throw new Error('quota');
      return originalSet.call(this,key,value);
    });
    expect((await runCreditReduction(captured)).state).toBe('recorded');
    expect(index().records[0].state).toBe('active');
    await expect(prepareCreditReduction({ ...input,amount:'1.00' })).rejects.toThrow(/Pending Credit Change/);
  });
  it('stages discoverable identity before admission and can retire it after a partial storage failure',async () => {
    const captured = await start(); const originalSet = Storage.prototype.setItem;
    const spy = vi.spyOn(Storage.prototype,'setItem').mockImplementation(function (this:Storage,key,value) {
      if (key.startsWith('smarter-poker:credit-reduction-generations:') && value.includes('"startId"')) throw new Error('quota');
      return originalSet.call(this,key,value);
    });
    await expect(recoverCreditReduction(captured)).rejects.toThrow('quota');
    expect(index().records[0].state).toBe('initializing'); expect(lookup).not.toHaveBeenCalled(); spy.mockRestore();
    expect((await retireCreditReduction(await pendingStart())).state).toBe('retired');
    expect(retire.mock.calls[0][1].p_operation_id).toBe(captured.operationId);
  });
  it('binds before alias resolution and retires actor ABA without applying or consuming stale receipts',async () => {
    const alias = deferred<string>(); vi.mocked(resolveClubUUIDStrict).mockReturnValueOnce(alias.promise);
    const preparation = prepareCreditReduction({ ...input,clubId:'alias' });
    signIn(ID.target); signIn(ID.actor); alias.resolve(ID.club);
    await expect(preparation).rejects.toThrow(/Changed/); expect(snapshot).not.toHaveBeenCalled();
    const captured = await start(); const delayed = deferred<any>(); lookup.mockReturnValueOnce(delayed.promise);
    const check = recoverCreditReduction(captured); await vi.waitFor(() => expect(lookup).toHaveBeenCalledTimes(1));
    signIn(null); signIn(ID.actor); delayed.resolve({ data:creditEnvelope(lookup.mock.calls[0][1],'recorded'),error:null });
    await expect(check).rejects.toThrow(/Changed/); expect(apply).not.toHaveBeenCalled(); expect(masterBus.emit).not.toHaveBeenCalled();
    expect(index().records[0].state).toBe('active');
  });
  it('pins form and club ABA through a sticky caller generation before a pending lookup returns',async () => {
    let revision = 0; const captured = await start({ ...input,isCurrent:() => revision === 0 });
    const delayed = deferred<any>(); lookup.mockReturnValueOnce(delayed.promise);
    const running = runCreditReduction(captured); await vi.waitFor(() => expect(lookup).toHaveBeenCalledTimes(1));
    revision += 2; delayed.resolve({ data:creditEnvelope(lookup.mock.calls[0][1]),error:null });
    await expect(running).rejects.toThrow(/Changed/); expect(apply).not.toHaveBeenCalled();
  });
  it('coalesces overlapping same-operation applies while a second tab keeps the original identity',async () => {
    const prepared = await prepareCreditReduction(input), first = captureCreditReduction(prepared);
    const delayed = deferred<any>(); apply.mockReturnValueOnce(delayed.promise);
    const running = runCreditReduction(first); await vi.waitFor(() => expect(apply).toHaveBeenCalledTimes(1));
    sessionStorage.clear(); const second = await start(); expect(second.operationId).toBe(first.operationId);
    const overlap = runCreditReduction(second); await vi.waitFor(() => expect(lookup).toHaveBeenCalledTimes(2));
    expect(apply).toHaveBeenCalledTimes(1);
    delayed.resolve({ data:creditEnvelope(apply.mock.calls[0][1],'recorded',{},false),error:null });
    expect((await running).state).toBe('recorded'); expect((await overlap).state).toBe('recorded');
    expect(index().records).toHaveLength(1);
    expect(Array.from({ length:sessionStorage.length },(_,i) => sessionStorage.key(i))
      .filter(key => key?.startsWith('smarter-poker:credit-reduction-generations:'))).toHaveLength(0);
  });
});
