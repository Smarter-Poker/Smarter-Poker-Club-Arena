/** PREPARED SYNTHETIC FIXTURES ONLY. These are not captured database rows. */
import { generateKeyPairSync, sign } from 'node:crypto';
import { correctiveFixture, HAND_KEY, HAND, TABLE } from '../../../services/horseCorrectiveReview/fixture.test-support.ts';
import { journalHash } from '../../../services/horseDecisionJournal/record.ts';
import { digest } from '../../../services/horseAcceptedRoster/schema.ts';
import { readAcceptedRosterReturn, ACCEPTED_ROSTER_PRODUCER_VERSION } from '../../../services/horseAcceptedRoster/acceptance.ts';
import { rosterAuthoritySigningBytes } from '../../../services/horseAcceptedRoster/authority.ts';
export { HAND_KEY, HAND, TABLE };
export const OTHER = '90000000-0000-4000-8000-000000000009';
export const CLUB = '90000000-0000-4000-8000-000000000008';
export function rosterFixture(variant='nlh', format='cash') {
  const f = correctiveFixture(variant, format), players = f.snapshot.gameState.players;
  const stacks = players.map((p,i) => ({user_id:p.user_id,stack:i === 0 ? 121 : 0,stack_before:i === 0 ? 100 : 21,
    seat_id:`70000000-0000-4000-8000-00000000000${i+1}`,seat_joined_at:'2026-09-14T13:00:00.123456+00:00'}));
  const receipt = {success:true,table_id:TABLE,hand_id:OTHER,hand_number:12,players:2,mode:'delta',
    written:Object.fromEntries(stacks.map(s => [s.user_id,s.stack])),departed:[],rebased:{},
    tournament_id:format === 'cash' ? null : OTHER,request:{stacks,rake:0,bbj:0,inflow:0}};
  const roster = {version:1,basis:'profiles_read_in_acceptance_transaction',tableId:TABLE,handId:HAND,
    handNumber:12,capturedAt:'2026-09-14T14:00:00.000000Z',actors:players.map((p,i) => ({userId:p.user_id,seat:p.seat,
      seatId:stacks[i].seat_id,seatJoinedAt:stacks[i].seat_joined_at,classification:i === 0 ? 'horse' : 'human',status:'canonical_boolean'})).sort((a,b)=>a.userId.localeCompare(b.userId))};
  // P14.2: the door leaves post_commit_payload byte-identical; the roster lives
  // only in the discriminator row (roster_* columns, written by sync).
  const payload = JSON.parse(f.commitments.payloadText);
  const row = {hand_id:HAND,table_id:TABLE,hand_number:'12',atomic_hand_id:HAND,atomic_table_id:TABLE,
    atomic_hand_number:'12',big_blind:'1.00',game_variant:variant,tournament_id:receipt.tournament_id,
    actions_text:'',players_text:JSON.stringify(players.map(p=>({userId:p.user_id,seat:p.seat,username:'SYNTHETIC_PRIVATE_NAME',cards:['As','Kd']}))),
    payload_text:'',payload_digest:'',core_payload_digest:'c'.repeat(64),post_commit_request_digest:'d'.repeat(64),
    roster_hand_id:null,roster_status:null,roster_payload_digest:null,roster_producer_version:null,roster_text:null,
    stack_result_text:'',committed_at:'2026-09-14T14:00:00.000Z',post_commit_completed_at:null,
    read_at:'2026-09-14T14:00:01.000Z',snapshot_id:'20:30:22,24'};
  const x = {f,roster,payload,row,receipt,stacks,hand:structuredClone(f.hand),input:{records:[],handKey:HAND_KEY,acceptedHandRecordDigest:'',rows:[row]}};
  sync(x); return x;
}
/** Emulates the settlement door's private success field (P14.2) and its
 * first-write discriminator row (the only place the roster lives), copies the
 * result through the engine's actual acceptance reader, and records it with
 * the actual immutable journal builder. Synthetic: no SQL producer ran.
 * `x.provenance`: undefined = a captured row for x.roster; null = no row (a
 * legacy hand); a function edits the derived row (the forged cases). */
export function sync(x) {
  x.row.payload_text=JSON.stringify(x.payload,null,1); x.row.payload_digest=journalHash(x.row.payload_text);
  x.row.stack_result_text=JSON.stringify(x.receipt); x.row.actions_text=JSON.stringify(x.hand.actions);
  const captured=x.provenance!==null;
  x.result={version:1,status:captured?'captured':'legacy_missing',reasons:captured?[]:['accepted_roster_not_recorded'],
    payloadDigest:x.row.payload_digest,producerVersion:ACCEPTED_ROSTER_PRODUCER_VERSION,roster:captured?x.roster:null};
  const provenance=captured?{roster_hand_id:HAND,roster_status:'captured',roster_payload_digest:x.row.payload_digest,
    roster_producer_version:ACCEPTED_ROSTER_PRODUCER_VERSION,roster_text:JSON.stringify(x.roster)}:
    {roster_hand_id:null,roster_status:null,roster_payload_digest:null,roster_producer_version:null,roster_text:null};
  if(typeof x.provenance==='function') x.provenance(provenance);
  Object.assign(x.row,provenance);
  // The engine's own copy when the door-shaped capsule binds; a deliberately
  // broken fixture keeps its raw transport so the reader is what refuses it.
  const read=readAcceptedRosterReturn(x.result,{tableId:TABLE,handNumber:12,historyId:HAND,payloadDigest:x.row.payload_digest});
  x.hand.acceptedActorRoster=read.status==='captured'?structuredClone(read.transport):
    {version:1,payloadDigest:x.row.payload_digest,rosterDigest:digest(x.roster),roster:x.roster};
  const accepted=x.f.make('accepted_hand',3,x.hand);
  // Use only the accepted hand: retained decision coverage is deliberately
  // unknown. Monetary qualification must not invent any decision or lifecycle.
  x.input.records=[accepted]; x.input.acceptedHandRecordDigest=accepted.sha256;
}
export function syntheticAuthority(exported, change=()=>{}) {
  const pair=generateKeyPairSync('ed25519');
  const authority={version:1,role:'accepted_roster_source',handKey:HAND_KEY,qualificationId:'synthetic-roster-only',
    evidenceClass:'synthetic_fixture',producerSourceDigest:'e'.repeat(64),exportDigest:digest(exported)};
  change(authority);
  const envelope={authority,publicKeyPem:pair.publicKey.export({type:'spki',format:'pem'}).toString(),
    signature:sign(null,rosterAuthoritySigningBytes(authority),pair.privateKey).toString('base64')};
  const trust={publicKeyDigest:journalHash(pair.publicKey.export({type:'spki',format:'der'}).toString('base64')),
    producerSourceDigest:'e'.repeat(64),allowSynthetic:true};
  return {envelope,trust};
}
