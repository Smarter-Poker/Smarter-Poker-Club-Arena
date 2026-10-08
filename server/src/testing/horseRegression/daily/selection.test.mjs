/** P14.3 strict reply parsers for fn_horse_commitment_selection_receipt and
 * fn_horse_accepted_source_rows. All replies here are synthetic. */
import {describe,it,expect} from 'vitest';
import {parseSelectionReceipt,parseAcceptedSourceRows,classifySelectionGap,postgresUtcText,ACCEPTED_SOURCE_COLUMNS} from '../../../services/horseDailyCorrectiveReview/selection.ts';
import {DAY,receipt,gapRow,passReceipt,dayState} from './fixture.mjs';
import {HAND,TABLE,OTHER} from './roster-fixture.mjs';
const request={day:DAY,after:null};
const LEASE='70000000-0000-4000-8000-0000000000aa';
// Shape of fn_horse_accepted_source_rows: every column text|null; the three
// clocks are timestamptz::text under SET timezone='UTC' ('+00', no 'T').
const sourceRow=(hand=HAND,table=TABLE,extra={})=>({...Object.fromEntries(ACCEPTED_SOURCE_COLUMNS.map(k=>[k,'x'])),hand_id:hand,table_id:table,tournament_id:null,
 committed_at:'2026-09-14 14:00:00.123456+00',post_commit_completed_at:null,read_at:'2026-09-14 14:00:01.5+00',lease_generation:LEASE,...extra});
describe('selection receipt',()=>{
 it('accepts the day state, pass receipts and an explicit gap page, detached',()=>{const raw=receipt([gapRow(1,['accepted_commitment_facts_missing']),gapRow(2,['late_arrival_after_pass:1']),gapRow(3,['dealt_roster_invalid'])]);const got=parseSelectionReceipt(raw,request);raw.gaps[0].reasons.push('changed');expect(got.gaps.map(g=>g.kind)).toEqual(['missing_source','late_arrival','source_gap']);expect(got.gaps[0].reasons).toEqual(['accepted_commitment_facts_missing']);expect(got.passes[0].sourceCoverage).toBe('not_established');expect(Object.isFrozen(got.gaps[0])).toBe(true);});
 it('accepts every named identity basis, day and pass, and keeps each one',()=>{for(const basis of ['current_profile_is_horse','accepted_roster','current_profile_then_accepted_roster']){const r=receipt();r.identityBasis=basis;r.passes[0].identityBasis=basis;const got=parseSelectionReceipt(r,request);expect(got.identityBasis).toBe(basis);expect(got.passes[0].identityBasis).toBe(basis);}});
 it('keeps a never-observed day explicit',()=>{const got=parseSelectionReceipt(receipt([],null,false,{dayState:null,passes:[]}),request);expect(got.dayState).toBeNull();expect(got.passes).toEqual([]);});
 for(const [name,mutate] of [
  ['extra key',r=>r.extra=1],['coverage claim',r=>r.sourceCoverage='complete'],['identity basis',r=>r.identityBasis='profile_today'],['pass identity basis',r=>r.passes[0].identityBasis='roster'],
  ['activation',r=>r.activationAllowed=true],['gto',r=>r.gtoVerified=true],['wrong day',r=>r.day='2026-09-11'],['wrong limit',r=>r.limit=9],
  ['wrong source',r=>r.source='horse_commitment_reviews'],['after echo',r=>r.after={playedAt:DAY+'T00:00:00.000001Z',handId:HAND}],
  ['pass extra key',r=>r.passes[0].x=1],['pass coverage',r=>r.passes[0].sourceCoverage='complete'],['pass order',r=>r.passes=[passReceipt(2),passReceipt(1)]],
  ['pass beyond day row',r=>r.passes=[passReceipt(2)]],['pass counter overflow',r=>r.passes[0].lateArrivalHands=13],
  ['pass flagged beyond horses',r=>r.passes[0].flaggedHorseHands=7],['pass window inverted',r=>r.passes[0].windowEnd=DAY+'T00:00:00.000000Z'],
  ['pass max outside window',r=>r.passes[0].maxScannedCreatedAt='2026-09-11T00:00:01.000000Z'],['pass negative',r=>r.passes[0].scannedHands=-1],
  ['pass fractional',r=>r.passes[0].handGaps=0.5],
  ['pass max clock is not the final cursor clock',r=>r.passes[0].maxScannedCreatedAt=DAY+'T23:58:00.000000Z'],
  ['pass finished after its cutover',r=>r.passes[0].finishedAt='2026-09-11T00:06:00.000000Z'],
  ['pass no-commit beyond missing source',r=>{r.passes[0].handsWithoutCommit=2;r.passes[0].missingSourceHands=1;}],
  ['pass empty with a clock',r=>{r.passes[0].scannedHands=0;r.passes[0].horseHands=0;r.passes[0].flaggedHorseHands=0;}],
  ['pass window not the UTC day',r=>r.passes[0].windowStart=DAY+'T00:00:00.000001Z'],
  ['pass window end not next day',r=>r.passes[0].windowEnd='2026-09-12T00:00:00.000000Z'],
  ['unavailable reasons mixed with others',r=>r.gaps=[gapRow(1,['daily_gap_reasons_unavailable','hand_without_commit'])]],['pass in another day',r=>{r.passes[0].windowStart='2026-09-09T00:00:00.000000Z';}],
  ['passes without day row',r=>r.dayState=null],['day state extra',r=>r.dayState.extra=1],['day cursor other day',r=>r.dayState.cursor.createdAt='2026-09-11T00:00:00.000000Z'],
  ['gap other day',r=>r.gaps=[gapRow(1,['x'],{playedAt:'2026-09-11T00:00:00.000001Z'})]],['gap no reasons',r=>r.gaps=[gapRow(1,[])]],
  ['gap nested reason',r=>r.gaps=[gapRow(1,[['x']])]],['gap long reason',r=>r.gaps=[gapRow(1,['x'.repeat(161)])]],['gap extra key',r=>r.gaps=[gapRow(1,['x'],{horseId:HAND})]],
  ['gap order',r=>{r.gaps=[gapRow(2,['x']),gapRow(1,['x'])];r.next={playedAt:r.gaps[1].playedAt,handId:r.gaps[1].handId};}],
  ['gap duplicate',r=>{r.gaps=[gapRow(1,['x']),gapRow(1,['x'])];r.next={playedAt:r.gaps[1].playedAt,handId:r.gaps[1].handId};}],
  ['short page claims more',r=>{r.gaps=[gapRow(1,['x'])];r.next={playedAt:r.gaps[0].playedAt,handId:r.gaps[0].handId};r.hasMore=true;}],
  ['next mismatch',r=>{r.gaps=[gapRow(1,['x'])];r.next={playedAt:r.gaps[0].playedAt,handId:OTHER};}],['stray next',r=>r.next={playedAt:DAY+'T00:00:00.000001Z',handId:HAND}],
  ['nine gaps',r=>{r.gaps=Array.from({length:9},(_,i)=>gapRow(i+1,['x']));r.next={playedAt:r.gaps[8].playedAt,handId:r.gaps[8].handId};}],
 ])it(`refuses ${name}`,()=>{const r=receipt();mutate(r);expect(()=>parseSelectionReceipt(r,request)).toThrow();});
 it('refuses an oversized reply before inspecting it',()=>{const r=receipt([gapRow(1,['x'])]);r.gaps[0].reasons=Array.from({length:32},()=>'y'.repeat(160));r.passes=Array.from({length:32},(_,i)=>passReceipt(i+1));r.dayState=dayState({pass:32});r.padding='z'.repeat(70000);expect(()=>parseSelectionReceipt(r,request)).toThrow('daily_selection_bounds');});
 it('cursor echo resumes strictly after the request',()=>{const after={playedAt:gapRow(1,['x']).playedAt,handId:gapRow(1,['x']).handId};expect(()=>parseSelectionReceipt(receipt([gapRow(1,['x'])],after),{day:DAY,after})).toThrow();expect(parseSelectionReceipt(receipt([gapRow(2,['x'])],after),{day:DAY,after}).gaps).toHaveLength(1);});
 it('an empty pass and an unreadable gap are explicit, never guessed',()=>{const r=receipt([gapRow(1,['daily_gap_reasons_unavailable'],{tableId:null})]);
 r.passes=[passReceipt(1,{scannedHands:0,horseHands:0,flaggedHorseHands:0,maxScannedCreatedAt:null,finalCursor:null})];
 const got=parseSelectionReceipt(r,request);expect(got.gaps[0].kind).toBe('reasons_unavailable');expect(got.gaps[0].tableId).toBeNull();expect(got.passes[0].finalCursor).toBeNull();});
it('missing-source kinds are exactly the step labels for an absent accepted source',()=>{
 for(const r of ['hand_without_commit','accepted_commitment_facts_missing','accepted_payload_oversized'])expect(classifySelectionGap([r])).toBe('missing_source');
 for(const r of ['accepted_payload_digest_mismatch','accepted_commitment_facts_invalid','dealt_roster_invalid','tournament_format_unknown'])expect(classifySelectionGap([r])).toBe('source_gap');
 expect(classifySelectionGap(['hand_without_commit','late_arrival_after_pass:2'])).toBe('late_arrival');});
it('late arrival requires an exact pass ordinal',()=>{expect(classifySelectionGap(['late_arrival_after_pass:3'])).toBe('late_arrival');expect(classifySelectionGap(['late_arrival_after_pass:'])).toBe('source_gap');expect(classifySelectionGap(['late_arrival_after_pass:0'])).toBe('source_gap');expect(classifySelectionGap(['hand_without_commit'])).toBe('missing_source');});
});
describe('accepted source rows',()=>{
 const hands=[{handId:HAND,tableId:TABLE}];
 it('accepts exactly the exporter columns plus lease generation and strips the lease from the raw row',()=>{const got=parseAcceptedSourceRows({version:1,rows:[sourceRow()]},hands).get(HAND);expect(got.leaseGeneration).toBe(LEASE);expect(Object.keys(got.row)).toEqual([...ACCEPTED_SOURCE_COLUMNS]);expect(Object.isFrozen(got.row)).toBe(true);});
 it('an absent hand stays absent, never invented',()=>expect(parseAcceptedSourceRows({version:1,rows:[]},hands).size).toBe(0));
 it('a missing submission is an explicit null lease',()=>expect(parseAcceptedSourceRows({version:1,rows:[sourceRow(HAND,TABLE,{lease_generation:null})]},hands).get(HAND).leaseGeneration).toBeNull());
 for(const [name,reply] of [
  ['other hand',{version:1,rows:[sourceRow(OTHER)]}],['other table',{version:1,rows:[sourceRow(HAND,OTHER)]}],
  ['duplicate',{version:1,rows:[sourceRow(),sourceRow()]}],['extra column',{version:1,rows:[sourceRow(HAND,TABLE,{is_horse:'true'})]}],
  ['missing column',{version:1,rows:[(()=>{const r=sourceRow();delete r.roster_text;return r;})()]}],
  ['non-text value',{version:1,rows:[sourceRow(HAND,TABLE,{hand_number:12})]}],['int lease',{version:1,rows:[sourceRow(HAND,TABLE,{lease_generation:'9'})]}],
  ['unleased literal',{version:1,rows:[sourceRow(HAND,TABLE,{lease_generation:'unleased'})]}],
  ['ISO committed_at',{version:1,rows:[sourceRow(HAND,TABLE,{committed_at:'2026-09-14T14:00:00.000Z'})]}],
  ['non-UTC read_at',{version:1,rows:[sourceRow(HAND,TABLE,{read_at:'2026-09-14 09:00:01-05'})]}],
  ['null read_at',{version:1,rows:[sourceRow(HAND,TABLE,{read_at:null})]}],
  ['null committed_at',{version:1,rows:[sourceRow(HAND,TABLE,{committed_at:null})]}],
  ['bad completed clock',{version:1,rows:[sourceRow(HAND,TABLE,{post_commit_completed_at:'later'})]}],['wrong version',{version:2,rows:[]}],
  ['envelope extra',{version:1,rows:[],note:'x'}],['bare array',[sourceRow()]],
 ])it(`refuses ${name}`,()=>expect(()=>parseAcceptedSourceRows(reply,hands)).toThrow());
 for(const bad of [[],Array.from({length:9},(_,i)=>({handId:`30000000-0000-4000-8000-00000000001${i}`,tableId:TABLE})),[{handId:HAND,tableId:TABLE},{handId:HAND,tableId:TABLE}],[{handId:'X',tableId:TABLE}]])
  it(`refuses request ${bad.length}`,()=>expect(()=>parseAcceptedSourceRows({version:1,rows:[]},bad)).toThrow('invalid_accepted_source_request'));
});
it('rows come back in request order and a reordered reply is refused',()=>{const SECOND='30000000-0000-4000-8000-000000000002';const hands=[{handId:HAND,tableId:TABLE},{handId:SECOND,tableId:TABLE}];
 expect([...parseAcceptedSourceRows({version:1,rows:[sourceRow(),sourceRow(SECOND)]},hands).keys()]).toEqual([HAND,SECOND]);
 expect(parseAcceptedSourceRows({version:1,rows:[sourceRow(SECOND)]},hands).size).toBe(1);
 expect(()=>parseAcceptedSourceRows({version:1,rows:[sourceRow(SECOND),sourceRow()]},hands)).toThrow();});
it('PostgreSQL UTC text clocks: +00 with an optional trimmed fraction only',()=>{
 for(const v of ['2026-09-14 14:00:00+00','2026-09-14 14:00:00.1+00','2026-09-14 14:00:00.123456+00'])expect(postgresUtcText(v)).toBe(true);
 for(const v of ['2026-09-14 14:00:00.100+00','2026-09-14T14:00:00+00','2026-09-14 14:00:00','2026-09-14 14:00:00+00:00','2026-09-14 24:00:00+00','2026-02-30 14:00:00+00','2026-09-14 14:00:00.1234567+00',null])expect(postgresUtcText(v)).toBe(false);});
it('a completed post-commit clock is accepted',()=>expect(parseAcceptedSourceRows({version:1,rows:[sourceRow(HAND,TABLE,{post_commit_completed_at:'2026-09-14 14:00:00.9+00'})]},[{handId:HAND,tableId:TABLE}]).size).toBe(1));
