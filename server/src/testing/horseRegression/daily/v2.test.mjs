/** All source rows, roster capsules and both signer domains below are synthetic.
 * Uses the selected core/exporter unchanged; no accepted DB producer is inferred. */
import {it,expect} from 'vitest';
import {join} from 'node:path';
import {rosterFixture,sync,syntheticAuthority,HAND_KEY} from './roster-fixture.mjs';
import {journalHash} from '../../../services/horseDecisionJournal/record.ts';
import {privateFixture,page} from './fixture.mjs';
import {authorize} from '../../../services/horseCorrectiveReview/fixture.test-support.ts';
import {createUnsignedAcceptedCommitmentExport} from '../../../services/horseAcceptedRoster/exporter.ts';
import {horseLifecycleRequestDigest} from '../../../services/horseDecisionJournal/lifecycle.ts';
import {correctiveReferenceBinding} from '../../../services/horseCorrectiveReview/review.ts';
import {HorseDecisionJournalStore} from '../../../services/horseDecisionJournal/store.ts';
import {reviewDailySelection} from '../../../services/horseDailyCorrectiveReview/batch.ts';
function setup({unknown=false,acceptedOnly=false}={}){
 const f=privateFixture();
 try{
 const x=rosterFixture();
 if(unknown){const actor=x.roster.actors.find(a=>a.userId!==x.f.hero.user_id);actor.classification='unknown';actor.status='profile_missing';}
 sync(x);const digest=horseLifecycleRequestDigest(x.f.snapshot),make=x.f.make;
 const records=acceptedOnly?[make('accepted_hand',5,x.hand)]:[
  make('request_lifecycle',1,{version:1,phase:'requested',request:x.f.snapshot,requestDigest:digest,origin:'worker_compute'}),
  make('decision',2,{...x.f.capture,lifecycleVersion:1}),make('request_lifecycle',3,{version:1,phase:'terminal',requestDigest:digest,outcome:'success'}),
  make('execution',4,x.f.witness),make('accepted_hand',5,x.hand)];
 x.input.records=records;x.input.acceptedHandRecordDigest=records.at(-1).sha256;
 const exported=createUnsignedAcceptedCommitmentExport(x.input);expect(exported.sourceExport.status).toBe('unsigned_export');
 const reference=structuredClone(x.f.reference);if(!acceptedOnly)reference.binding=correctiveReferenceBinding(records[1],records[3],records[4]);
 const referenceAuthority=authorize(exported.commitments,[reference]),rosterAuthority=syntheticAuthority(exported);
 const journal=join(f.dir,'v2-journal'),writer=new HorseDecisionJournalStore(journal);try{writer.appendBatch(records);}finally{writer.close();}
 const input={version:2,commitments:exported.commitments,references:[reference],rosterSource:{version:1,rows:x.input.rows,authorityEnvelope:rosterAuthority.envelope}};
 const inputPath=f.put('v2-input.json',input),authorityPath=f.put('v2-authority.json',referenceAuthority.envelope);
 f.manifest.journalDirectory=journal;f.manifest.mappings[0].inputPath=inputPath;f.manifest.mappings[0].authorityPath=authorityPath;
 f.trust.rosterKeyDigest=rosterAuthority.trust.publicKeyDigest;f.trust.rosterProducerDigest=rosterAuthority.trust.producerSourceDigest;
 f.row.payloadHash=exported.commitments.payloadDigest;
 return {...f,input,records};
 }catch(error){f.cleanup();throw error;}
}
for(const flaw of ['none','unknown_actor','accepted_only','missing_roster','wrong_roster_key','wrong_producer','invalid_signature','roster_provenance_missing','roster_provenance_mismatch','payload_roster_unprovenanced'])it(`actual v2 source and reference domains ${flaw}`,async()=>{
 const f=setup({unknown:flaw==='unknown_actor',acceptedOnly:flaw==='accepted_only'});
 try{
  if(flaw==='missing_roster'){delete f.input.rosterSource;f.put('v2-input.json',f.input);}
  // P14.2: the same signed rows, but the payload roster has no (or a different)
  // first-write discriminator row behind it: the caller-injected key case.
  if(flaw==='roster_provenance_missing'){Object.assign(f.input.rosterSource.rows[0],{roster_hand_id:null,roster_status:null,roster_payload_digest:null,roster_producer_version:null,roster_text:null});f.put('v2-input.json',f.input);}
  // A roster key forged into the stored payload (same discriminator row).
  // Every digest is recomputed so the forged key is the only difference.
  if(flaw==='payload_roster_unprovenanced'){const row=f.input.rosterSource.rows[0],payload=JSON.parse(row.payload_text);payload.accepted_actor_roster=JSON.parse(row.roster_text);
   row.payload_text=JSON.stringify(payload);row.payload_digest=row.roster_payload_digest=journalHash(row.payload_text);f.put('v2-input.json',f.input);
   const refused=createUnsignedAcceptedCommitmentExport({records:f.records,handKey:HAND_KEY,acceptedHandRecordDigest:f.records.at(-1).sha256,rows:[row]});
   expect(refused.sourceExport.reasons).toContain('payload_roster_unprovenanced');}
  if(flaw==='roster_provenance_mismatch'){f.input.rosterSource.rows[0].roster_status='unavailable';f.put('v2-input.json',f.input);}
  if(flaw==='wrong_roster_key')f.trust.rosterKeyDigest='b'.repeat(64);
  if(flaw==='wrong_producer')f.trust.rosterProducerDigest='c'.repeat(64);
  if(flaw==='invalid_signature'){f.input.rosterSource.authorityEnvelope.signature='A'.repeat(88);f.put('v2-input.json',f.input);}
  const r=await reviewDailySelection(f.manifest,async()=>page([f.row]),f.trust,f.selection);
  expect(r.status).toBe(flaw==='none'?'reviewed_selection':'incomplete');
  expect(r.rows[0].status).toBe(flaw==='none'?'reviewed_retained_menu':'pending');
  if(flaw==='none')expect(r.rows[0].actor.decisions[0].candidate.activationAllowed).toBe(false);
  else expect(r.rows[0].actor).toBeNull();
  expect(r.fullWindow).toBe(false);expect(r.sourcePopulationVerified).toBe(false);expect(r.gtoVerified).toBe(false);
 }finally{f.cleanup();}
});
