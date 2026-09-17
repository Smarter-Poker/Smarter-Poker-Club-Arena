import {beforeEach,describe,expect,it,vi} from 'vitest';
import {OBSERVER_ID as ID,observationRow,recordedPeriod} from '../helpers/accountingObservation';
const m=vi.hoisted(()=>({id:null as string|null,handlers:new Set<(event:any)=>void>(),rpc:vi.fn(),rows:[] as unknown[],calls:[] as unknown[][]}));
vi.mock('../../src/core/IdentityDNA',()=>({getIdentityDNAStatus:()=>({loaded:!!m.id,authenticated:!!m.id,userId:m.id})}));
vi.mock('../../src/core/MasterBus',()=>({masterBus:{emit:vi.fn(),subscribe:(name:string,fn:(event:any)=>void)=>{if(name==='AUTH_STATE_CHANGED')m.handlers.add(fn);return()=>m.handlers.delete(fn);}}}));
vi.mock('../../src/services/UnionService',()=>({UnionService:{getUnions:vi.fn(async()=>[]),getUnion:vi.fn(),getUnionClubs:vi.fn(async()=>[])}}));
vi.mock('../../src/utils/errorReporter',()=>({reportError:vi.fn()}));
vi.mock('../../src/lib/supabase',()=>({supabase:{rpc:m.rpc,from:(table:string)=>{
  const q:any={};m.calls.push(['from',table]);
  for(const method of ['select','eq','is','order','limit'])q[method]=(...args:unknown[])=>{m.calls.push([method,...args]);return q;};
  q.then=(yes:any,no:any)=>Promise.resolve({data:m.rows,error:null}).then(yes,no);return q;
}}}));
import {useUnionStore} from '../../src/stores/useUnionStore';
import {UnionService} from '../../src/services/UnionService';
function auth(id:string|null){m.id=id;for(const fn of [...m.handlers])fn({payload:{isAuthenticated:!!id,userId:id}});}
beforeEach(()=>{vi.clearAllMocks();m.rows=[recordedPeriod()];m.calls=[];auth(null);auth(ID.actor);});
describe('union accounting store',()=>{
  it('retains tab preference and refuses old browser payer/getter calls',async()=>{
    useUnionStore.getState().setActiveTab('clubs');expect(useUnionStore.getState().activeTab).toBe('clubs');
    await expect(useUnionStore.getState().loadCurrentPeriod()).rejects.toMatchObject({code:'automatic_weekly_accounting_only'});
    await expect(useUnionStore.getState().closePeriod(ID.period)).rejects.toMatchObject({code:'automatic_weekly_accounting_only'});
    await expect(useUnionStore.getState().executeMondayPayouts(ID.period)).rejects.toMatchObject({code:'automatic_weekly_accounting_only'});
    await expect(useUnionStore.getState().loadPeriodHistory()).rejects.toThrow();expect(m.rpc).not.toHaveBeenCalled();
  });
  it('reads exact union status and history and never fabricates a current global period',async()=>{
    m.rpc.mockResolvedValue({data:observationRow(),error:null});
    await useUnionStore.getState().loadAccounting(ID.union,{periodStart:'2026-09-07T07:00:00Z',periodEnd:'2026-09-14T07:00:00Z'});
    expect(useUnionStore.getState()).toMatchObject({accountingScopeId:ID.union,accountingObservation:{posted:true},currentPeriod:null,accountingUnavailable:false,periodHistory:[{id:ID.period}]});
    expect(m.calls).toContainEqual(['eq','union_id',ID.union]);expect(m.calls).toContainEqual(['is','club_id',null]);
    expect(m.rpc.mock.calls.map(([name])=>name)).toEqual(['fn_accounting_run_observation_v1']);
  });
  it('keeps unavailable status distinct from an empty history',async()=>{
    m.rpc.mockResolvedValue({data:null,error:{message:'refused'}});m.rows=[];
    await useUnionStore.getState().loadAccounting(ID.union);
    expect(useUnionStore.getState()).toMatchObject({accountingObservation:null,accountingUnavailable:true,periodHistory:[],isLoadingSettlement:false});
  });
  it('does not allow a late A result to overwrite B then A refresh',async()=>{
    let resolve!:(x:unknown)=>void;
    m.rpc.mockReturnValueOnce(new Promise(yes=>{resolve=yes;})).mockResolvedValue({data:null,error:{message:'refused'}});
    const old=useUnionStore.getState().loadAccounting(ID.union);
    await useUnionStore.getState().loadAccounting(ID.otherUnion);
    await useUnionStore.getState().loadAccounting(ID.union);
    resolve({data:observationRow(),error:null});await old;
    expect(useUnionStore.getState()).toMatchObject({accountingScopeId:ID.union,accountingObservation:null,accountingUnavailable:true});
  });
  it('clears stored records and invalidates old account ABA completion',async()=>{
    let resolve!:(x:unknown)=>void;m.rpc.mockReturnValueOnce(new Promise(yes=>{resolve=yes;}));
    const pending=useUnionStore.getState().loadAccounting(ID.union);
    auth(ID.otherActor);auth(ID.actor);resolve({data:observationRow(),error:null});await pending;
    expect(useUnionStore.getState()).toMatchObject({accountingScopeId:null,accountingObservation:null,periodHistory:[],currentPeriod:null});
  });
  it('keeps union membership reads from an older route out of the new route',async()=>{
    let resolve!:(x:any)=>void;
    vi.mocked(UnionService.getUnion).mockReturnValueOnce(new Promise(yes=>{resolve=yes;})).mockResolvedValueOnce({id:ID.otherUnion} as any);
    const old=useUnionStore.getState().loadUnion(ID.union);await useUnionStore.getState().loadUnion(ID.otherUnion);
    resolve({id:ID.union});await old;expect(useUnionStore.getState().activeUnion?.id).toBe(ID.otherUnion);
  });
  it('keeps the newest same-union club roster when concurrent refreshes finish out of order',async()=>{
    useUnionStore.setState({activeUnion:{id:ID.union} as any});
    let resolve!:(x:any)=>void;
    vi.mocked(UnionService.getUnionClubs).mockReturnValueOnce(new Promise(yes=>{resolve=yes;})).mockResolvedValueOnce([{clubId:ID.club}] as any);
    const old=useUnionStore.getState().loadUnionClubs(ID.union);await useUnionStore.getState().loadUnionClubs(ID.union);
    resolve([{clubId:'old'}]);await old;expect(useUnionStore.getState().activeUnionClubs).toEqual([{clubId:ID.club}]);
  });

  it('invalidates the captured accounting predicate synchronously when another union starts loading',async()=>{
    m.rpc.mockResolvedValue({data:observationRow(),error:null});
    await useUnionStore.getState().loadAccounting(ID.union,{periodStart:'2026-09-07T07:00:00Z',periodEnd:'2026-09-14T07:00:00Z'});
    const captured=useUnionStore.getState().accountingCurrent!;expect(captured()).toBe(true);
    let resolve!:(x:any)=>void;vi.mocked(UnionService.getUnion).mockReturnValueOnce(new Promise(yes=>{resolve=yes;}));
    const pending=useUnionStore.getState().loadUnion(ID.otherUnion);
    expect(captured()).toBe(false);expect(useUnionStore.getState()).toMatchObject({accountingScopeId:null,accountingObservation:null,periodHistory:[],consolidatedReport:null});
    resolve({id:ID.otherUnion});await pending;
  });

  it('does not strand a concurrent same-union observer during a roster refresh',async()=>{
    let resolve!:(x:unknown)=>void;m.rpc.mockReturnValueOnce(new Promise(yes=>{resolve=yes;}));
    const pending=useUnionStore.getState().loadAccounting(ID.union,{periodStart:'2026-09-07T07:00:00Z',periodEnd:'2026-09-14T07:00:00Z'});
    const captured=useUnionStore.getState().accountingCurrent!;
    vi.mocked(UnionService.getUnion).mockResolvedValueOnce({id:ID.union} as any);
    await useUnionStore.getState().loadUnion(ID.union);expect(captured()).toBe(true);
    resolve({data:observationRow(),error:null});await pending;
    expect(useUnionStore.getState().accountingObservation?.posted).toBe(true);
  });

});
