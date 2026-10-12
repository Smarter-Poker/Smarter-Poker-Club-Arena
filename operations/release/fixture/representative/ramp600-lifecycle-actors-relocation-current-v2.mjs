import {unadmittedRelocationArrival} from './relocation-arrival-current-v2.mjs';
import assert from 'node:assert/strict';
import {validateObservedRoster} from './roster-observation.mjs';
import {readCoherentTournamentWitness} from './coherent-tournament-witness.mjs';
import {observeStartupTurn} from './startup-observation.mjs';
import { validatePublishedActor } from './action-publication.mjs';
import { randomUUID } from 'node:crypto';
import { patched } from './tournament-wire.mjs';
import { readTournamentWitness, validateBoardTransition } from './tournament-adapter.mjs';

// Finite isolated tournament input devices. All decisions consume strict wire
// state; table changes require actual persisted registration and occupancy.
export async function runTournamentActors({ tournamentId, users, session, anonKey, serviceKey, checkpoint, signal, onObservation, resumeObservation=false, durationMs=240000 }) {
  assert.ok(durationMs>0 && durationMs<=240000);
  if(signal!==undefined){assert.ok(signal instanceof AbortSignal);signal.throwIfAborted();}
  const ids=new Set(users.map(u=>u.id)); assert.equal(ids.size,users.length);
  const result={tournamentId,started:new Date().toISOString(),actions:[],transitions:[],frames:[],product_certificate:false};
  const actors=[]; const pending=new Set(); let stopped=false;let closing=false; let failure; let completed=false;
  const wagerStages=new Set(['preflop','flop','turn','river']);
  const knownStages=new Set(['waiting',...wagerStages,'showdown']);
  const boundaries=new Set(['pot_win','pot_distributed','hand_complete']);
  let readInFlight;let witness=await read();
  assert.equal(String(witness.tournament.status).toUpperCase(),'RUNNING');
  async function read(){if(!readInFlight)readInFlight=readCoherentTournamentWitness({tournamentId,users,session,anonKey}).finally(()=>{readInFlight=null;});return readInFlight;}
  const persist=()=>checkpoint(result);
  function stop() { stopped=true; for(const a of actors){clearTimeout(a.timer);a.socket?.close();} }
  function fail(e) { if(failure)return; failure=e; result.failure=e.message; stop(); }
  async function committed(tableId, handNumber) {
    const url=new URL('http://gateway:8000/rest/v1/hand_atomic_commits');
    url.search=new URLSearchParams({select:'table_id,hand_number,stack_result,post_commit_completed_at,post_commit_result',table_id:'eq.'+tableId,hand_number:'eq.'+handNumber,limit:'2'});
    const r=await fetch(url,{headers:{apikey:anonKey,authorization:'Bearer '+serviceKey},redirect:'error',signal:AbortSignal.timeout(10000)});
    assert.ok(r.ok,'durable hand witness unavailable');const rows=await r.json();assert.equal(rows.length,1);
    return {tableId:rows[0].table_id,handNumber:Number(rows[0].hand_number),conservationChecked:rows[0].stack_result?.conservation_checked===true,postCommitCompletedAt:rows[0].post_commit_completed_at,postCommitOk:rows[0].post_commit_result?.ok===true};
  }
  async function boardEnd(a,teardown) {
    const after=await read();
    assert.ok(a.boundary,'board closed without connected hand boundary');
    const settledHand=await committed(a.tableId,a.boundary.handNumber);
    const input={before:a.boardWitness,after,tableId:a.tableId,boundary:a.boundary,lastGameplay:a.lastGameplay,teardown,settledHand};
    let transition;try{transition=validateBoardTransition(input);}catch(error){
      (result.boardEndRefusals??=[]).push({...input,actorId:a.user.id,observedAt:new Date().toISOString(),reason:error.message});
      try{await persist();}catch(persistenceError){throw new AggregateError([error,persistenceError],'Board ending refusal evidence could not be retained',{cause:error});}throw error;
    }
    result.transitions.push({...transition,actorId:a.user.id,tableId:a.tableId,at:new Date().toISOString()}); witness=after;
    if(transition.kind==='completed'){completed=true;result.terminalWitness=after;closing=true;for(const actor of actors){clearTimeout(actor.timer);actor.socket?.close();}return;}
    const assignment=after.seats.find(s=>s.user_id===a.user.id);
    if(assignment){assert.notEqual(assignment.table_id,a.tableId);connect(a,assignment.table_id,after,transition);}
    else {assert.equal(after.players.find(p=>p.user_id===a.user.id)?.status,'eliminated');a.done=true;a.socket.close();}
  }
  async function acceptState(a,next) {
    assert.equal(next.table_id,a.tableId);assert.ok(knownStages.has(next.stage));assert.ok(Number.isSafeInteger(next.hand_number));
    assert.ok(Array.isArray(next.players));assert.equal(new Set(next.players.map(p=>p.user_id)).size,next.players.length);
    assert.ok(next.players.every(p=>ids.has(p.user_id)),'unregistered wire player');
    assert.ok(next.current_player===null||ids.has(next.current_player));
    if(resumeObservation&&!a.state&&!next.players.some(p=>p.user_id===a.user.id)){
      const after=await read();let unadmitted;try{unadmitted=unadmittedRelocationArrival({previous:a.state,next,relocation:a.relocation,witness:after,admissionWitness:a.boardWitness,tableId:a.tableId,ownId:a.user.id});}catch(error){result.refusalWitness={actorId:a.user.id,tableId:a.tableId,sequence:a.seq,next,previous:a.state,before:a.boardWitness,after,relocation:a.relocation};throw error;}if(unadmitted){a.currentOwnSeat=false;a.awaitingActionableBaseline??={hand:next.hand_number,clock:next.turn_start_time_ms};result.transitions.push({kind:'unadmitted-destination-arrival',actorId:a.user.id,tableId:a.tableId,hand:next.hand_number,clock:next.turn_start_time_ms,relocation:a.relocation,ownOccupancy:after.seats.find(s=>s.user_id===a.user.id),nonacting:true});return;}
    }
    const roster=next.players.map(p=>p.user_id).sort().join(',');
    if(roster!==a.roster){
      const after=await read();
      if(next.players.length===0){await boardEnd(a);return;}
      try{const observed=validateObservedRoster({next,previous:a.state,before:a.boardWitness,after,tableId:a.tableId,ownId:a.user.id});a.currentOwnSeat=observed.mayAct;if(!observed.mayAct)a.awaitingActionableBaseline={hand:next.hand_number,clock:next.turn_start_time_ms};result.transitions.push({kind:'roster-observation',actorId:a.user.id,tableId:a.tableId,hand:next.hand_number,sequence:a.seq,observedAt:after.observedAt,...observed});}catch(error){result.refusalWitness={actorId:a.user.id,tableId:a.tableId,sequence:a.seq,next,previous:a.state,before:a.boardWitness,after};throw error;}
      a.roster=roster;witness=after;
    }
    const previous=a.state;a.state=next;const arrivalWaiting=resumeObservation&&observeStartupTurn(a,previous,next);
    if(wagerStages.has(next.stage)&&next.current_player!==null){
      const p=next.players.find(p=>p.user_id===next.current_player);assert.ok(p);
      assert.ok(Number.isSafeInteger(next.turn_start_time_ms)&&next.turn_start_time_ms>0);
      assert.ok(typeof next.action_context==='string'&&next.action_context.length>0&&next.action_context.length<=200);
      if(arrivalWaiting){result.transitions.push({kind:'observer-awaits-new-turn',actorId:a.user.id,hand:next.hand_number,clock:next.turn_start_time_ms,product_certificate:false});return;}
      validatePublishedActor(previous,next,{...a.lastGameplay,previousSequence:a.seq});
      assert.ok(Number.isFinite(next.current_bet)&&Number.isFinite(p.bet)&&p.bet<=next.current_bet);
    }
  }
  function schedule(a){
    if(stopped||closing||a.currentOwnSeat===false||a.awaitingActionableBaseline||a.done||a.timer||a.inflight||!a.state||a.pendingFrames>0)return;
    const s=a.state;if(!wagerStages.has(s.stage)||s.current_player!==a.user.id)return;const player=s.players.find(p=>p.user_id===a.user.id);if(!player||player.stack<=0||player.is_folded||player.is_all_in)return;
    const turn=`${a.tableId}:${s.hand_number}:${s.turn_start_time_ms}`,context=s.action_context;
    if(a.turns.has(turn)||a.decisions.has(context))return;
    a.timer=setTimeout(()=>{a.timer=null;if(stopped)return;
      if(a.pendingFrames>0||a.state.action_context!==context||a.state.current_player!==a.user.id||`${a.tableId}:${a.state.hand_number}:${a.state.turn_start_time_ms}`!==turn){schedule(a);return;}
      const task=act(a,turn,context).catch(fail).finally(()=>pending.delete(task));pending.add(task);
    },Math.max(350,a.lastAction+350-Date.now()));
  }
  async function act(a,turn,context){
    a.inflight=true;a.turns.add(turn);a.decisions.add(context);assert.ok(a.decisions.size<=1024);
    // Legal all-in input makes the small tournament finish inside the finite
    // acceptance budget; cards and winner remain real engine outcomes.
    const op={actorId:a.user.id,tableId:a.tableId,handNumber:a.state.hand_number,action:'all_in',actionContext:context,idempotencyKey:randomUUID(),outcome:'unknown',started:new Date().toISOString()};
    result.actions.push(op);await persist();
    assert.ok(!stopped&&a.state.action_context===context&&a.state.current_player===a.user.id&&`${a.tableId}:${a.state.hand_number}:${a.state.turn_start_time_ms}`===turn,'action context changed while journaling');
    a.lastAction=Date.now();const start=performance.now();
    try{const r=await fetch('http://engine:8080/action',{method:'POST',redirect:'error',headers:{authorization:'Bearer '+a.user.session.access_token,'content-type':'application/json'},body:JSON.stringify({tableId:a.tableId,action:op.action,actionContext:context,idempotencyKey:op.idempotencyKey}),signal:AbortSignal.timeout(10000)});
      const body=await r.json();op.status=r.status;op.latencyMs=performance.now()-start;op.outcome='returned';op.result=body;await persist();assert.ok(r.status===200&&body.success===true&&body.replayed!==true,'actual tournament action refused');
    }finally{a.inflight=false;}
    schedule(a);
  }
  async function receive(a,raw){
    assert.ok(typeof raw==='string'&&raw.length<=2*1024*1024);const m=JSON.parse(raw);a.lastFrame=Date.now();
    if(m.type==='PING'){assert.ok(Number.isFinite(m.ts));a.socket.send(JSON.stringify({type:'PONG',ts:m.ts}));return;}
    assert.equal(m.tableId,a.tableId);
    if(result.frames.length<12000)result.frames.push({actorId:a.user.id,receivedAt:new Date().toISOString(),message:m});
    a.eventSequence++;
    if(m.type==='SUBSCRIBED'){assert.equal(a.subscribed,false);a.subscribed=true;return;}
    if(m.type==='SNAPSHOT'){assert.ok(Number.isSafeInteger(m.seq)&&m.seq>=0&&(a.seq===null||m.seq>=a.seq));if(a.seq===m.seq)assert.deepEqual(m.state,a.wireState);const generation=a.generation;await acceptState(a,structuredClone(m.state));if(a.generation===generation){a.seq=m.seq;a.wireState=structuredClone(m.state);}return;}
    if(m.type==='DELTA'){assert.ok(a.wireState&&m.prev===a.seq&&m.seq===a.seq+1);const generation=a.generation;const next=patched(a.wireState,m.patch);await acceptState(a,next);if(a.generation===generation){a.seq=m.seq;a.wireState=next;}return;}
    if(m.type==='USER_EVENT'){assert.ok(['hole_cards','pre_action','add_on_adjusted'].includes(m.payload?.kind));return;}
    if(m.type==='EVENT'){
      assert.equal(typeof m.payload?.type,'string');
      const type=m.payload.type;
      if(type==='engine_restarting'){await boardEnd(a,{tableId:a.tableId,count:++a.teardowns,eventSequence:a.eventSequence,receivedAt:new Date().toISOString()});return;}
      if(!m.payload.replayed&&['hand_started','blinds_posted','player_action','turn_change','community_cards_dealt','showdown','showdown_cards_revealed',...boundaries].includes(type)){
        a.lastGameplay={type,tableId:a.tableId,handNumber:m.payload.hand_number,actorId:m.payload.user_id,action:m.payload.action,wireSequence:m.seq,replayed:m.payload.replayed,stateSequence:a.seq,timestamp:m.payload.timestamp,eventSequence:a.eventSequence,receivedAt:new Date().toISOString()};
        if(boundaries.has(type)){assert.ok(Number.isSafeInteger(m.payload.hand_number)&&m.payload.hand_number>0,'boundary has no actual hand identity');a.boundary=a.lastGameplay;}
      }return;
    }
    if(m.type==='ERROR')throw new Error('Tournament engine error '+String(m.code));
    throw new Error('Unknown tournament wire frame');
  }
  function connect(a,tableId,boardWitness,relocation=null){
    const previous=a.socket;a.generation++;previous?.close();const generation=a.generation;
    a.tableId=tableId;a.boardWitness=boardWitness;a.relocation=relocation;a.wireState=null;a.currentOwnSeat=false;a.state=null;a.seq=null;a.roster=null;a.subscribed=false;a.boundary=null;a.lastGameplay=null;a.eventSequence=0;a.teardowns=0;a.pendingFrames=0;a.lastFrame=Date.now();
    const socket=a.socket=new WebSocket('ws://engine:8080/ws/multi?v=0',['bearer',a.user.session.access_token]);
    socket.addEventListener('open',()=>{if(stopped)return;assert.equal(socket.protocol,'bearer');socket.send(JSON.stringify({type:'SUBSCRIBE',tableId}));});
    socket.addEventListener('message',event=>{if(stopped||closing||a.generation!==generation)return;a.pendingFrames++;a.queue=a.queue.then(()=>{if(stopped||a.generation!==generation)return;return receive(a,event.data);}).then(()=>{if(a.generation!==generation)return;a.pendingFrames--;schedule(a);}).catch(fail);});
    socket.addEventListener('error',()=>{if(!closing&&a.generation===generation&&!a.done)fail(new Error('Tournament socket error'));});
    socket.addEventListener('close',()=>{if(!stopped&&!closing&&a.generation===generation&&!a.done)fail(new Error('Unexplained tournament socket closure'));});
  }
  for(const user of users){const seat=witness.seats.find(s=>s.user_id===user.id);if(!seat){const registration=witness.players.find(p=>p.user_id===user.id);assert.equal(registration?.status,'eliminated');assert.ok(Number(registration.position)>0&&Number.isFinite(Date.parse(registration.eliminated_at)));continue;}
    const a={user,turns:new Set(),decisions:new Set(),inflight:false,timer:null,lastAction:0,generation:0,queue:Promise.resolve(),done:false};actors.push(a);connect(a,seat.table_id,witness);
  }
  const aborted=()=>fail(new Error('Tournament qualification aborted'));
  signal?.addEventListener('abort',aborted,{once:true});if(signal?.aborted)aborted();
  const started=Date.now();
  try{while(!stopped&&!completed&&Date.now()-started<durationMs){await new Promise(r=>setTimeout(r,500));onObservation?.({at:new Date().toISOString(),actors:actors.map(a=>({actorId:a.user.id,tableId:a.tableId,connected:!a.done&&!!a.state,spentTurns:a.turns.size,alive:!a.done&&!!a.state?.players.some(p=>p.user_id===a.user.id&&p.stack>0)}))});for(const a of actors)if(!a.done&&Date.now()-a.lastFrame>45000)throw new Error('Tournament socket silent');}
    if(failure)throw failure;assert.ok(completed,'Tournament did not complete inside finite acceptance budget');assert.ok(result.actions.length>=actors.length,'Insufficient actual tournament decisions');result.protocolPassed=true;
  }catch(e){result.failure=e.message;throw e;}
  finally{
    signal?.removeEventListener('abort',aborted);closing=true;
    for(const actor of actors){clearTimeout(actor.timer);actor.socket?.close();}
    // Input admission closes first. Every previously admitted callback still
    // validates before success; its rejection is retained even during shutdown.
    await Promise.allSettled([...pending]);await Promise.allSettled(actors.map(a=>a.queue));
    stop();if(failure){result.protocolPassed=false;result.failure=failure.message;}
    result.finished=new Date().toISOString();await persist();if(failure)throw failure;
  }
  return result;
}
