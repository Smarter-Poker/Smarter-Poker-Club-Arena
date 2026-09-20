/** Deliberate local fault injection exercises adapter refusal boundaries; it is
 * not a claim that the actual core can produce these oversized fields. */
import {it,expect,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import * as core from '../../../services/horseCorrectiveReview/review.ts';
import {HorseDecisionJournalStore} from '../../../services/horseDecisionJournal/store.ts';
import {reviewDailySelection} from '../../../services/horseDailyCorrectiveReview/batch.ts';
import {runHorseDailyCorrectiveReview} from '../../../scripts/horseDailyCorrectiveReview.ts';
import {privateFixture} from './fixture.mjs';
it('reader close failure refuses aggregate success even after an otherwise qualified row',async()=>{const f=privateFixture(),original=HorseDecisionJournalStore.prototype.close;const close=vi.spyOn(HorseDecisionJournalStore.prototype,'close').mockImplementation(function(){original.call(this);throw Error('synthetic cleanup failure');});try{const r=await reviewDailySelection(f.manifest,f.source,f.trust);expect(r.status).toBe('incomplete');expect(r.reasons).toContain('private_reader_cleanup_unavailable');expect(r.gtoVerified).toBe(false);}finally{close.mockRestore();f.cleanup();}});
for(const totalBytes of [524287,524288,524289])it(`CLI artifact budgets final newline at JSON bytes ${totalBytes}`,async()=>{
 const f=privateFixture(),original=core.reviewHorseCorrectiveHand;let padding='';
 const spy=vi.spyOn(core,'reviewHorseCorrectiveHand').mockImplementation((input,options)=>{const r=original(input,options);r.actors[0].syntheticOutputPadding=padding;return r;});
 try{
  const measured=await reviewDailySelection(f.manifest,f.source,f.trust);expect(measured.status).toBe('reviewed_selection');
  padding='x'.repeat(totalBytes-Buffer.byteLength(JSON.stringify(measured)));
  const output=join(f.dir,'size.json');const result=await runHorseDailyCorrectiveReview([f.manifestPath,output],{},{source:f.source,trust:f.trust});
  expect(result.code).toBe(totalBytes===524287?0:2);
  const bytes=readFileSync(output);expect(bytes.length).toBeLessThanOrEqual(524288);
  const saved=JSON.parse(bytes);expect(saved.status).toBe(totalBytes===524287?'reviewed_selection':'incomplete');
  if(totalBytes>524287){expect(saved.reasons).toContain('daily_output_bounds');expect(saved.rows[0].actor).toBeNull();}
 }finally{spy.mockRestore();f.cleanup();}
});
