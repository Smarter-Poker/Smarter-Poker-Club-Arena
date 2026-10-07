import test from 'node:test';import assert from 'node:assert/strict';import {admitIndependentGroups,admitIndependentBatches,admitTrackedSeed,assertEmptyTableReady,admitPipelinedGroups} from './independent-admissions.mjs';
test('independent admissions start together and retain the first refusal while draining all outcomes',async()=>{const started=[];const ended=[];const releases=new Map();const fail=new Error('original-admission-refusal');const pending=admitIndependentGroups([1,2,3],g=>{started.push(g);return new Promise((resolve,reject)=>releases.set(g,{resolve,reject})).finally(()=>ended.push(g));});await new Promise(r=>setImmediate(r));assert.deepEqual(started,[1,2,3]);releases.get(2).reject(fail);await new Promise(r=>setImmediate(r));assert.deepEqual(ended,[2]);releases.get(1).resolve(1);releases.get(3).resolve(3);await assert.rejects(pending,e=>e===fail);assert.equal(ended.length,3);});
test('bounded financial admissions drain first failed batch and never begin its successor',async()=>{let active=0,max=0;const started=[];const ended=[];const failure=new Error('exact-buyin-refusal');await assert.rejects(admitIndependentBatches([1,2,3,4,5],2,async g=>{started.push(g);max=Math.max(max,++active);try{await new Promise(r=>setImmediate(r));if(g===2)throw failure;}finally{active--;ended.push(g);}}),e=>e===failure);assert.equal(max,2);assert.deepEqual(started,[1,2]);assert.equal(active,0);assert.equal(ended.length,2);});

test('the first frame keeps each of eighty seeds inside the eight-admission ceiling',async()=>{
 const groups=Array.from({length:80},(_,i)=>i);
 async function run(detached){let active=0,max=0;const releases=[];const tasks=[];const observer=()=>{max=Math.max(max,++active);return new Promise(resolve=>releases.push(()=>{active--;resolve();}));};
 const pending=admitIndependentBatches(groups,8,async group=>{if(detached){tasks.push(observer().then(()=>({ok:true})));}else await admitTrackedSeed(group,tasks,observer);});
 await new Promise(resolve=>setImmediate(resolve));
 if(detached){assert.equal(releases.length,80);releases.splice(0).forEach(release=>release());}else{assert.equal(releases.length,8);for(let wave=0;wave<10;wave++){assert.equal(releases.length,8);releases.splice(0).forEach(release=>release());await new Promise(resolve=>setImmediate(resolve));}}
 await pending;await Promise.all(tasks);assert.equal(active,0);return max;}
 assert.equal(await run(true),80);assert.equal(await run(false),8);
});
test('original seed refusal drains its batch and prevents further purchases',async()=>{const failure=new Error('original-frame-timeout');const tasks=[];const starts=[];const releases=new Map();const run=admitIndependentBatches([0,1,2],2,group=>admitTrackedSeed(group,tasks,g=>{starts.push(g);return new Promise((resolve,reject)=>releases.set(g,{resolve,reject}));}));run.catch(()=>{});await new Promise(resolve=>setImmediate(resolve));releases.get(0).reject(failure);await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(starts,[0,1]);releases.get(1).resolve();await assert.rejects(run,error=>error===failure);assert.equal(tasks.length,2);assert.deepEqual((await Promise.all(tasks)).map(x=>x.ok),[false,true]);});

test('pre-purchase readiness needs actual empty initialized dealer and native roster',()=>{
 const group={tableId:'owned-table',count:6},wire={table_id:group.tableId,stage:'waiting',players:[],current_player:null,hand_number:0,max_seats:6,pot:0,current_bet:0,turn_start_time_ms:0,turn_duration_ms:0,turn_deadline_ms:0,community_cards:[],winner_ids:[]};
 assert.equal(assertEmptyTableReady({group,chairs:[],wire}),true);
 for(const changed of [{table_id:'foreign-table'},{stage:'preflop'},{players:[{user_id:'retired'}]},{current_player:'retired'},{hand_number:undefined},{max_seats:9}])assert.throws(()=>assertEmptyTableReady({group,chairs:[],wire:{...wire,...changed}}));
 assert.throws(()=>assertEmptyTableReady({group,chairs:[{table_id:group.tableId}],wire}));
 assert.throws(()=>assertEmptyTableReady({group,chairs:[],wire:{table_id:group.tableId,stage:'idle',players:[]}}));
});


test('separate bounded pools admit each remaining roster after its own seed without a global barrier',async()=>{
 const groups=Array.from({length:80},(_,index)=>({index,kind:'cash'}));
 let financial=0,seed=0,maxFinancial=0,maxSeed=0;const ready=new Set(),completed=[],events=[];
 const wait=()=>new Promise(resolve=>setImmediate(resolve));
 const buy=async(group,phase)=>{maxFinancial=Math.max(maxFinancial,++financial);events.push([phase,group.index]);try{if(phase==='remaining')assert.ok(ready.has(group.index));await wait();}finally{financial--;}};
 await admitPipelinedGroups(groups,{financialSeed:g=>buy(g,'seed-buy'),observeSeed:async g=>{maxSeed=Math.max(maxSeed,++seed);try{await wait();ready.add(g.index);events.push(['ready',g.index]);}finally{seed--;}},financialCompletion:g=>buy(g,'remaining'),prepare:async g=>{assert.ok(ready.has(g.index));completed.push(g.index);}});
 assert.equal(maxFinancial,8);assert.equal(maxSeed,8);assert.equal(financial,0);assert.equal(seed,0);assert.equal(completed.length,80);
 assert.ok(events.findIndex(e=>e[0]==='remaining')<events.findIndex(e=>e[0]==='ready'&&e[1]===79),'Remaining purchases still wait behind all eighty frames');
});

test('seed refusal owns queued outcomes, drains active observers and never starts queued successor purchases',async()=>{
 const failure=new Error('original-seed-refusal'),starts=[],releases=new Map(),remaining=[];
 const pending=admitPipelinedGroups(Array.from({length:20},(_,index)=>({index,kind:'cash'})),{width:2,financialSeed:async g=>{starts.push(g.index);},observeSeed:g=>new Promise((resolve,reject)=>releases.set(g.index,{resolve,reject})),financialCompletion:async g=>remaining.push(g.index)});pending.catch(()=>{});
 await new Promise(resolve=>setImmediate(resolve));assert.deepEqual([...releases.keys()],[0,1]);
 releases.get(0).reject(failure);await new Promise(resolve=>setImmediate(resolve));const startedAtFailure=[...starts];assert.equal(remaining.length,0);
 let drained=false;pending.finally(()=>{drained=true;}).catch(()=>{});await new Promise(resolve=>setImmediate(resolve));assert.equal(drained,false);
 releases.get(1).resolve();await assert.rejects(pending,error=>error===failure);assert.deepEqual(starts,startedAtFailure);assert.deepEqual([...releases.keys()],[0,1]);assert.deepEqual(remaining,[]);
});

test('an already admitted actor refusal stops queued source operations without losing current owners',async()=>{
 let external;const error=new Error('original-live-actor-refusal'),started=[],releases=[];
 const pending=admitPipelinedGroups(Array.from({length:4},(_,index)=>({index,kind:'cash'})),{width:2,getFailure:()=>external,financialSeed:g=>{started.push(g.index);return new Promise(resolve=>releases.push(resolve));}});pending.catch(()=>{});
 await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(started,[0,1]);external=error;releases.forEach(resolve=>resolve());await assert.rejects(pending,e=>e===error);assert.deepEqual(started,[0,1]);
});
