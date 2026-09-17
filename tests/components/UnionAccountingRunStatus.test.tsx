import React from 'react';
import {act,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {beforeEach,expect,it,vi} from 'vitest';
import {MemoryRouter} from 'react-router-dom';
import {OBSERVER_ID as ID,observationRow,missingObservation} from '../helpers/accountingObservation';
import {WEEKLY_ID,weeklyStatementRow} from '../helpers/clubWeeklyStatement';
const m=vi.hoisted(()=>({id:null as string|null,handlers:new Set<(event:any)=>void>(),rpc:vi.fn(),rows:[] as any[],calls:[] as unknown[][]}));
vi.mock('../../src/core/IdentityDNA',()=>({getIdentityDNAStatus:()=>({loaded:!!m.id,authenticated:!!m.id,userId:m.id})}));
vi.mock('../../src/core/MasterBus',()=>({masterBus:{emit:vi.fn(),subscribe:(name:string,fn:(event:any)=>void)=>{if(name==='AUTH_STATE_CHANGED')m.handlers.add(fn);return()=>m.handlers.delete(fn);}}}));
vi.mock('../../src/hooks/useAuthUser',()=>({useAuthUser:()=>({user:m.id?{id:m.id}:null,isHydrating:false})}));
vi.mock('../../src/utils/errorReporter',()=>({reportError:vi.fn()}));
vi.mock('../../src/utils/clubIdResolver',()=>({resolveClubUUID:async(id:string)=>id}));
vi.mock('../../src/utils/unionIdResolver',()=>({resolveUnionUUID:async(id:string)=>id}));
vi.mock('../../src/lib/supabase',()=>({supabase:{rpc:m.rpc,from:(table:string)=>{
  m.calls.push(['from',table]);const q:any={};const filters:Array<[string,unknown]>=[];
  for(const method of ['select','order','limit'])q[method]=(...args:unknown[])=>{m.calls.push([method,...args]);return q;};
  q.eq=(key:string,value:unknown)=>{filters.push([key,value]);m.calls.push(['eq',key,value]);return q;};
  q.then=(yes:any,no:any)=>Promise.resolve({data:m.rows.filter(row=>filters.every(([key,value])=>row[key]===value)),error:null}).then(yes,no);return q;
}}}));
import UnionAccountingRunStatus from '../../src/components/agent/UnionAccountingRunStatus';
import WeeklyAccountingWorkspace from '../../src/components/accounting/WeeklyAccountingWorkspace';
function auth(id:string|null){m.id=id;for(const fn of [...m.handlers])fn({payload:{isAuthenticated:!!id,userId:id}});}
beforeEach(()=>{m.rpc.mockReset();m.rows=[];m.calls=[];auth(null);auth(ID.actor);});
it('shows incomplete canonical status without individual diagnostics or payer actions',async()=>{
  m.rpc.mockResolvedValue({data:observationRow({state:'incomplete',posted:false}),error:null});
  render(<UnionAccountingRunStatus unionId={ID.union} periodEnd="2026-09-14"/>);
  expect(await screen.findByText('Automatic Weekly Accounting Incomplete')).toBeInTheDocument();
  expect(screen.getAllByRole('button').map(button=>button.textContent)).toEqual(['Refresh Status']);
  expect(m.rpc).toHaveBeenCalledWith('fn_accounting_run_observation_v1',expect.objectContaining({p_scope_id:ID.union,p_period_start:'2026-09-07T07:00:00.000Z'}));
});
it.each([{data:null,error:{message:'offline'}},{data:{status:'complete',result:{success:true,accounting_version:3}},error:null}])('makes legacy/unavailable evidence visibly unavailable',async reply=>{
  m.rpc.mockResolvedValue(reply);render(<UnionAccountingRunStatus unionId={ID.union} periodEnd="2026-09-14"/>);
  expect(await screen.findByText('Automatic Accounting Status Unavailable')).toBeInTheDocument();
  expect(screen.queryByText('Automatic Weekly Accounting Posted')).not.toBeInTheDocument();
});
it('does not display a late result after union A to B to A route changes',async()=>{
  let resolve!:(value:unknown)=>void;
  m.rpc.mockReturnValueOnce(new Promise(yes=>{resolve=yes;})).mockResolvedValue({data:missingObservation(),error:null});
  const view=render(<UnionAccountingRunStatus unionId={ID.union} periodEnd="2026-09-14"/>);
  await waitFor(()=>expect(m.rpc).toHaveBeenCalledTimes(1));
  view.rerender(<UnionAccountingRunStatus unionId={ID.otherUnion} periodEnd="2026-09-14"/>);
  view.rerender(<UnionAccountingRunStatus unionId={ID.union} periodEnd="2026-09-14"/>);
  await screen.findByText('No Accounting Run Recorded For This Union Week');
  await act(async()=>resolve({data:observationRow(),error:null}));
  expect(screen.queryByText('Automatic Weekly Accounting Posted')).not.toBeInTheDocument();
});
it('discards an old posted response after actual auth A to B to A without intermediate render',async()=>{
  let resolve!:(value:unknown)=>void;
  m.rpc.mockReturnValueOnce(new Promise(yes=>{resolve=yes;})).mockResolvedValue({data:missingObservation(),error:null});
  render(<UnionAccountingRunStatus unionId={ID.union} periodEnd="2026-09-14"/>);
  await waitFor(()=>expect(m.rpc).toHaveBeenCalledTimes(1));
  act(()=>{auth(ID.otherActor);auth(ID.actor);});
  await act(async()=>resolve({data:observationRow(),error:null}));
  expect(await screen.findByText('No Accounting Run Recorded For This Union Week')).toBeInTheDocument();
  expect(screen.queryByText('Automatic Weekly Accounting Posted')).not.toBeInTheDocument();
});
it('mounts the actual shared workspace and weekly reader even when club applicability is unknown',async()=>{
  auth(WEEKLY_ID.actor);
  m.rows=[weeklyStatementRow(),weeklyStatementRow({invoice_type:'accounting_correction',net_amount:'999.00'}),weeklyStatementRow({club_id:WEEKLY_ID.otherClub})];
  m.rpc.mockImplementation(async(_name,args)=>({data:{...missingObservation('club',WEEKLY_ID.club),actor_user_id:WEEKLY_ID.actor,
    period_start:args.p_period_start,period_end:args.p_period_end,
    // The selected week below is fixed before asserting its received response.
    expected_run_at:'2026-09-14T09:00:00.000Z'},error:null}));
  render(<MemoryRouter><WeeklyAccountingWorkspace scopeKind="club" scopeRef={WEEKLY_ID.club}/></MemoryRouter>);
  fireEvent.change(await screen.findByLabelText('Week Ending Monday'),{target:{value:'2026-09-14'}});
  expect(await screen.findByText('100.25 Chips')).toBeInTheDocument();
  expect(screen.getByText('60.20 Chips')).toBeInTheDocument();expect(screen.getByText('40.05 Chips')).toBeInTheDocument();
  expect(screen.queryByText('999.00 Chips')).not.toBeInTheDocument();
  expect(await screen.findByText(/A standalone club run could not be established/)).toBeInTheDocument();
  expect(m.calls).toContainEqual(['eq','invoice_type','club_weekly_accounting']);
  expect(m.rpc.mock.calls.every(([name])=>name==='fn_accounting_run_observation_v1')).toBe(true);
  expect(screen.queryByRole('button',{name:/pay|close|execute/i})).not.toBeInTheDocument();
});
it('keeps weekly statements visible when an invalid date is chosen without querying a substitute week',async()=>{
  auth(WEEKLY_ID.actor);m.rows=[weeklyStatementRow()];m.rpc.mockResolvedValue({data:null,error:{message:'unavailable'}});
  render(<MemoryRouter><WeeklyAccountingWorkspace scopeKind="club" scopeRef={WEEKLY_ID.club}/></MemoryRouter>);
  fireEvent.change(await screen.findByLabelText('Week Ending Monday'),{target:{value:'2026-09-15'}});
  const calls=m.rpc.mock.calls.length;
  expect(screen.getByText('Choose A Valid Monday For The Accounting Week.')).toBeInTheDocument();
  expect(await screen.findByText('40.05 Chips')).toBeInTheDocument();expect(m.rpc).toHaveBeenCalledTimes(calls);
});
