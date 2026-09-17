/** PREPARED, UNEXECUTED. Synthetic inputs and keys only; actual retained record
 * builder, reader, immutable source exporter and private store APIs are used. */
import assert from 'node:assert/strict';
import { it as test } from 'vitest';
import { mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,chmodSync,realpathSync,statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rosterFixture,sync,syntheticAuthority,HAND_KEY,OTHER,CLUB } from './fixture.test-support.mjs';
import { readRosterCapsule,readReturnedRosterTransport,digest } from '../../../services/horseAcceptedRoster/schema.ts';
import { readPrivateAcceptedRoster } from '../../../services/horseAcceptedRoster/reader.ts';
import { createUnsignedAcceptedCommitmentExport as run,ACCEPTED_SOURCE_SELECT } from '../../../services/horseAcceptedRoster/exporter.ts';
import { acceptedRosterEligibility } from '../../../services/horseAcceptedRoster/eligibility.ts';
import { verifyRosterSourceAuthority } from '../../../services/horseAcceptedRoster/authority.ts';
import { runPrivateRosterReview } from '../../../scripts/horseAcceptedRosterReview.ts';
import { journalHash,horseJournalJson } from '../../../services/horseDecisionJournal/record.ts';
import { HorseDecisionJournalStore } from '../../../services/horseDecisionJournal/store.ts';
import { acceptedCommitmentEligibility } from '../../../services/horseCorrectiveReview/eligibility.ts';
import { authorize } from '../../../services/horseCorrectiveReview/fixture.test-support.ts';
const clone=structuredClone;
function qualify(x) { const exported=run(x.input), {envelope,trust}=syntheticAuthority(exported); return acceptedRosterEligibility(x.input,envelope,trust); }
function pinned(x) { const r=x.f.make('accepted_hand',3,x.hand); x.input.records=[r]; x.input.acceptedHandRecordDigest=r.sha256; }
function otherActor(x) { return x.roster.actors.find(a=>a.userId !== x.f.hero.user_id); }
function otherHorse(x,kind) {
  const a=otherActor(x); a.classification='horse';
  x.hand.actions=x.hand.actions.filter(v=>v.userId !== a.userId);
  if (kind) x.hand.actions.push({seat:a.seat,userId:a.userId,action:kind,amount:21,stage:'preflop',timestamp:1});
  sync(x); return a;
}
const conservative=(out)=>{ for(const k of ['completePopulation','sourcePopulationVerified','replayVerified','gtoVerified','activationAllowed']) assert.equal(out[k],false); for(const a of out.actors) assert.equal(a.candidate,null); };
test('private schema is detached, bounded and immutable',()=>{
  const x=rosterFixture(), parsed=readRosterCapsule(x.roster), before=horseJournalJson(parsed);
  assert.ok(parsed); assert.ok(Object.isFrozen(parsed.actors[0]));
  x.roster.actors[0].classification='unknown'; assert.equal(horseJournalJson(parsed),before);
});
test('exact payload text and returned roster join; unsigned data never qualifies',()=>{
  const x=rosterFixture(), out=run(x.input);
  assert.equal(out.sourceExport.status,'unsigned_export',JSON.stringify(out.sourceExport.reasons));
  assert.equal(out.version,2); assert.equal(out.commitments.version,2);
  assert.equal(out.commitments.payloadText,x.row.payload_text);
  assert.equal(out.sourceExport.source.settlementActorCoverage.requestReconciled,true);
  assert.equal(out.sourceExport.authorityQualified,false);
  const q=acceptedRosterEligibility(x.input); assert.equal(q.status,'pending'); conservative(q);
});
test('qualified synthetic positive inspects gross commitments without any strategy finding',()=>{
  const x=rosterFixture(), out=qualify(x);
  assert.equal(out.status,'qualified_monetary_eligibility'); assert.equal(out.evidenceClass,'synthetic_fixture');
  assert.equal(out.actors[0].grossCommittedBb,21); assert.equal(out.acceptedActorClassificationVerified,true);
  assert.ok(out.reasons.includes('synthetic_fixture_not_real_history')); conservative(out);
});
for(const kind of ['sb','bb','post','ante','straddle','bomb_ante',null]) test(`trusted roster includes ${kind ?? 'silent'} Horse without Horse action origins`,()=>{
  const x=rosterFixture(), a=otherHorse(x,kind), out=qualify(x);
  assert.equal(out.status,'qualified_monetary_eligibility');
  const actor=out.actors.find(v=>v.actorRef===journalHash(a.userId));
  assert.equal(actor.eligibility,'over_10bb');
  assert.equal(actor.activity,kind ? 'forced_only_observed_decision_coverage_unknown' : 'silent_actor_decision_coverage_unknown');
  assert.equal(actor.decisionReview,'pending_original_decision_and_qualified_reference'); conservative(out);
});
for(const status of ['profile_missing','classification_null']) test(`unknown ${status} remains in the denominator`,()=>{
  const x=rosterFixture(), a=otherActor(x); a.classification='unknown'; a.status=status; sync(x);
  const out=qualify(x); assert.equal(out.status,'partial_unknown');
  assert.deepEqual(out.unknownActorRefs,[journalHash(a.userId)]); assert.equal(out.acceptedActorClassificationVerified,false); conservative(out);
});
test('known all-human accepted roster differs from legacy empty/unknown population',()=>{
  const x=rosterFixture(); x.roster.actors.forEach(a=>a.classification='human');
  x.hand.actions=x.hand.actions.map(a=>({...a,origin:'player'})); sync(x);
  const out=qualify(x); assert.equal(out.status,'qualified_monetary_eligibility');
  assert.equal(out.acceptedActorClassificationVerified,true); assert.deepEqual(out.actors,[]); conservative(out);
});
for(const [net,refund,over] of [[4,7,true],[0,11,true],[10,0,false],[10,0.01,true],[0,0,false]]) test(`gross ${net}+${refund} strict >10BB`,()=>{
  const x=rosterFixture(), id=x.f.hero.user_id;
  x.payload.accepted_hand_facts.contributions[id]=net; x.payload.accepted_hand_facts.returned_uncalled[id]=refund; sync(x);
  const out=qualify(x); assert.equal(out.status,'qualified_monetary_eligibility');
  assert.equal(out.actors[0].grossCommittedBb,net+refund);
  assert.equal(out.actors[0].eligibility,over?'over_10bb':'not_over_10bb'); conservative(out);
});
for(const [variant,format] of [['nlh','cash'],['plo4','cash'],['plo5','cash'],['plo6','cash'],['nlh','mtt'],['nlh','sng'],['nlh','spin'],['nlh','hu_sng']]) test(`retained commitment independent of format ${variant}/${format}`,()=>{
  const x=rosterFixture(variant,format), out=qualify(x);
  assert.equal(out.status,'qualified_monetary_eligibility'); assert.equal(out.actors[0].eligibility,'over_10bb'); conservative(out);
});
for(const kind of ['nonzero_departure','zero_delta_omission','rebase']) test(`preserves accepted cash ${kind}`,()=>{
  const x=rosterFixture(), s=x.stacks[1];
  if(kind==='rebase') { x.receipt.rebased[x.stacks[0].user_id]=5; x.receipt.written[x.stacks[0].user_id]+=5; }
  else { delete x.receipt.written[s.user_id]; if(kind==='zero_delta_omission') s.stack_before=s.stack;
    else x.receipt.departed.push({user_id:s.user_id,delta:s.stack-s.stack_before,club_id:CLUB,seat_id:s.seat_id,seat_joined_at:s.seat_joined_at}); }
  sync(x); assert.equal(run(x.input).sourceExport.status,'unsigned_export');
});
const schemaNegatives=[
  ['version42',x=>x.roster.version=42],['version string',x=>x.roster.version='1'],
  ['caller boolean',x=>x.roster.actors[0].is_horse=true],
  ['profile private JSON',x=>x.roster.actors[0].horse_profile={secret:'do not disclose'}],
  ['duplicate actor',x=>x.roster.actors[1].userId=x.roster.actors[0].userId],
  ['duplicate physical seat',x=>x.roster.actors[1].seat=x.roster.actors[0].seat],
  ['duplicate seat identity',x=>x.roster.actors[1].seatId=x.roster.actors[0].seatId],
  ['seat zero',x=>x.roster.actors[0].seat=0],['seat eleven',x=>x.roster.actors[0].seat=11],
  ['missing profile labelled human',x=>{otherActor(x).status='profile_missing';}],
  ['unknown canonical boolean',x=>{otherActor(x).classification='unknown';}],
  ['empty actor census',x=>x.roster.actors=[]],
  ['unsorted actor census',x=>x.roster.actors.reverse()],
  ['oversized census',x=>x.roster.actors=Array(11).fill(x.roster.actors[0])],
  ['current-profile basis',x=>x.roster.basis='profiles_read_today'],
  ['bad capture date',x=>x.roster.capturedAt='invalid'],
  ['seat joined after capture',x=>x.roster.actors[0].seatJoinedAt='2099-01-01T00:00:00Z'],
];
for(const [name,change] of schemaNegatives) test(`rejects proposed schema ${name}`,()=>{
  const x=rosterFixture(); change(x); assert.equal(readRosterCapsule(x.roster),null); sync(x);
  assert.equal(run(x.input).sourceExport.status,'unavailable'); assert.equal(qualify(x).status,'pending');
});
const joinNegatives=[
  ['wrong table',x=>x.roster.tableId=OTHER],['wrong hand',x=>x.roster.handId=OTHER],
  ['wrong number',x=>x.roster.handNumber=13],['wrong exact seat',x=>x.roster.actors[0].seatId=OTHER],
  ['wrong joined generation',x=>x.roster.actors[0].seatJoinedAt='2026-09-14T13:00:00.001Z'],
  ['future capture',x=>x.roster.capturedAt='2026-09-14T14:00:02Z'],
  ['origin disagreement',x=>x.roster.actors.find(a=>a.userId===x.f.hero.user_id).classification='human'],
  ['missing contribution',x=>delete x.payload.accepted_hand_facts.contributions[x.f.hero.user_id]],
  ['missing refund map',x=>delete x.payload.accepted_hand_facts.returned_uncalled],
  ['subcent amount',x=>x.payload.accepted_hand_facts.contributions[x.f.hero.user_id]=0.001],
  ['legacy request generation',x=>x.stacks.forEach(s=>{delete s.seat_id;delete s.seat_joined_at;})],
  ['missing stack request',x=>delete x.receipt.request],
  ['written mismatch',x=>x.receipt.written[x.f.hero.user_id]++],
];
for(const [name,change] of joinNegatives) test(`rejects retained/source join ${name}`,()=>{
  const x=rosterFixture(); change(x); sync(x);
  assert.equal(run(x.input).sourceExport.status,'unavailable'); assert.equal(qualify(x).status,'pending');
});
test('legacy stored payload cannot be backfilled by a supplied returned roster',()=>{
  const x=rosterFixture(); delete x.payload.accepted_actor_roster; sync(x);
  const out=run(x.input); assert.equal(out.sourceExport.status,'unavailable');
  assert.ok(out.sourceExport.reasons.includes('accepted_roster_legacy_missing'));
});
for(const version of [42,0,'1',null]) test(`unknown private transport version ${JSON.stringify(version)}`,()=>{
  const x=rosterFixture(); x.hand.acceptedActorRoster.version=version; pinned(x);
  assert.equal(readReturnedRosterTransport(x.hand.acceptedActorRoster),null);
  assert.equal(run(x.input).sourceExport.status,'unavailable');
});
test('missing retained transport is pending even with matching stored payload',()=>{
  const x=rosterFixture(); delete x.hand.acceptedActorRoster; pinned(x);
  const out=run(x.input); assert.ok(out.sourceExport.reasons.includes('retained_roster_missing'));
});
test('reader catches conflicting roster which the existing fixed-field reader omits',()=>{
  const x=rosterFixture(), changed=clone(x.hand); changed.acceptedActorRoster.roster.actors[1].classification='horse';
  changed.acceptedActorRoster.rosterDigest=digest(changed.acceptedActorRoster.roster);
  x.input.records.push(x.f.make('accepted_hand',4,changed));
  assert.equal(run(x.input).sourceExport.status,'unavailable');
});
test('identical accepted replay preserves same roster despite unrelated current profile assertions',()=>{
  const x=rosterFixture(); x.input.records.push(x.f.make('accepted_hand',4,x.hand));
  x.row.currentProfiles=x.roster.actors.map(a=>({userId:a.userId,is_horse:false}));
  const out=run(x.input); assert.equal(out.sourceExport.status,'unsigned_export');
  assert.equal(out.commitments.rosterDigest,digest(x.roster));
  assert.ok(!JSON.stringify(out).includes('currentProfiles'));
});
test('payload bytes, record digest and returned digest corruption cannot qualify',()=>{
  for(const kind of ['payload','record','returned']) {
    const x=rosterFixture();
    if(kind==='payload') x.row.payload_text+=' ';
    if(kind==='record') x.input.records=[{...x.input.records[0],sha256:'0'.repeat(64)}];
    if(kind==='returned') { x.hand.acceptedActorRoster.payloadDigest='0'.repeat(64); pinned(x); }
    assert.equal(run(x.input).sourceExport.status,'unavailable');
  }
});
test('old v1 authority does not authorize new actionless roster evidence',()=>{
  const x=rosterFixture(); otherHorse(x,null); const out=run(x.input), a=authorize(out.commitments,[]);
  assert.equal(acceptedRosterEligibility(x.input,a.envelope).status,'pending');
  assert.equal(acceptedCommitmentEligibility(out.commitments,a.authority,x.hand,x.input.acceptedHandRecordDigest).status,'unavailable');
});
for(const flaw of ['key','producer','synthetic_denied','signature','export_pin','hand_key','extra_authority_field']) test(`independent authority refuses ${flaw}`,()=>{
  const x=rosterFixture(), out=run(x.input), {envelope,trust}=syntheticAuthority(out);
  if(flaw==='key') trust.publicKeyDigest='0'.repeat(64);
  if(flaw==='producer') trust.producerSourceDigest='0'.repeat(64);
  if(flaw==='synthetic_denied') trust.allowSynthetic=false;
  if(flaw==='signature') envelope.signature='A'.repeat(88);
  if(flaw==='export_pin') envelope.authority.exportDigest='0'.repeat(64);
  if(flaw==='hand_key') envelope.authority.handKey='0'.repeat(64);
  if(flaw==='extra_authority_field') envelope.authority.completePopulation=true;
  assert.equal(verifyRosterSourceAuthority(envelope,trust,out,HAND_KEY),null);
  assert.equal(acceptedRosterEligibility(x.input,envelope,trust).status,'pending');
});
test('signature covers full export; rebinding a silent actor invalidates old approval',()=>{
  const x=rosterFixture(), out=run(x.input), {envelope,trust}=syntheticAuthority(out);
  otherHorse(x,null); assert.equal(acceptedRosterEligibility(x.input,envelope,trust).status,'pending');
});
test('source selector remains fixed, read-only, bounded and has no profile fallback',()=>{
  assert.match(ACCEPTED_SOURCE_SELECT,/LIMIT 2/); assert.match(ACCEPTED_SOURCE_SELECT,/post_commit_payload::text/);
  assert.doesNotMatch(ACCEPTED_SOURCE_SELECT,/\b(UPDATE|INSERT|DELETE|profiles)\b/i);
});
test('private CLI reads an actual retained store, stays pending, and cannot overwrite/leak',()=>{
  const directory=realpathSync(mkdtempSync(join(tmpdir(),'horse-roster-synthetic-')));
  try {
    chmodSync(directory,0o700); const journal=join(directory,'journal'); mkdirSync(journal,{mode:0o700});
    const x=rosterFixture(), store=new HorseDecisionJournalStore(journal); store.appendBatch(x.input.records); store.close();
    const db=join(journal,'horse-decisions.sqlite'), before=journalHash(readFileSync(db).toString('base64'));
    const raw=join(directory,'raw.json'), output=join(directory,'output.json');
    writeFileSync(raw,JSON.stringify({version:1,rows:x.input.rows}),{mode:0o600});
    const args=[journal,HAND_KEY,x.input.acceptedHandRecordDigest,raw,output];
    const result=runPrivateRosterReview(args,{}); assert.equal(result.code,2);
    assert.doesNotMatch(result.output,/SYNTHETIC_PRIVATE_NAME|payloadText|20000000|As|Kd/);
    assert.equal(statSync(output).mode & 0o077,0); assert.equal(journalHash(readFileSync(db).toString('base64')),before);
    assert.equal(runPrivateRosterReview(args,{}).code,3);
    const artifact=JSON.parse(readFileSync(output,'utf8')); conservative(artifact.eligibility);
    assert.ok(!JSON.stringify(artifact.exported).includes('SYNTHETIC_PRIVATE_NAME'));
    chmodSync(raw,0o644); assert.equal(runPrivateRosterReview([...args.slice(0,4),join(directory,'refused.json')],{}).code,3);
  } finally {rmSync(directory,{recursive:true,force:true});}
});
test('canonical seat10 and ten-actor accepted census are bounded without enabling ten-seat gameplay',()=>{
  const x=rosterFixture(), used=new Set(x.roster.actors.map(a=>a.seat));
  for(let seat=1;seat<=10;seat++) {
    if(used.has(seat)) continue;
    const suffix=String(seat).padStart(12,'0');
    const a={userId:`60000000-0000-4000-8000-${suffix}`,seat,seatId:`80000000-0000-4000-8000-${suffix}`,
      seatJoinedAt:'2026-09-14T13:00:00.000Z',classification:'human',status:'canonical_boolean'};
    x.roster.actors.push(a); x.stacks.push({user_id:a.userId,stack:0,stack_before:0,seat_id:a.seatId,seat_joined_at:a.seatJoinedAt});
    x.receipt.written[a.userId]=0; x.payload.accepted_hand_facts.contributions[a.userId]=0;
  }
  x.roster.actors.sort((a,b)=>a.userId.localeCompare(b.userId)); x.receipt.players=10;
  x.row.players_text=JSON.stringify(x.roster.actors.map(a=>({userId:a.userId,seat:a.seat})));
  sync(x); assert.equal(readRosterCapsule(x.roster).actors.length,10);
  const out=qualify(x); assert.equal(out.status,'qualified_monetary_eligibility'); conservative(out);
});
