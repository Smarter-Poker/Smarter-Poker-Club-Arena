import {performance} from 'node:perf_hooks';
const operations=new Set(['fn_assign_tournament_player_seat_atomic','fn_begin_tournament_launch_atomic','fn_complete_tournament_launch_atomic','fn_register_for_tournament_request']);
// An explicitly invoked isolated gateway observation. Never read headers,
// request/response bodies, query values, identities, or exception messages.
export function observeIsolatedRequest({method,url,ordinal,record,onFailure}) {
 if(method!=='POST'||typeof url!=='string')return null;
 const match=/^\/rest\/v1\/rpc\/([a-z_]+)(?:\?|$)/.exec(url);
 if(!match||!operations.has(match[1]))return null;
 if(!Number.isSafeInteger(ordinal)||ordinal<1||typeof record!=='function'||typeof onFailure!=='function')throw new TypeError('Invalid isolated timing sink');
 const startedAt=new Date().toISOString(),started=performance.now();let finished=false,observationFailed=false;
 function safeRecord(value){if(observationFailed)return;try{record(value);}catch{observationFailed=true;try{onFailure('ISOLATED_REQUEST_TIMING_SINK_FAILED');}catch{/* Forwarded request must remain unchanged; failed stays sticky. */}}}
 safeRecord({phase:'started',ordinal,operation:match[1],startedAt});
 function finish(outcome,httpStatus=null){
  if(finished)return;finished=true;
  safeRecord({phase:'finished',ordinal,operation:match[1],startedAt,finishedAt:new Date().toISOString(),durationMs:performance.now()-started,outcome,httpStatus});
 }
 return {
  get observationFailed(){return observationFailed;},
  response(response){response.once('end',()=>finish('returned',response.statusCode));response.once('aborted',()=>finish('response-aborted',response.statusCode));response.once('error',()=>finish('response-error',response.statusCode));},
  error(){finish('transport-error');},
  aborted(){finish('request-aborted');}
 };
}
