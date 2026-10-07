import {prepareReentryQuotes} from './reentry-quotes.mjs';
import fs from 'node:fs';
import {cashSeedReady} from './cash-seed-admission.mjs';
import {witnessNaturalBlindEntry} from './post-bb-observation.mjs';
import {recoverPurchases} from './purchase-journal.mjs';
import {admitIndependentGroups,admitIndependentBatches} from './independent-admissions.mjs';
import {handoffObservers} from './observer-handoff.mjs';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {monitorEventLoopDelay} from 'node:perf_hooks';
import {mixedPlan,assertCashSetupComplete} from './ramp-plan.mjs';
import {startRampActors} from './ramp-actors-cohorted-v5.mjs';
import {readTournamentWitness,registerTournamentActor} from './tournament-adapter.mjs';
import {readCoherentAdmission} from './ramp-admission.mjs';
import {runRampTournamentActors} from './ramp-tournament-actors-coherent.mjs';

// Foreground-only finite qualification. Every mode is an explicit invocation.
// No automatic stage advancement, financial retry, repair or production route.
const [mode,sizeText]=process.argv.slice(2),size=Number(sizeText),plan=mixedPlan(size);
assert.ok(['admit','resume-admit','continuous','play'].includes(mode));
const root='/qualification/',dir=root+'representative-load/';
const keys=JSON.parse(fs.readFileSync(root+'synthetic-keys.json'));
const ownerPath=root+'synthetic-users.json';const originalUsers=JSON.parse(fs.readFileSync(ownerPath));const owner=originalUsers[2];
const path=dir+`ramp-${size}-private.json`;
const state=fs.existsSync(path)?JSON.parse(fs.readFileSync(path)):{runId:randomUUID(),stage:'new',plan,groups:[],clubs:[],operations:[],product_certificate:false};
const resultPath=dir+`ramp-${size}${state.attempt>1?'-attempt'+state.attempt:''}-result.json`;
assert.equal(state.plan.size,size);assert.equal(state.product_certificate,false);assert.equal(state.groups.reduce((n,g)=>n+g.users.length,0),size);assert.equal(new Set(state.groups.flatMap(g=>g.users.map(u=>u.id))).size,size);assert.ok(state.groups.every(g=>g.users.length===g.count));assert.deepEqual(state.groups.map(g=>g.kind+':'+g.count).sort(),plan.groups.map(g=>g.kind+':'+g.count).sort());
const atomic=(path,value)=>{fs.writeFileSync(path+'.new',JSON.stringify(value),{mode:0o600});fs.renameSync(path+'.new',path);};
const save=()=>atomic(path,state);
const journalName=`ramp-${size}-attempt${state.attempt}-operations.jsonl`;
if(fs.existsSync(dir+journalName)){recoverPurchases(state,fs.readFileSync(dir+journalName,'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)));save();}
const agreementPath=dir+`ramp-${size}-attempt${state.attempt}-setup-agreements.jsonl`;if(fs.existsSync(agreementPath)){const last=new Map();for(const line of fs.readFileSync(agreementPath,'utf8').trim().split('\n').filter(Boolean)){const op=JSON.parse(line);last.set(op.actorId,op);}for(const op of last.values()){const group=state.groups.find(g=>g.kind==='cash'&&g.tableId===op.tableId&&g.users.some(u=>u.id===op.actorId));assert.ok(group,'Foreign setup agreement receipt');assert.equal(op.outcome,'returned','Unknown post-BB requires native readback');if(op.result?.success!==true){assert.ok(op.naturalObservation);witnessNaturalBlindEntry(op.naturalObservation);}group.users.find(u=>u.id===op.actorId).setupPostAgreement=op;}}
const setupHandles=new Map();const seededObservers=new Map();const seedTasks=[];let setupObserverFailure;let measuredFailure;let requestDeadline;let deadline=Date.now()+(['admit','resume-admit','continuous'].includes(mode)?10*60000:5*60000);
requestDeadline=deadline;
function within(){assert.ok(Date.now()<requestDeadline,'finite stage deadline exceeded');}
function append(name,value){fs.appendFileSync(dir+name,JSON.stringify(value)+'\n',{mode:0o600});}
async function request(url,body,token,label,method='POST',ownActorId=null){
 within();assert.ok(['http://auth:9999','http://gateway:8000','http://engine:8080'].includes(new URL(url).origin));
 const target=new URL(url);const authRoute=target.origin==='http://auth:9999';let actorId=null;try{actorId=JSON.parse(Buffer.from(token.split('.')[1],'base64url')).sub??null;}catch{}if(ownActorId!==null)actorId=ownActorId;
 const op={label,id:randomUUID(),actorId,route:target.origin+target.pathname+target.search,method,requestIdentity:authRoute?{kind:label}:body,started:new Date().toISOString(),outcome:'unknown'};state.operations.push(op);append(`ramp-${size}-attempt${state.attempt}-operations.jsonl`,op);
 const response=await fetch(url,{method,redirect:'error',headers:{authorization:'Bearer '+token,apikey:keys.anonKey,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(Math.max(1,Math.min(20000,requestDeadline-Date.now())))});
 const raw=await response.text(),value=raw?JSON.parse(raw):null;op.httpStatus=response.status;op.finished=new Date().toISOString();op.outcome='returned';if(!url.startsWith('http://auth:9999'))op.result=value;append(`ramp-${size}-attempt${state.attempt}-operations.jsonl`,op);
 assert.ok(response.ok,label+' HTTP '+response.status+' '+(value?.code??value?.error??''));return value;
}
const rpc=(name,body,user=owner)=>request('http://gateway:8000/rest/v1/rpc/'+name,body,user.session.access_token,name);
async function refresh(user){const receiptPath=dir+`ramp-${size}-attempt${state.attempt}-session-${user.id}-private.json`;if(fs.existsSync(receiptPath)){const stored=JSON.parse(fs.readFileSync(receiptPath));assert.equal(stored.userId,user.id);assert.equal(stored.outcome,'returned');assert.equal(stored.session.user.id,user.id);user.session=stored.session;}else assert.ok(!state.operations.some(op=>op.label==='refresh-own-isolated-session'&&op.actorId===user.id),'Unrecovered rotated token requires supported session readback');const claims=JSON.parse(Buffer.from(user.session.access_token.split('.')[1],'base64url'));assert.equal(claims.sub,user.id);if(claims.exp<Date.now()/1000+1200){atomic(receiptPath,{userId:user.id,outcome:'unknown'});const session=await request('http://auth:9999/token?grant_type=refresh_token',{refresh_token:user.session.refresh_token},keys.anonKey,'refresh-own-isolated-session','POST',user.id);assert.equal(session.user.id,user.id);atomic(receiptPath,{userId:user.id,outcome:'returned',session});user.session=session;}return user;}
await refresh(owner);save();assert.equal(JSON.parse(Buffer.from(owner.session.access_token.split('.')[1],'base64url')).aal,'aal2');atomic(ownerPath,originalUsers);
async function sit(user,tableId,sitOut){const v=await request('http://engine:8080/sitout',{tableId,sitOut},user.session.access_token,sitOut?'ordinary-sitout':'ordinary-sitback');assert.equal(v.success,true);}
async function register(group,user){await registerTournamentActor({tournamentId:group.tournamentId,user,requestId:user.registrationOp,anonKey:keys.anonKey,checkpoint:async operation=>{state.operations.push(operation);append(journalName,operation);}});user.registered=true;}
async function witness(group){return readTournamentWitness({tournamentId:group.tournamentId,users:group.users,session:owner.session,anonKey:keys.anonKey});}

try {
if(['admit','resume-admit','continuous'].includes(mode)){
 assert.equal(state.stage,mode==='admit'?'funded-unseated':'admitting');state.stage='admitting';save();
 const setupTasks=[];
 // Refresh the complete existing cohort before any actor wall-clock lifetime starts.
 const refreshedAt=Date.now();for(const group of state.groups)for(const user of group.users)await refresh(user);save();state.sessionRefresh={finished:new Date().toISOString(),durationMs:Date.now()-refreshedAt};save();
 if(state.cashReentry){const quoteStart=Date.now();await prepareReentryQuotes(state.groups,(group,user)=>rpc('fn_cash_effective_buyin',{p_table_id:group.tableId},user));state.quotePreflight={finished:new Date().toISOString(),durationMs:Date.now()-quoteStart};save();}
 async function agreeToPost(group,u,chair,readChairs){
  u.setupPostAgreement={occupancyId:chair.occupancy_id,outcome:'unknown'};append(`ramp-${size}-attempt${state.attempt}-setup-agreements.jsonl`,{actorId:u.id,tableId:group.tableId,...u.setupPostAgreement});
  const result=await request('http://engine:8080/post-bb',{tableId:group.tableId},u.session.access_token,'ordinary-setup-post-bb');u.setupPostAgreement.outcome='returned';u.setupPostAgreement.result=result;append(`ramp-${size}-attempt${state.attempt}-setup-agreements.jsonl`,{actorId:u.id,tableId:group.tableId,...u.setupPostAgreement});
  if(result.success!==true){
   const after=(await readChairs()).find(c=>c.user_id===u.id);const response=await fetch('http://engine:8080/state/'+group.tableId,{headers:{authorization:'Bearer '+u.session.access_token},signal:AbortSignal.timeout(5000)});assert.ok(response.ok);const wire=await response.json();
   const proof={before:chair,after,wire,userId:u.id,tableId:group.tableId,result};u.setupPostAgreement.naturalObservation=proof;witnessNaturalBlindEntry(proof);
  }
  append(`ramp-${size}-attempt${state.attempt}-setup-agreements.jsonl`,{actorId:u.id,tableId:group.tableId,...u.setupPostAgreement});
 }
 async function attachSeedObserver(group){
  const chairUrl=new URL('http://gateway:8000/rest/v1/table_seats');chairUrl.search=new URLSearchParams({select:'table_id,user_id,seat_number,occupancy_id,stack,left_at',table_id:'eq.'+group.tableId,left_at:'is.null',limit:'3'});const native=await fetch(chairUrl,{headers:{authorization:'Bearer '+owner.session.access_token,apikey:keys.anonKey},signal:AbortSignal.timeout(5000)});assert.ok(native.ok);const chairs=await native.json();
  const until=Math.min(requestDeadline,Date.now()+20000);
  const handle=await startRampActors({tableId:group.tableId,users:group.users,initialActorIds:group.users.slice(0,2).map(u=>u.id),startPaused:false,setupFold:true,observeArrival:true,onFailure:error=>{setupObserverFailure??=error;measuredFailure?.(error);},checkpoint:operation=>append(`ramp-${size}-${state.measurementActivationAt?'actions':'setup-fold-actions'}.jsonl`,{group:group.index,phase:state.measurementActivationAt?'measured':'setup',...operation})});seededObservers.set(group.index,handle);
  let admitted=false;
  while(Date.now()<until){if(setupObserverFailure)throw setupObserverFailure;const states=handle.stateObservations();if(states.length===2&&states.every(s=>cashSeedReady({group,chairs,wire:s.state}))){admitted=true;break;}await new Promise(r=>setTimeout(r,50));}
  assert.ok(admitted,'Original two-chair seed not adopted');append(`ramp-${size}-attempt${state.attempt}-cash-admission.jsonl`,{group:group.index,phase:'original-two-chair-observer',at:new Date().toISOString(),chairs,observations:handle.observations(),wire:handle.stateObservations()});
 }
 async function prepareCashGroup(group){
  let observationFailure;let observer=seededObservers.get(group.index);
  const readChairs=async()=>{const url=new URL('http://gateway:8000/rest/v1/table_seats');url.search=new URLSearchParams({select:'id,table_id,user_id,seat_number,occupancy_id,stack,is_sitting_out,sit_out_at,left_at,entry_hold,entry_post_agreed',table_id:'eq.'+group.tableId,left_at:'is.null',limit:String(group.count+1)});const r=await fetch(url,{headers:{authorization:'Bearer '+owner.session.access_token,apikey:keys.anonKey},signal:AbortSignal.timeout(10000)});assert.ok(r.ok);const chairs=await r.json();assert.equal(chairs.length,group.count);assert.equal(new Set(chairs.map(c=>c.user_id)).size,group.count);assert.ok(chairs.every(c=>group.users.some(u=>u.id===c.user_id)&&c.seat_number===group.users.findIndex(u=>u.id===c.user_id)+1&&c.left_at===null&&Number(c.stack)>0));return chairs;};
  try{
   const chairs=await readChairs();append(`ramp-${size}-attempt${state.attempt}-cash-admission.jsonl`,{group:group.index,phase:'native-entry-preflight',at:new Date().toISOString(),chairs});
   for(const u of group.users){const chair=chairs.find(c=>c.user_id===u.id);if(chair.is_sitting_out===true){await sit(u,group.tableId,false);u.parked=false;save();}if(chair.entry_hold==='waiting'&&chair.entry_post_agreed===false&&!u.setupPostAgreement){await agreeToPost(group,u,chair,readChairs);}}
   if(observer)await observer.attachActors(group.users.slice(2).map(u=>u.id));
   const readyDeadline=requestDeadline;let ready=false;
   while(Date.now()<readyDeadline){if(observationFailure)throw observationFailure;if(!group.entryAgreementCheckAt||Date.now()-group.entryAgreementCheckAt>=500){group.entryAgreementCheckAt=Date.now();const currentChairs=await readChairs();for(const u of group.users){const chair=currentChairs.find(c=>c.user_id===u.id);if(chair.entry_hold==='waiting'&&chair.entry_post_agreed===false&&!u.setupPostAgreement){append(`ramp-${size}-attempt${state.attempt}-cash-admission.jsonl`,{group:group.index,phase:'native-waiting-entry',at:new Date().toISOString(),chair});await agreeToPost(group,u,chair,readChairs);}}}const response=await fetch('http://engine:8080/state/'+group.tableId,{headers:{authorization:'Bearer '+group.users[0].session.access_token},signal:AbortSignal.timeout(10000)});assert.ok(response.ok||response.status===404,'Authoritative admission observation refused');const v=await response.json();if(response.ok&&v.table_id===group.tableId&&['preflop','flop','turn','river'].includes(v.stage)&&v.players?.length>=2&&v.players.some(p=>p.user_id===v.current_player&&p.stack>0&&!p.is_folded&&!p.is_all_in)&&!observer){observer=await startRampActors({tableId:group.tableId,users:group.users,startPaused:false,setupFold:true,onFailure:error=>{observationFailure??=error;setupObserverFailure??=error;measuredFailure?.(error);},checkpoint:operation=>append(`ramp-${size}-${state.measurementActivationAt?'actions':'setup-fold-actions'}.jsonl`,{group:group.index,phase:state.measurementActivationAt?'measured':'setup',...operation})});}
    if(response.ok&&v.table_id===group.tableId&&['preflop','flop','turn','river'].includes(v.stage)&&v.players?.length===group.count&&(mode!=='continuous'||observer)&&new Set(v.players.map(p=>p.user_id)).size===group.count&&v.players.every(p=>group.users.some(u=>u.id===p.user_id)&&p.stack>0&&!p.is_sitting_out)){assert.ok(Number.isSafeInteger(v.hand_number)&&v.hand_number>0);group.firstDealtHand=v.hand_number;append(`ramp-${size}-attempt${state.attempt}-cash-admission.jsonl`,{group:group.index,phase:'full-first-hand-roster',at:new Date().toISOString(),state:v});ready=true;break;}await new Promise(resolve=>setTimeout(resolve,100));}
   assert.ok(ready,'Authoritative full-group first-hand roster was not admitted');if(mode==='continuous'){assert.ok(observer);if(observationFailure)throw observationFailure;setupHandles.set(group.index,observer);}else for(const u of group.users){await sit(u,group.tableId,true);u.parked=true;save();}
  }catch(error){append(`ramp-${size}-attempt${state.attempt}-cash-admission.jsonl`,{group:group.index,phase:'cash-admission-refusal',at:new Date().toISOString(),error:error.message,wire:observer?.stateObservations()});setupObserverFailure??=error;throw error;}finally{if(observer){if(!setupHandles.has(group.index))await observer.close();append(`ramp-${size}-attempt${state.attempt}-cash-admission.jsonl`,{group:group.index,phase:'setup-fold-observations',at:new Date().toISOString(),observations:observer.observations(),measuredLoadActions:false});}if(observationFailure)throw observationFailure;}
 }
 async function buyCashUser(group,i){if(setupObserverFailure)throw setupObserverFailure;const u=group.users[i];if(!u.buyinEntered){if(state.cashReentry){assert.ok(u.originalBuyinOp&&u.buyinOp!==u.originalBuyinOp);assert.ok(u.buyinQuote&&u.buyinQuote.tableId===group.tableId&&u.buyinQuote.buyinOp===u.buyinOp&&Number.isFinite(u.buyinAmount),'Original pre-admission quote missing');}await rpc('atomic_table_buyin',{p_user_id:u.id,p_table_id:group.tableId,p_seat_number:i+1,p_amount:u.buyinAmount??200,p_auto_rebuy:false,p_club_id:group.clubId,p_idempotency_key:u.buyinOp},u);u.buyinEntered=true;}}
 const seeds=seedTasks;
 await admitIndependentBatches(state.groups,8,async group=>{within();
  if(group.kind==='cash'){for(let i=0;i<2;i++)await buyCashUser(group,i);if(mode==='continuous')seeds.push(attachSeedObserver(group).then(()=>({ok:true}),error=>{setupObserverFailure??=error;return {ok:false,error};}));}
  else for(const user of group.users.slice(0,-1)){if(setupObserverFailure)throw setupObserverFailure;if(!user.registered)await register(group,user);}
 });
 const seeded=await Promise.all(seeds);const seedFailure=seeded.find(s=>!s.ok);if(seedFailure){await Promise.allSettled([...seededObservers.values()].map(h=>h.close()));throw seedFailure.error;}
 await admitIndependentBatches(state.groups.filter(g=>g.kind==='cash'),8,async group=>{within();for(let i=2;i<group.users.length;i++)await buyCashUser(group,i);if(!group.users.every(u=>u.parked))setupTasks.push(prepareCashGroup(group).then(()=>({status:'fulfilled'}),reason=>({status:'rejected',reason})));});
 // All ordinary purchases are durable before bounded independent group setup.
 // Positive native waiting entries receive one ordinary post-BB agreement.
 // Failed or unknown original post operations remain failed or unknown.
 // Existing parks are read before an explicit new sit-back; no purchase replay.
 const setupResults=await Promise.all(setupTasks);const setupFailure=setupResults.find(r=>r.status==='rejected')??(setupObserverFailure?{reason:setupObserverFailure}:null);if(setupFailure){await Promise.allSettled([...new Set([...setupHandles.values(),...seededObservers.values()])].map(h=>h.close()));throw setupFailure.reason;}
 if(mode==='continuous'){assertCashSetupComplete(state.groups,setupHandles.keys());state.stage='continuous-ready';state.continuousAdmissionAt=new Date().toISOString();save();}else{
 // Final tournament registration is reserved for play so an SNG cannot complete
 // by automatic folds while a large unrelated roster is still being prepared.
 // Park requests made mid-hand are effective only after the original hand finishes.
 const parkDeadline=Math.min(requestDeadline,Date.now()+120000);state.parkedBoundary=[];
 for(const group of state.groups.filter(g=>g.kind==='cash')){let admitted=false;while(Date.now()<parkDeadline){const u=group.users[0];const response=await fetch('http://engine:8080/state/'+group.tableId,{headers:{authorization:'Bearer '+u.session.access_token},signal:AbortSignal.timeout(10000)});assert.ok(response.ok);const v=await response.json();const url=new URL('http://gateway:8000/rest/v1/table_seats');url.search=new URLSearchParams({select:'id,user_id,occupancy_id,stack,is_sitting_out,sit_out_at,left_at',table_id:'eq.'+group.tableId,left_at:'is.null',limit:String(group.count+1)});const chairsResponse=await fetch(url,{headers:{authorization:'Bearer '+owner.session.access_token,apikey:keys.anonKey},signal:AbortSignal.timeout(10000)});assert.ok(chairsResponse.ok);const chairs=await chairsResponse.json();const commitUrl=new URL('http://gateway:8000/rest/v1/hand_atomic_commits');commitUrl.search=new URLSearchParams({select:'hand_id,hand_number,stack_result,post_commit_completed_at,post_commit_result',table_id:'eq.'+group.tableId,hand_number:'eq.'+group.firstDealtHand,limit:'2'});const commitResponse=await fetch(commitUrl,{headers:{authorization:'Bearer '+keys.serviceKey,apikey:keys.anonKey},signal:AbortSignal.timeout(10000)});assert.ok(commitResponse.ok);const commits=await commitResponse.json();const settled=commits.length===1&&commits[0].stack_result?.conservation_checked===true&&Number(commits[0].stack_result?.net_deltas)===0&&commits[0].post_commit_result?.ok===true&&!!commits[0].post_commit_completed_at;if(settled&&(v.stage==='waiting'||(v.stage==='idle'&&v.players?.length===0))&&v.table_id===group.tableId&&v.current_player==null&&chairs.length===group.count&&chairs.every(c=>group.users.some(u=>u.id===c.user_id)&&c.is_sitting_out===true&&Number.isFinite(Date.parse(c.sit_out_at)))){state.parkedBoundary.push({group:group.index,tableId:group.tableId,observedAt:new Date().toISOString(),hand:v.hand_number??null,httpStage:v.stage,originalSetupCommit:commits[0],chairs});save();admitted=true;break;}await new Promise(r=>setTimeout(r,250));}assert.ok(admitted,'Actual parked waiting boundary not observed');}
 state.stage='parked-and-partially-registered';save();console.log(JSON.stringify({stage:state.stage,size,product_certificate:false}));
 }
}
if(mode==='play'||mode==='continuous'){
 assert.equal(state.stage,mode==='continuous'?'continuous-ready':'parked-and-partially-registered');deadline=Date.now()+5*60000;requestDeadline=deadline;state.stage='playing';save();
 const result={size,runId:state.runId,attempt:state.attempt??1,started:new Date().toISOString(),plan,resources:[],cash:[],tournaments:[],reconnects:[],product_certificate:false,sustained15MinuteSLOQualified:false,workload:{authenticatedSyntheticHumanActors:size,horseActors:0,productionBackgroundEquityQualified:false,demandForecast:false}};
 const control=new AbortController(),cash=[],tournamentPromises=[],tournamentLive=new Map(),tournamentReady=new Set();let failure;let cohortActive=false;
 const markFailure=e=>{if(!failure){failure=e;result.firstFailure={message:e.message,at:new Date().toISOString()};}control.abort();};
 measuredFailure=markFailure;
 const phaseDeadlineTimer=setTimeout(()=>markFailure(new Error('Finite whole-stage deadline exceeded')),Math.max(1,deadline-Date.now()));
 const loopDelay=monitorEventLoopDelay({resolution:20});loopDelay.enable();let cpu=process.cpuUsage();let previous=performance.now();
 const sampling=setInterval(()=>{const now=performance.now(),used=process.cpuUsage(cpu);cpu=process.cpuUsage();const memory=process.memoryUsage();result.resources.push({at:new Date().toISOString(),generatorCPUPercent:(used.user+used.system)/((now-previous)*10),rss:memory.rss,heapUsed:memory.heapUsed,eventLoopP95Ms:loopDelay.percentile(95)/1e6,cashConnected:cash.reduce((n,c)=>n+c.handle.observations().actors.filter(a=>a.connected).length,0),cashAlive:cash.reduce((n,c)=>n+c.handle.observations().actors.filter(a=>a.alive).length,0),cashActing:cash.reduce((n,c)=>n+c.handle.observations().actors.filter(a=>a.spentTurns>0&&a.alive).length,0),tournamentConnected:[...tournamentLive.values()].reduce((n,w)=>n+w.actors.filter(a=>a.connected).length,0),tournamentAlive:[...tournamentLive.values()].reduce((n,w)=>n+w.actors.filter(a=>a.alive).length,0),tournamentActing:[...tournamentLive.values()].reduce((n,w)=>n+w.actors.filter(a=>a.alive&&a.spentTurns>0).length,0)});previous=now;loopDelay.reset();},1000);
 try{
  if(mode!=='continuous')for(const group of state.groups)for(const user of group.users)await refresh(user);
  // All cash sockets connect while ordinary seats remain parked. Their actor
  // lifetime begins at explicit activation, never during sequential setup.
  const cashGroups=state.groups.filter(g=>g.kind==='cash');
  await admitIndependentBatches(cashGroups,8,async group=>{
   if(mode==='continuous'){const handle=setupHandles.get(group.index);assert.ok(handle,'Original continuously admitted actor generation absent');cash.push({group,handle});return;}
   if(failure)throw failure;if(setupObserverFailure)throw setupObserverFailure;
   const handle=await startRampActors({tableId:group.tableId,users:group.users,startPaused:true,observeArrival:true,onFailure:markFailure,signal:control.signal,checkpoint:operation=>append(`ramp-${size}-actions.jsonl`,{group:group.index,...operation})});cash.push({group,handle});
  });
  const activationDeadline=Date.now()+20000;
  // Complete each final tournament registration and attach actual actors promptly.
  await admitIndependentGroups(state.groups.filter(g=>g.kind!=='cash'),async group=>{
   if(failure)throw failure;assert.ok(Date.now()<activationDeadline,'cohort admission budget exceeded');
   if(!group.users.at(-1).registered)await register(group,group.users.at(-1));
   let admission;do{assert.ok(Date.now()<activationDeadline,'coherent tournament seating exceeded cohort budget');admission=await readCoherentAdmission({tournamentId:group.tournamentId,users:group.users,session:owner.session,anonKey:keys.anonKey,signal:control.signal});append(`ramp-${size}-attempt${state.attempt??1}-admission.jsonl`,{group:group.index,...admission});if(!admission.ready)await new Promise(r=>setTimeout(r,100));}while(!admission.ready);
   const task=runRampTournamentActors({tournamentId:group.tournamentId,users:group.users,session:owner.session,anonKey:keys.anonKey,serviceKey:keys.serviceKey,signal:control.signal,isActivated:()=>cohortActive,onReady:()=>tournamentReady.add(group.index),onObservation:observation=>tournamentLive.set(group.index,observation),checkpoint:receipt=>atomic(dir+`ramp-${size}-tournament-${group.index}.json`,receipt)}).then(receipt=>{tournamentLive.delete(group.index);result.tournaments.push({group:group.index,receipt});}).catch(markFailure);tournamentPromises.push(task);
   // A reused entrant may retain the ordinary forced sit-out from prior idle trials.
   // This is a new explicit sit-back, never a registration or start replay.
   for(const tableId of [...new Set(admission.witness.seats.map(s=>s.table_id))]){let adopted=false;const intended=admission.witness.seats.filter(s=>s.table_id===tableId);do{assert.ok(Date.now()<activationDeadline,'Exact tournament dealer roster not yet ready');const u=group.users.find(u=>u.id===intended[0].user_id),r=await fetch('http://engine:8080/state/'+tableId,{headers:{authorization:'Bearer '+u.session.access_token},signal:AbortSignal.timeout(5000)});assert.ok(r.ok);const v=await r.json();assert.equal(v.table_id,tableId);assert.ok(Array.isArray(v.players));append(`ramp-${size}-attempt${state.attempt}-dealer-admission.jsonl`,{tableId,at:new Date().toISOString(),state:v});adopted=intended.every(seat=>v.players.some(p=>p.user_id===seat.user_id&&p.seat===seat.seat_number&&p.stack>0));if(!adopted)await new Promise(r=>setTimeout(r,100));}while(!adopted);}for(let offset=0;offset<group.users.length;offset+=12){const batch=group.users.slice(offset,offset+12);await Promise.all(batch.map(user=>{const seat=admission.witness.seats.find(s=>s.user_id===user.id);assert.ok(seat,'Exact tournament sit-back chair missing');return sit(user,seat.table_id,false);}));}
  });
  while(tournamentReady.size!==tournamentPromises.length&&!failure){assert.ok(Date.now()<activationDeadline,'tournament socket barrier exceeded budget');await new Promise(r=>setTimeout(r,20));}
  if(failure)throw failure;
  // Finite batches of original sit-back requests; every outcome is journaled.
  const activations=cash.flatMap(c=>c.group.users.map(user=>({user,tableId:c.group.tableId})));
  if(mode!=='continuous')result.admissionParkAges=activations.map(({user,tableId})=>{const park=state.operations.findLast(op=>op.label==='ordinary-sitout'&&op.actorId===user.id&&op.requestIdentity?.tableId===tableId&&op.httpStatus===200);assert.ok(park,'Original successful park receipt missing');const boundary=state.parkedBoundary?.find(b=>b.tableId===tableId);const chair=boundary?.chairs.find(c=>c.user_id===user.id);assert.ok(chair&&chair.left_at===null&&chair.is_sitting_out===true,'Actual parked occupancy missing');const ageMs=Date.now()-Date.parse(chair.sit_out_at);assert.ok(ageMs>=0&&ageMs<300000,'Actual parked-chair lifetime expired before activation');return {actorId:user.id,tableId,occupancyId:chair.occupancy_id,parkedAt:chair.sit_out_at,requestAt:park.started,ageMs};});
  if(mode!=='continuous')for(let offset=0;offset<activations.length;offset+=12){assert.ok(Date.now()<activationDeadline,'cohort sit-back budget exceeded');await Promise.all(activations.slice(offset,offset+12).map(({user,tableId})=>sit(user,tableId,false)));}
  if(mode==='continuous'){for(const c of cash)c.handle.quiesce();const drained=Date.now()+10000;while(cash.some(c=>c.handle.pendingActions()>0)&&Date.now()<drained&&!setupObserverFailure)await new Promise(r=>setTimeout(r,20));if(setupObserverFailure)throw setupObserverFailure;assert.ok(cash.every(c=>c.handle.pendingActions()===0),'Original admitted generation has an in-flight setup action');result.retainedGenerations=cash.map(c=>({group:c.group.index,...c.handle.beginMeasurement({durationMs:plan.durationMs})}));}
  cohortActive=true;if(mode!=='continuous')for(const c of cash)c.handle.activate();result.activatedAt=new Date().toISOString();state.measurementActivationAt=result.activatedAt;save();
  // One selected real cash actor deliberately reconnects after it has acted.
  const selected=cash[0];const activeDeadline=Date.now()+20000;while(!selected.handle.observations().actors.some(a=>a.spentTurns>0)&&Date.now()<activeDeadline&&!failure)await new Promise(r=>setTimeout(r,100));
  const selectedActor=selected.handle.observations().actors.find(a=>a.inflight&&a.spentTurns>0)??selected.handle.observations().actors.find(a=>a.spentTurns>0);assert.ok(selectedActor,'no real playing actor available for reconnect');result.reconnects.push(await selected.handle.reconnect(selectedActor.actorId));
  const playEnd=Date.now()+plan.durationMs;while(Date.now()<playEnd&&!failure){within();await new Promise(r=>setTimeout(r,500));}
  if(failure)throw failure;
  for(const c of cash)c.handle.quiesce();
  const settledDeadline=Date.now()+10000;while(cash.some(c=>c.handle.pendingActions()>0)&&Date.now()<settledDeadline&&!failure)await new Promise(r=>setTimeout(r,50));
  assert.ok(cash.every(c=>c.handle.pendingActions()===0),'pending original action at phase boundary');
  for(const c of cash){const observed=c.handle.observations();assert.ok(observed.actions>=24);assert.equal(observed.httpFailures,0);result.cash.push({group:c.group.index,tableId:c.group.tableId,...observed});}
  await Promise.allSettled(cash.map(c=>c.handle.close()));
  await Promise.all(tournamentPromises);if(failure)throw failure;assert.equal(result.tournaments.length,state.groups.filter(g=>g.kind!=='cash').length);
  const intendedTournamentPlayers=state.groups.filter(g=>g.kind!=='cash').reduce((n,g)=>n+g.count,0);
  assert.ok(result.resources.some(r=>r.cashAlive+r.tournamentAlive===size&&r.tournamentAlive===intendedTournamentPlayers),'intended simultaneous mixed player stage was never observed');
  assert.ok(result.resources.some(r=>r.cashActing+r.tournamentActing===size),'all intended simultaneous actors did not make actual decisions');
  result.protocolPassed=true;
 }catch(error){markFailure(error);result.failure=failure?.message??error.message;result.interruption=error.message;process.exitCode=1;}
 finally{
  clearInterval(sampling);loopDelay.disable();control.abort();await Promise.allSettled([...setupHandles.values()].map(h=>h.close()));await Promise.allSettled(tournamentPromises);await Promise.allSettled(cash.map(c=>c.handle.close()));
  clearTimeout(phaseDeadlineTimer);requestDeadline=Date.now()+30000;result.parking=[];
  // Ordinary sit-out has its own bounded30s cleanup budget after the main phase.
  // It is a finite separate original request; retain any refusal
  // or unknown transport outcome. Do not delete seats, replay actions or refund SQL.
  const parks=cash.flatMap(c=>c.group.users.map(user=>({c,user})));for(let offset=0;offset<parks.length;offset+=12)await Promise.all(parks.slice(offset,offset+12).map(async({c,user})=>{const park={actorId:user.id,tableId:c.group.tableId,outcome:'unknown'};result.parking.push(park);try{await sit(user,c.group.tableId,true);park.outcome='returned-success';}catch(error){park.error=error.message;if(Date.now()>=requestDeadline)park.deadlineExceeded=true;result.parkFailure??=error.message;result.protocolPassed=false;process.exitCode=1;}}));
  if(failure){result.failure??=failure.message;result.protocolPassed=false;process.exitCode=1;}
  clearTimeout(phaseDeadlineTimer);result.finished=new Date().toISOString();result.peakCashConnected=Math.max(0,...result.resources.map(r=>r.cashConnected));result.peakCashActing=Math.max(0,...result.resources.map(r=>r.cashActing));result.peakConnected=Math.max(0,...result.resources.map(r=>r.cashConnected+r.tournamentConnected));result.peakActivePlayers=Math.max(0,...result.resources.map(r=>r.cashAlive+r.tournamentAlive));result.peakActingPlayers=Math.max(0,...result.resources.map(r=>r.cashActing+r.tournamentActing));
  state.stage='awaiting-independent-durable-proof';save();atomic(resultPath,result);console.log(JSON.stringify({size,protocolPassed:result.protocolPassed??false,failure:result.failure,parkFailure:result.parkFailure,peakCashConnected:result.peakCashConnected,peakCashActing:result.peakCashActing,product_certificate:false}));
 }
}

}catch(error){setupObserverFailure??=error;await Promise.allSettled(seedTasks);await Promise.allSettled([...seededObservers.values()].map(h=>h.close()));atomic(dir+`ramp-${size}-attempt${state.attempt??1}-admission-failure.json`,{at:new Date().toISOString(),stage:state.stage,message:error.message,product_certificate:false});throw error;}
