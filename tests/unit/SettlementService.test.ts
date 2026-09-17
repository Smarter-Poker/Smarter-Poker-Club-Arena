import {beforeEach,describe,expect,it,vi} from 'vitest';
import {OBSERVER_ID as ID,recordedPeriod} from '../helpers/accountingObservation';
const m=vi.hoisted(()=>({id:null as string|null,handlers:new Set<(event:any)=>void>(),rpc:vi.fn(),rows:[] as unknown[],calls:[] as unknown[][],reply:null as null|Promise<any>}));
vi.mock('../../src/core/IdentityDNA',()=>({getIdentityDNAStatus:()=>({loaded:!!m.id,authenticated:!!m.id,userId:m.id})}));
vi.mock('../../src/core/MasterBus',()=>({masterBus:{emit:vi.fn(),subscribe:(name:string,fn:(event:any)=>void)=>{if(name==='AUTH_STATE_CHANGED')m.handlers.add(fn);return()=>m.handlers.delete(fn);}}}));
vi.mock('../../src/utils/errorReporter',()=>({reportError:vi.fn()}));
vi.mock('../../src/utils/clubIdResolver',()=>({resolveClubUUID:async(id:string)=>id}));
vi.mock('../../src/lib/supabase',()=>({supabase:{rpc:m.rpc,from:(table:string)=>{
  m.calls.push(['from',table]);const q:any={};
  for(const method of ['select','eq','is','order','limit'])q[method]=(...args:unknown[])=>{m.calls.push([method,...args]);return q;};
  q.then=(yes:any,no:any)=>(m.reply??Promise.resolve({data:m.rows,error:null})).then(yes,no);return q;
}}}));
import SettlementService from '../../src/services/SettlementService';
function auth(id:string|null){m.id=id;for(const fn of m.handlers)fn({payload:{isAuthenticated:!!id,userId:id}});}
const scope={scopeKind:'union' as const,scopeId:ID.union,actorId:ID.actor};
beforeEach(()=>{m.rpc.mockReset();m.rows=[recordedPeriod()];m.calls=[];m.reply=null;auth(null);auth(ID.actor);});
describe('browser settlement authority retirement',()=>{
  it('all former getter and payer entrypoints explicitly refuse without an RPC',async()=>{
    for(const invoke of [()=>SettlementService.getCurrentPeriod(),()=>SettlementService.getCurrentPeriodForClub(ID.club),
      ()=>SettlementService.closePeriod(ID.period),()=>SettlementService.executeMondayPayouts(ID.period),
      ()=>SettlementService.runPendingRakebackSettlement(),()=>SettlementService.executeUnionRakeBack(ID.union,'2026-09-07','2026-09-14')])
      await expect(invoke()).rejects.toMatchObject({code:'automatic_weekly_accounting_only'});
    expect(m.rpc).not.toHaveBeenCalled();expect(m.calls).toEqual([]);
  });
  it('requires exact scope and reads bounded deterministic history with nullable actual values',async()=>{
    await expect(SettlementService.getPeriodHistory()).rejects.toThrow();expect(m.calls).toEqual([]);
    const rows=await SettlementService.getPeriodHistory(12,scope);
    expect(rows[0]).toMatchObject({scope:'union',unionId:ID.union,totalRakeCollected:10.25,totalPlayerWinnings:null,settledAt:undefined,status:'closed'});
    expect(m.calls).toContainEqual(['eq','union_id',ID.union]);expect(m.calls).toContainEqual(['is','club_id',null]);
    expect(m.calls.filter(call=>call[0]==='order')).toEqual([['order','start_at',{ascending:false}],['order','id',{ascending:false}]]);
    expect(m.calls).toContainEqual(['limit',12]);expect(m.calls.find(call=>call[0]==='select')?.[1]).toContain('total_rake_collected::text');
  });
  it.each([{union_id:ID.otherUnion},{club_id:ID.club},{total_rake_collected:'NaN'},{total_rake_collected:10.25},
    {total_rake_collected:'10.251'},{total_hands_dealt:'59'},{status:'paid'},{start_at:null}])('refuses malformed/wrong scope rows %j',fault=>{
    m.rows=[recordedPeriod(fault)];return expect(SettlementService.getPeriodHistory(12,scope)).rejects.toThrow();
  });
  it('refuses transport failure and duplicate records',async()=>{
    m.reply=Promise.resolve({data:[],error:{message:'refused'}});await expect(SettlementService.getPeriodHistory(12,scope)).rejects.toThrow();
    m.reply=null;m.rows=[recordedPeriod(),recordedPeriod()];await expect(SettlementService.getPeriodHistory(12,scope)).rejects.toThrow();
  });
  it('holds the account epoch across an ABA history read',async()=>{
    let resolve!:(x:any)=>void;m.reply=new Promise(yes=>{resolve=yes;});
    const pending=SettlementService.getPeriodHistory(12,scope);auth(ID.otherActor);auth(ID.actor);resolve({data:m.rows,error:null});
    await expect(pending).rejects.toThrow();
  });
  it('report entrypoints never obtain an implicit global period',async()=>{
    await expect(SettlementService.getClubReport(ID.club)).rejects.toThrow();
    await expect(SettlementService.getAgentReport(ID.actor)).rejects.toThrow();expect(m.rpc).not.toHaveBeenCalled();
  });
  it('refuses the unsupported legacy report RPCs even with a seemingly valid explicit scope',async()=>{
    for(const invoke of [()=>SettlementService.generateSettlements(ID.period,scope),
      ()=>SettlementService.calculateAgentSettlement(ID.period,ID.actor,scope),
      ()=>SettlementService.getClubReport(ID.club,ID.period),()=>SettlementService.getAgentReport(ID.actor,ID.period,scope)])
      await expect(invoke()).rejects.toMatchObject({code:'canonical_weekly_statements_required'});
    expect(m.rpc).not.toHaveBeenCalled();expect(m.calls).toEqual([]);
  });

});
