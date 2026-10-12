/** P14.3 private mapping producer. Every source row, roster capsule and RPC
 * reply here is synthetic; the journal, exporter, batch and CLIs are the real
 * modules. The producer must never write the database or the journal, never
 * guess a lease and never become an authority token. */
import {it,expect,vi} from 'vitest';
import {mkdtempSync,mkdirSync,chmodSync,rmSync,realpathSync,readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {rosterFixture,HAND,TABLE,OTHER} from './roster-fixture.mjs';
import {DAY,page,fakeRow,receipt} from './fixture.mjs';
import {journalHash,makeHorseJournalRecord} from '../../../services/horseDecisionJournal/record.ts';
import {HorseDecisionJournalStore} from '../../../services/horseDecisionJournal/store.ts';
import {readHorseJournalHandRecords} from '../../../services/horseDecisionJournal/review.ts';
import {produceDailyMapping,acceptedSourceHandKey} from '../../../services/horseDailyCorrectiveReview/mapping.ts';
import {parseAcceptedSourceRows} from '../../../services/horseDailyCorrectiveReview/selection.ts';
import {createAcceptedSourceRowsReader} from '../../../services/horseDailyCorrectiveReview/source.ts';
import {parseDailyManifest} from '../../../services/horseDailyCorrectiveReview/validation.ts';
import {reviewDailySelection} from '../../../services/horseDailyCorrectiveReview/batch.ts';
import {runHorseDailyMappingProducer} from '../../../scripts/horseDailyMappingProducer.ts';
import {runUnsignedAcceptedSourceExport} from '../../../scripts/horseAcceptedRosterExport.ts';
const LEASE='70000000-0000-4000-8000-0000000000aa',OTHER_LEASE='70000000-0000-4000-8000-0000000000bb';
const env={SUPABASE_URL:'https://synthetic.invalid',SUPABASE_SERVICE_ROLE_KEY:'synthetic-not-a-secret'};
function setup({recordLease=LEASE,changeHand,extraRecords}={}){
 const dir=mkdtempSync(join(realpathSync(tmpdir()),'horse-daily-mapping-'));chmodSync(dir,0o700);
 try{
  const x=rosterFixture();const hand=structuredClone(x.hand);hand.fence=`${TABLE}:12:${recordLease}:observe`;changeHand?.(hand);
  const handKey=journalHash(`${TABLE}:12:${recordLease}`);
  const make=(sequence,body)=>makeHorseJournalRecord({producerId:'40000000-0000-4000-8000-000000000001',sequence,atMs:2000,sourceRelease:'a'.repeat(40),kind:'accepted_hand',handKey,turnKey:handKey},body);
  const records=[make(3,hand),...(extraRecords?.(make,hand)??[])];
  const journal=join(dir,'journal');const writer=new HorseDecisionJournalStore(journal);try{writer.appendBatch(records);}finally{writer.close();}
  const out=join(dir,'out');mkdirSync(out,{mode:0o700});
  // fn_horse_accepted_source_rows returns timestamptz::text under UTC ('+00').
  const row={...x.row,committed_at:'2026-09-14 14:00:00+00',read_at:'2026-09-14 14:00:01.25+00'};
  const queue={...fakeRow(),handId:HAND,tableId:TABLE,horseId:x.f.hero.user_id,payloadHash:row.payload_digest,bigBlind:'1',committedBb:'21'};
  const reply={version:1,rows:[{...row,lease_generation:LEASE}]};
  const rows=vi.fn(async hands=>parseAcceptedSourceRows(reply,hands));
  const request={day:DAY,after:null,journalDirectory:journal,outputDirectory:out};
  const readJournalHand=vi.fn((d,k)=>readHorseJournalHandRecords(d,k));
  return {dir,journal,out,x,row,queue,reply,rows,request,handKey,records,readJournalHand,
   deps:()=>({source:async()=>page([queue]),rows,readJournalHand}),cleanup:()=>rmSync(dir,{recursive:true,force:true})};
 }catch(error){rmSync(dir,{recursive:true,force:true});throw error;}
}
const run=async(f,deps={})=>produceDailyMapping(f.request,{...f.deps(),...deps});
const write=r=>{for(const file of r.files)writeFileSync(file.path,file.json,{mode:0o600});};
it('maps one accepted hand to a manifest the unchanged batch accepts, with authority left a missing input',async()=>{const f=setup();try{
 const before=readFileSync(join(f.journal,'horse-decisions.sqlite'));
 const r=await run(f);
 expect(r.report.status).toBe('mapped_selection');expect(r.report.hands[0]).toMatchObject({status:'mapped',reason:'mapped_authority_missing_input',leaseBasis:'hand_submission',handKey:f.handKey,acceptedHandRecordDigest:f.records[0].sha256,authorityPath:'missing_input'});
 expect(r.report).toMatchObject({authority:'missing_input',databaseWrites:false,journalWrites:false,journalLeases:false,fullWindow:false,sourcePopulationVerified:false,gtoVerified:false,activationAllowed:false});
 expect(r.manifest.mappings).toEqual([{handId:HAND,tableId:TABLE,handKey:f.handKey,inputPath:join(f.out,`hand-${HAND}.input.json`)}]);
 expect(JSON.stringify(r.manifest)).not.toContain('authorityPath');
 expect(f.rows).toHaveBeenCalledTimes(1);expect(f.rows.mock.calls[0][0]).toEqual([{handId:HAND,tableId:TABLE}]);
 write(r);const manifest=parseDailyManifest(JSON.parse(readFileSync(r.report.manifestPath,'utf8')));
 const input=JSON.parse(readFileSync(manifest.mappings[0].inputPath,'utf8'));expect(input.commitments.payloadDigest).toBe(f.row.payload_digest);expect(input.commitments.acceptedHandRecordDigest).toBe(f.records[0].sha256);expect(input.references).toEqual([]);expect(input.mapping.authority).toBe('missing_input');
 // The existing batch takes this manifest unchanged and stops at the absent authority.
 const reviewed=await reviewDailySelection(manifest,async()=>page([f.queue]),{allowSynthetic:true},async()=>receipt());
 expect(reviewed.rows[0]).toMatchObject({status:'pending',reason:'qualified_authority_unavailable',actor:null});expect(reviewed.status).toBe('incomplete');
 // The raw-rows file is exactly what horseAcceptedRosterExport consumes.
 const exportOut=join(f.out,'export.json');const exported=runUnsignedAcceptedSourceExport([f.journal,f.handKey,f.records[0].sha256,join(f.out,`hand-${HAND}.rows.json`),exportOut]);
 expect(exported.code).toBe(0);expect(JSON.parse(readFileSync(exportOut,'utf8')).sourceExport.authorityQualified).toBe(false);
 expect(readFileSync(join(f.journal,'horse-decisions.sqlite'))).toEqual(before);
}finally{f.cleanup();}});
for(const [name,options,mutate,expected] of [
 ['wrong lease generation',{recordLease:OTHER_LEASE},null,'journal_accepted_hand_missing'],
 ['missing submission',{},f=>{f.reply.rows[0].lease_generation=null;},'hand_submission_missing'],
 ['missing or oversized source row',{},f=>{f.reply.rows=[];},'accepted_source_missing_or_oversized'],
 ['ISO clock is not the reader shape',{},f=>{f.reply.rows[0].read_at='2026-09-14T14:00:01.000Z';},'accepted_source_reply_refused'],
 ['queued payload digest mismatch',{},f=>{f.queue.payloadHash='b'.repeat(64);},'queued_source_changed'],
 ['queued big blind mismatch',{},f=>{f.queue.bigBlind='2';},'queued_source_changed'],
 ['stored payload digest mismatch',{},f=>{f.reply.rows[0].payload_digest='c'.repeat(64);f.queue.payloadHash='c'.repeat(64);},'payload_digest_mismatch'],
 ['accepted record for another hand',{changeHand:h=>{h.committedHandId=OTHER;}},null,'journal_accepted_hand_mismatch'],
 ['conflicting accepted records',{extraRecords:(make,h)=>[make(4,{...h,bigBlind:2})]},null,'journal_accepted_hand_mismatch'],
 ['roster provenance missing',{},f=>{Object.assign(f.reply.rows[0],{roster_hand_id:null,roster_status:null,roster_payload_digest:null,roster_producer_version:null,roster_text:null});},'roster_provenance_missing'],
 ['hand number invalid',{},f=>{f.reply.rows[0].hand_number='0';},'accepted_source_hand_number_invalid'],
])it(`pending, never skipped: ${name}`,async()=>{const f=setup(options);try{mutate?.(f);const r=await run(f);
 expect(r.report.status).toBe('incomplete');expect(r.report.hands).toHaveLength(1);expect(r.report.hands[0]).toMatchObject({status:'pending',reason:expected,inputPath:null});
 expect(r.manifest.mappings).toEqual([]);expect(r.report.reasons).toContain('pending_private_mappings');
 if(expected==='hand_submission_missing')expect(f.readJournalHand).not.toHaveBeenCalled();
}finally{f.cleanup();}});
it('a reply naming any other hand is refused and stops further source calls',async()=>{const f=setup();try{
 const second=fakeRow(2);f.reply.rows=[{...f.reply.rows[0],hand_id:OTHER}];
 const r=await run(f,{source:async()=>page([f.queue,second])});
 expect(r.report.hands.map(h=>h.reason)).toEqual(['accepted_source_reply_refused','accepted_source_unavailable']);expect(f.rows).toHaveBeenCalledTimes(1);
 expect(r.report.resumeCursor).toBeNull();expect(r.report.reasons).toContain('mapping_budget_or_source_unavailable');
}finally{f.cleanup();}});
it('ineligible queue rows are named and never queried',async()=>{const f=setup();try{f.queue.eligibility='unknown';const gap={...fakeRow(2),gaps:['review_format_changed']};
 const r=await run(f,{source:async()=>page([f.queue,gap])});expect(r.report.hands.map(h=>h.reason)).toEqual(['monetary_eligibility_unknown','daily_source_gap']);expect(f.rows).not.toHaveBeenCalled();
}finally{f.cleanup();}});
it('ninth hand exceeds the source budget, stays explicit and becomes the resume position',async()=>{const f=setup();try{
 const rows=Array.from({length:10},(_,i)=>fakeRow(i+1));const rowsReader=vi.fn(async()=>new Map());
 const source=vi.fn(async req=>req.after?page(rows.slice(8),req.after,false):page(rows.slice(0,8),null,true));
 const r=await run(f,{source,rows:rowsReader});
 expect(rowsReader).toHaveBeenCalledTimes(8);expect(r.report.hands.slice(8).map(h=>h.reason)).toEqual(['mapping_hand_budget_exhausted','mapping_hand_budget_exhausted']);
 expect(r.report.resumeCursor).toEqual({playedAt:rows[7].playedAt,handId:rows[7].handId,horseId:rows[7].horseId});expect(r.report.status).toBe('incomplete');
}finally{f.cleanup();}});
it('page limit and an unavailable page source never claim a mapped selection',async()=>{const f=setup();try{
 const r=await run(f,{source:async req=>page(Array.from({length:8},(_,i)=>fakeRow((req.after?9:1)+i)),req.after,true),rows:async()=>new Map()});
 expect(r.report.reasons).toContain('daily_selection_page_limit');expect(r.report.selectionExhausted).toBe(false);
 const down=await run(f,{source:async()=>{throw Error('private-error');}});expect(down.report.reasons).toContain('daily_source_unavailable');expect(JSON.stringify(down)).not.toContain('private-error');
}finally{f.cleanup();}});
it('lease identity is derived only from the submission and never guessed',()=>{
 expect(acceptedSourceHandKey(TABLE,'12',LEASE)).toEqual({coordinate:`${TABLE}:12:${LEASE}`,handKey:journalHash(`${TABLE}:12:${LEASE}`)});
 expect(acceptedSourceHandKey(TABLE,'12',null)).toEqual({reason:'hand_submission_missing'});
 expect(acceptedSourceHandKey(TABLE,'12','unleased')).toEqual({reason:'hand_submission_lease_invalid'});
 for(const n of ['0','-1','1.5',null,'99999999999999999999'])expect(acceptedSourceHandKey(TABLE,n,LEASE)).toHaveProperty('reason');
});
it('actual HTTP adapter sends one bounded read-only call with the exact coordinates and never retries',async()=>{const f=setup();try{
 const fetcher=vi.fn(async()=>new Response(JSON.stringify(f.reply)));const r=await run(f,{rows:createAcceptedSourceRowsReader(env,fetcher)});
 expect(r.report.hands[0].status).toBe('mapped');expect(fetcher).toHaveBeenCalledTimes(1);const [url,opts]=fetcher.mock.calls[0];
 expect(url).toBe('https://synthetic.invalid/rest/v1/rpc/fn_horse_accepted_source_rows');expect(opts).toMatchObject({method:'POST',redirect:'error',cache:'no-store',credentials:'omit'});
 expect(JSON.parse(opts.body)).toEqual({p_hands:[{hand_id:HAND,table_id:TABLE}]});
 const failing=vi.fn(async()=>new Response('private-cards',{status:500}));const down=await run(f,{rows:createAcceptedSourceRowsReader(env,failing)});
 expect(down.report.hands[0].reason).toBe('accepted_source_unavailable');expect(failing).toHaveBeenCalledTimes(1);expect(JSON.stringify(down)).not.toContain('private-cards');
 const oversized=vi.fn(async()=>new Response(new Uint8Array(1024*1024+8193)));expect((await run(f,{rows:createAcceptedSourceRowsReader(env,oversized)})).report.hands[0].reason).toBe('accepted_source_unavailable');
}finally{f.cleanup();}});
it('CLI writes only into a new empty private directory and refuses reuse',async()=>{const f=setup();try{
 const deps={source:async()=>page([f.queue]),rows:f.rows};const r=await runHorseDailyMappingProducer([DAY,f.journal,f.out],{},deps);
 expect(r.code).toBe(0);expect(JSON.parse(r.output)).toMatchObject({status:'mapped_selection',mapped:1,authority:'missing_input',databaseWrites:false});
 expect(r.output).not.toContain(HAND);expect(readdirSync(f.out).sort()).toEqual(['hand-'+HAND+'.input.json','hand-'+HAND+'.rows.json','manifest.json','report.json'].sort());
 const report=JSON.parse(readFileSync(join(f.out,'report.json'),'utf8'));expect(report.authority).toBe('missing_input');
 expect((await runHorseDailyMappingProducer([DAY,f.journal,f.out],{},deps)).code).toBe(3);
 expect((await runHorseDailyMappingProducer(['2026-02-30',f.journal,f.out],{},deps)).code).toBe(64);
 const shared=join(f.dir,'shared');mkdirSync(shared,{mode:0o755});chmodSync(shared,0o755);expect((await runHorseDailyMappingProducer([DAY,f.journal,shared],{},deps)).code).toBe(3);
 expect((await runHorseDailyMappingProducer([DAY,f.journal,f.journal],{},deps)).code).toBe(3);
}finally{f.cleanup();}});
it('CLI imports without network, output or configuration',async()=>{const network=vi.spyOn(globalThis,'fetch').mockRejectedValue(Error('unexpected transport'));const output=vi.spyOn(process.stdout,'write');
 try{const entry=await import('../../../scripts/horseDailyMappingProducer.ts');expect(typeof entry.runHorseDailyMappingProducer).toBe('function');expect(network).not.toHaveBeenCalled();expect(output).not.toHaveBeenCalled();}finally{network.mockRestore();output.mockRestore();}});
it('a payload-unavailable sibling row for the same hand does not hide an eligible mapping and two Horses share one hand',async()=>{const f=setup();try{
 const sibling={...f.queue,horseId:'20000000-0000-4000-8000-0000000000ff',status:'payload_unavailable',payloadHash:null,eligibility:'unknown',bigBlind:null,committedBb:null,reasons:['daily_payload_unavailable']};
 const r=await run(f,{source:async()=>page([f.queue,sibling])});expect(r.report.rows.map(x=>x.screen)).toEqual([null,'daily_payload_unavailable']);
 expect(r.report.hands).toHaveLength(1);expect(r.report.hands[0].status).toBe('mapped');expect(f.rows).toHaveBeenCalledTimes(1);
}finally{f.cleanup();}});
