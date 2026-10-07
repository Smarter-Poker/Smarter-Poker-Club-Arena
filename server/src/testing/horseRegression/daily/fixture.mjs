import {mkdtempSync,writeFileSync,chmodSync,rmSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {correctiveFixture,authorize,TRUSTED_KEY_DIGEST,HAND,HAND_KEY,TABLE} from '../../../services/horseCorrectiveReview/fixture.test-support.ts';
import {correctiveReferenceBinding} from '../../../services/horseCorrectiveReview/review.ts';
import {horseLifecycleRequestDigest} from '../../../services/horseDecisionJournal/lifecycle.ts';
import {HorseDecisionJournalStore} from '../../../services/horseDecisionJournal/store.ts';
export const DAY='2026-09-10',AT=DAY+'T01:00:00.000001Z';
export const fakeRow=(i=1)=>({playedAt:AT,handId:`30000000-0000-4000-8000-${String(i).padStart(12,'0')}`,
 horseId:'20000000-0000-4000-8000-000000000001',tableId:TABLE,status:'retained_diagnostic',payloadHash:'a'.repeat(64),
 variant:'nlh',format:'cash',eligibility:'over_10bb',bigBlind:'1',committedBb:'21',reasons:['decision_replay_not_matched','reference_not_matched'],gaps:[]});
export const page=(rows=[],after=null,more=false)=>({version:1,source:'horse_commitment_reviews',day:DAY,after,limit:8,
 readAt:'2026-09-14T01:00:00.000000Z',rows,hasMore:more,next:rows.length?{playedAt:rows.at(-1).playedAt,handId:rows.at(-1).handId,horseId:rows.at(-1).horseId}:null,
 dayObservation:'present',sourceCoverage:'not_established',identityBasis:'current_profile_is_horse',gtoVerified:false,activationAllowed:false});
/** Synthetic fn_horse_commitment_selection_receipt reply: one finished pass, no gaps. */
export const passReceipt=(pass=1,extra={})=>({pass,windowStart:DAY+'T00:00:00.000000Z',windowEnd:'2026-09-11T00:00:00.000000Z',
 cutover:'2026-09-11T00:05:00.000000Z',maxScannedCreatedAt:DAY+'T23:59:00.000000Z',scannedHands:12,horseHands:6,flaggedHorseHands:1,
 unknownHorseHands:0,handGaps:0,handsWithoutCommit:0,missingSourceHands:0,lateArrivalHands:0,
 finalCursor:{createdAt:DAY+'T23:59:00.000000Z',handId:'50000000-0000-4000-8000-000000000001'},
 startedAt:'2026-09-11T00:04:00.000000Z',finishedAt:'2026-09-11T00:05:00.000000Z',sourceCoverage:'not_established',identityBasis:'current_profile_is_horse',...extra});
export const dayState=(extra={})=>({pass:1,startedAt:'2026-09-11T00:04:00.000000Z',lastBatchAt:'2026-09-11T00:05:00.000000Z',
 finishedAt:'2026-09-11T00:05:00.000000Z',cursor:{createdAt:DAY+'T23:59:00.000000Z',handId:'50000000-0000-4000-8000-000000000001'},
 scannedHands:12,horseHands:6,flaggedHorseHands:1,unknownHorseHands:0,handGaps:0,...extra});
export const gapRow=(i,reasons,extra={})=>({handId:`60000000-0000-4000-8000-${String(i).padStart(12,'0')}`,tableId:TABLE,
 playedAt:DAY+`T02:00:00.${String(i).padStart(6,'0')}Z`,reasons,...extra});
export const receipt=(gaps=[],after=null,more=false,extra={})=>({version:1,source:'horse_commitment_selection_receipt',day:DAY,
 readAt:'2026-09-14T01:00:00.000000Z',limit:8,after,dayState:dayState(),passes:[passReceipt()],gaps,hasMore:more,
 next:gaps.length?{playedAt:gaps.at(-1).playedAt,handId:gaps.at(-1).handId}:null,
 sourceCoverage:'not_established',identityBasis:'current_profile_is_horse',gtoVerified:false,activationAllowed:false,...extra});
export function privateFixture({legacy=false,changeReference,changeCommitment,changeHand,changeRecords}={}){
 const dir=mkdtempSync(join(realpathSync(tmpdir()),'horse-daily-synthetic-'));chmodSync(dir,0o700);
 try{
 const f=correctiveFixture();const hand=structuredClone(f.hand);changeHand?.(hand);
 const digest=horseLifecycleRequestDigest(f.snapshot);
 let records=legacy?f.records:[f.make('request_lifecycle',1,{version:1,phase:'requested',request:f.snapshot,requestDigest:digest,origin:'worker_compute'}),
  f.make('decision',2,{...f.capture,lifecycleVersion:1}),f.make('request_lifecycle',3,{version:1,phase:'terminal',requestDigest:digest,outcome:'success'}),
  f.make('execution',4,f.witness),f.make('accepted_hand',5,hand)];
 if(changeRecords)records=changeRecords(records,f);
 const d=records.find(r=>r.kind==='decision'),e=records.find(r=>r.kind==='execution'),a=records.find(r=>r.kind==='accepted_hand');
 const commitment={...f.commitments,acceptedHandRecordDigest:a.sha256};changeCommitment?.(commitment);
 const reference=structuredClone(f.reference);if(d&&e)reference.binding=correctiveReferenceBinding(d,e,a);changeReference?.(reference);
 const signed=authorize(commitment,[reference]);
 const put=(name,value)=>{const p=join(dir,name);writeFileSync(p,JSON.stringify(value),{mode:0o600});return p;};
 const journal=join(dir,'journal');const writer=new HorseDecisionJournalStore(journal);
 try{writer.appendBatch(records);}finally{writer.close();}
 const inputPath=put('input.json',{version:1,commitments:commitment,references:[reference]});
 const authorityPath=put('authority.json',signed.envelope);
 const manifest={version:1,day:DAY,journalDirectory:journal,mappings:[{handId:HAND,tableId:TABLE,handKey:HAND_KEY,inputPath,authorityPath}]};
 const manifestPath=put('manifest.json',manifest);
 const row={...fakeRow(),handId:HAND,horseId:f.hero.user_id,payloadHash:commitment.payloadDigest};
 return {dir,put,manifest,manifestPath,row,records,commitment,reference,trust:{correctiveKeyDigest:TRUSTED_KEY_DIGEST,allowSynthetic:true},
  source:async()=>page([row]),selection:async()=>receipt(),cleanup:()=>rmSync(dir,{recursive:true,force:true})};
 }catch(error){rmSync(dir,{recursive:true,force:true});throw error;}
}
