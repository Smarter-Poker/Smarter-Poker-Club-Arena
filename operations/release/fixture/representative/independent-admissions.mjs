import assert from 'node:assert/strict';
export async function admitIndependentGroups(groups, admit) {
 let firstFailure;
 const outcomes=await Promise.all(groups.map(group=>Promise.resolve().then(()=>admit(group)).then(value=>({ok:true,value}),error=>{firstFailure??=error;return {ok:false,error};})));
 if(firstFailure)throw firstFailure;return outcomes.map(o=>o.value);
}
export async function admitIndependentBatches(groups,width,admit){
 if(!Number.isSafeInteger(width)||width<1||width>8)throw new Error('Independent admission width exceeds finite ceiling');
 const results=[];for(let offset=0;offset<groups.length;offset+=width)results.push(...await admitIndependentGroups(groups.slice(offset,offset+width),admit));return results;
}

// Keep the original observer promise owned immediately and inside the admission
// batch. Its real first frame, not only its purchase, spends the width slot.
export async function admitTrackedSeed(group,tasks,admit){
 const task=Promise.resolve().then(()=>admit(group)).then(value=>({ok:true,value}),error=>({ok:false,error}));
 tasks.push(task);
 const outcome=await task;
 if(!outcome.ok)throw outcome.error;
 return outcome.value;
}

// An empty-table state read establishes setup readiness only. It never admits a
// playing actor, and must not replace the later native-chair/first-frame proof.
export function assertEmptyTableReady({group,chairs,wire}){
 assert.ok(Array.isArray(chairs));assert.equal(chairs.length,0,'Pre-purchase table is occupied');
 assert.equal(wire.table_id,group.tableId);assert.equal(wire.stage,'waiting');
 assert.ok(Array.isArray(wire.players));assert.equal(wire.players.length,0,'Empty table has stale dealer players');
 assert.equal(wire.current_player,null,'Empty table has an actionable pointer');
 for(const field of ['pot','current_bet','turn_start_time_ms','turn_duration_ms','turn_deadline_ms'])assert.equal(wire[field],0,'Empty table has a live pot or clock');
 assert.deepEqual(wire.community_cards,[]);assert.deepEqual(wire.winner_ids,[]);
 assert.ok(Number.isSafeInteger(wire.hand_number)&&wire.hand_number>=0,'Dealer state is not initialized');
 assert.equal(wire.max_seats,group.count,'Dealer capacity differs from planned table');
 return true;
}

// Two finite foreground pools overlap independent work without detaching actual
// subscriptions. A group's remaining purchases require its own real seed frame.
export async function admitPipelinedGroups(groups,{width=8,financialSeed,observeSeed,financialCompletion,prepare,onFailure=()=>{},getFailure=()=>undefined}){
 if(!Number.isSafeInteger(width)||width<1||width>8)throw new Error('Independent admission width exceeds finite ceiling');
 let firstFailure;
 const queues=[];
 const fail=error=>{if(!firstFailure){firstFailure=error;for(const queue of queues)queue.stop(error);onFailure(error);}return firstFailure;};
 function pool(){let active=0;const waiting=[];
  const next=()=>{if(!firstFailure&&getFailure())fail(getFailure());while(!firstFailure&&active<width&&waiting.length){const item=waiting.shift();active++;Promise.resolve().then(()=>{if(getFailure())fail(getFailure());if(firstFailure)throw firstFailure;return item.run();}).then(value=>item.resolve({ok:true,value}),error=>item.resolve({ok:false,error:fail(error)})).finally(()=>{active--;next();});}};
  const queue={stop:error=>{for(const item of waiting.splice(0))item.resolve({ok:false,error});},run:run=>new Promise(resolve=>{if(firstFailure){resolve({ok:false,error:firstFailure});return;}waiting.push({run,resolve});next();})};queues.push(queue);return queue;
 }
 const financial=pool(),seeds=pool();
 async function step(queue,run){const outcome=await queue.run(run);if(!outcome.ok)throw outcome.error;return outcome.value;}
 const outcomes=await Promise.all(groups.map(group=>Promise.resolve().then(async()=>{
  await step(financial,()=>financialSeed(group));
  if(observeSeed&&group.kind==='cash')await step(seeds,()=>observeSeed(group));
  if(financialCompletion&&group.kind==='cash')await step(financial,()=>financialCompletion(group));
  if(getFailure())fail(getFailure());if(firstFailure)throw firstFailure;
  return prepare?await prepare(group):undefined;
 }).then(value=>({ok:true,value}),error=>({ok:false,error:fail(error)}))));
 if(firstFailure)throw firstFailure;
 return outcomes.map(outcome=>outcome.value);
}
