import {describe,it,expect} from 'vitest';
import {parseDailyPage,parseDailyManifest,validateRequest} from '../../../services/horseDailyCorrectiveReview/validation.ts';
import {DAY,fakeRow,page} from './fixture.mjs';
const request={day:DAY,after:null};
describe('strict detached diagnostic page',()=>{
 it('accepts ordinary page and detaches nested values',()=>{const p=page([fakeRow()]);const got=parseDailyPage(p,request);p.rows[0].gaps.push('changed');expect(got.rows[0].gaps).toEqual([]);expect(Object.isFrozen(got.rows[0])).toBe(true);});
 for(const [field,value] of [['status','retained_diagnostic'],['eligibility','over_10bb'],['dayObservation','present']])for(const malformed of [[value],{toString:value},null,0]){
  it(`refuses coercible ${field} ${JSON.stringify(malformed)}`,()=>{const p=page([fakeRow()]);(field==='dayObservation'?p:p.rows[0])[field]=malformed;expect(()=>parseDailyPage(p,request)).toThrow();});
 }
 for(const mutate of [p=>p.rows[0].horseId='X',p=>p.rows[0].bigBlind='NaN',p=>p.rows[0].reasons=[['nested']],p=>p.rows[0].gaps=['x'.repeat(161)],p=>p.rows.push({...p.rows[0]}),p=>p.next.handId='30000000-0000-4000-8000-000000000009',p=>p.day='2026-09-11',p=>p.after={},p=>p.hasMore=true,p=>p.gtoVerified=true,p=>p.sourceCoverage='complete',p=>p.rows[0].playedAt='2026-09-10T25:00:00.000001Z']){
  it(`rejects malformed relationship ${String(mutate)}`,()=>{const p=page([fakeRow()]);mutate(p);expect(()=>parseDailyPage(p,request)).toThrow();});
 }
 it('preserves empty unknown window',()=>{const got=parseDailyPage(page(),request);expect(got.rows).toEqual([]);expect(got.sourceCoverage).toBe('not_established');});
 it('allows cursor key order independent of JSON key ordering',()=>{const r=fakeRow();const after={horseId:r.horseId,handId:r.handId,playedAt:r.playedAt};const p=page([fakeRow(2)],after);expect(parseDailyPage(p,{day:DAY,after}).rows).toHaveLength(1);});
 for(const day of ['2026-02-30','2026-9-10','2026-09-10T00:00:00Z','2100-01-01'])it(`rejects invalid UTC day ${day}`,()=>expect(()=>validateRequest({day,after:null})).toThrow());
 it('rejects duplicate mapping without scanning the journal',()=>{const m={version:1,day:DAY,journalDirectory:'/private/journal',mappings:[{handId:fakeRow().handId,tableId:fakeRow().tableId,handKey:'a'.repeat(64),inputPath:'/private/input'}]};m.mappings.push({...m.mappings[0]});expect(()=>parseDailyManifest(m)).toThrow();});
});
it('one bounded serialization is also the exact detached payload',()=>{let calls=0;const raw={toJSON(){calls++;return calls===1?page([fakeRow()]):{...page(),extra:'x'.repeat(70000)};}};const parsed=parseDailyPage(raw,{day:DAY,after:null});expect(calls).toBe(1);expect(parsed.rows).toHaveLength(1);});
