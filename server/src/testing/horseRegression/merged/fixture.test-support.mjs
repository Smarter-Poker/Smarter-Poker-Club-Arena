/** PREPARED SYNTHETIC FIXTURES ONLY. These are not captured database rows. */
import { generateKeyPairSync, sign } from 'node:crypto';
import { correctiveFixture, HAND_KEY, HAND, TABLE } from '../../../services/horseCorrectiveReview/fixture.test-support.ts';
import { journalHash } from '../../../services/horseDecisionJournal/record.ts';
import { digest } from '../../../services/horseAcceptedRoster/schema.ts';
import { rosterAuthoritySigningBytes } from '../../../services/horseAcceptedRoster/authority.ts';
export { HAND_KEY, HAND, TABLE };
export const OTHER = '90000000-0000-4000-8000-000000000009';
export const CLUB = '90000000-0000-4000-8000-000000000008';
export function rosterFixture(variant='nlh', format='cash') {
  const f = correctiveFixture(variant, format), players = f.snapshot.gameState.players;
  const stacks = players.map((p,i) => ({user_id:p.user_id,stack:i === 0 ? 121 : 0,stack_before:i === 0 ? 100 : 21,
    seat_id:`70000000-0000-4000-8000-00000000000${i+1}`,seat_joined_at:'2026-09-14T13:00:00.000Z'}));
  const receipt = {success:true,table_id:TABLE,hand_id:OTHER,hand_number:12,players:2,mode:'delta',
    written:Object.fromEntries(stacks.map(s => [s.user_id,s.stack])),departed:[],rebased:{},
    tournament_id:format === 'cash' ? null : OTHER,request:{stacks,rake:0,bbj:0,inflow:0}};
  const roster = {version:1,basis:'profiles_read_in_acceptance_transaction',tableId:TABLE,handId:HAND,
    handNumber:12,capturedAt:'2026-09-14T14:00:00.000Z',actors:players.map((p,i) => ({userId:p.user_id,seat:p.seat,
      seatId:stacks[i].seat_id,seatJoinedAt:stacks[i].seat_joined_at,classification:i === 0 ? 'horse' : 'human',status:'canonical_boolean'})).sort((a,b)=>a.userId.localeCompare(b.userId))};
  const payload = {...JSON.parse(f.commitments.payloadText),accepted_actor_roster:roster};
  const row = {hand_id:HAND,table_id:TABLE,hand_number:'12',atomic_hand_id:HAND,atomic_table_id:TABLE,
    atomic_hand_number:'12',big_blind:'1.00',game_variant:variant,tournament_id:receipt.tournament_id,
    actions_text:'',players_text:JSON.stringify(players.map(p=>({userId:p.user_id,seat:p.seat,username:'SYNTHETIC_PRIVATE_NAME',cards:['As','Kd']}))),
    payload_text:'',payload_digest:'',core_payload_digest:'c'.repeat(64),post_commit_request_digest:'d'.repeat(64),
    stack_result_text:'',committed_at:'2026-09-14T14:00:00.000Z',post_commit_completed_at:null,
    read_at:'2026-09-14T14:00:01.000Z',snapshot_id:'20:30:22,24'};
  const x = {f,roster,payload,row,receipt,stacks,hand:structuredClone(f.hand),input:{records:[],handKey:HAND_KEY,acceptedHandRecordDigest:'',rows:[row]}};
  sync(x); return x;
}
/** Emulates future private returned transport and records it with the actual
 * immutable journal builder. Does not pretend the SQL producer exists. */
export function sync(x) {
  x.row.payload_text=JSON.stringify(x.payload,null,1); x.row.payload_digest=journalHash(x.row.payload_text);
  x.row.stack_result_text=JSON.stringify(x.receipt); x.row.actions_text=JSON.stringify(x.hand.actions);
  x.hand.acceptedActorRoster={version:1,payloadDigest:x.row.payload_digest,rosterDigest:digest(x.roster),roster:x.roster};
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
