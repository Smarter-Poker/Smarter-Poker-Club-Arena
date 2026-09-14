import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('./client.js',()=>({supabase:{from:vi.fn()}}));
import {supabase} from './client.js';
import {loadPresenceFromPark} from './snapshots.js';
const boundary=vi.mocked(supabase.from);
const interval='a0000000-0000-4000-8000-000000000001';
const parkedAt=Date.parse('2026-09-11T12:34:00Z');
const row={disconnect_states:{player:{state:'AWAY',sinceMs:parkedAt-1000,graceDeadlineMs:parkedAt+20000}},
  parked_at:new Date(parkedAt).toISOString(),engine_instance:`1-abcdef12:parked:maintenance:${interval}`};
function reply(data:unknown,error:unknown=null){
  const builder={select:()=>builder,eq:()=>builder,maybeSingle:async()=>({data,error})};
  boundary.mockReturnValue(builder as any);
}
beforeEach(()=>reply(row));
describe('operation-bound presence restoration',()=>{
  it.each([16,30,45])('restores the exact owned interval at %imin without refilling the old allowance',async minutes=>{
    expect(await loadPresenceFromPark('table',parkedAt+minutes*60000,interval)).toEqual(row.disconnect_states);
  });
  it('keeps the legacy freshness limit when no operation was adopted',async()=>{
    expect(await loadPresenceFromPark('table',parkedAt+30*60000)).toBeNull();
  });
  it.each(['different','missing','error','invalid-time'])('refuses an unproved %s restore instead of replacing player state',async fault=>{
    if(fault==='different')reply({...row,engine_instance:'other'});
    if(fault==='missing')reply(null);
    if(fault==='error')reply(null,new Error('connection lost'));
    if(fault==='invalid-time')reply({...row,parked_at:'bad'});
    await expect(loadPresenceFromPark('table',parkedAt+30*60000,interval)).rejects.toBeTruthy();
  });
});
