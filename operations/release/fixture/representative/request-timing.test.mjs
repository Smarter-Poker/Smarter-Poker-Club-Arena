import test from 'node:test';import assert from 'node:assert/strict';import {EventEmitter} from 'node:events';import {observeIsolatedRequest} from './request-timing.mjs';
test('isolated RPC timing records actual start/end once without credentials or body/query data',async()=>{
 const rows=[],sink=observeIsolatedRequest({method:'POST',url:'/rest/v1/rpc/fn_assign_tournament_player_seat_atomic?secret=DO_NOT_RECORD',ordinal:7,onFailure:()=>assert.fail('Timing sink failed'),record:r=>rows.push(r)});
 const response=new EventEmitter();response.statusCode=200;sink.response(response);await new Promise(r=>setTimeout(r,10));response.emit('end');response.emit('error',new Error('SECRET_ERROR'));sink.aborted();
 assert.equal(rows.length,2);assert.equal(rows[1].outcome,'returned');assert.equal(rows[1].httpStatus,200);assert.equal(rows[0].startedAt,rows[1].startedAt);assert.ok(rows[1].durationMs>=5);assert.ok(Date.parse(rows[1].finishedAt)>=Date.parse(rows[0].startedAt));assert.doesNotMatch(JSON.stringify(rows),/DO_NOT_RECORD|SECRET_ERROR|secret=|authorization|token/);
});
test('unknown/refused transport remains explicit once and unrelated routes are unobserved',()=>{
 const rows=[];const sink=observeIsolatedRequest({method:'POST',url:'/rest/v1/rpc/fn_register_for_tournament_request',ordinal:8,onFailure:()=>assert.fail('Timing sink failed'),record:r=>rows.push(r)});sink.error();sink.error();assert.equal(rows.length,2);assert.equal(rows[1].outcome,'transport-error');assert.equal(rows[1].httpStatus,null);
 for(const [method,url] of [['GET','/rest/v1/rpc/fn_register_for_tournament_request'],['POST','/auth/v1/token'],['POST','/rest/v1/rpc/unknown']])assert.equal(observeIsolatedRequest({method,url,ordinal:9,onFailure:()=>assert.fail(),record:()=>assert.fail()}),null);
});

test('timing sink failure stays sticky and cannot throw into the original response or retry a record',()=>{
 let records=0,failures=0;const sink=observeIsolatedRequest({method:'POST',url:'/rest/v1/rpc/fn_assign_tournament_player_seat_atomic',ordinal:10,record:()=>{records++;throw new Error('private filesystem detail');},onFailure:reason=>{assert.equal(reason,'ISOLATED_REQUEST_TIMING_SINK_FAILED');failures++;throw new Error('private reporter detail');}});
 const response=new EventEmitter();response.statusCode=200;assert.doesNotThrow(()=>{sink.response(response);response.emit('end');response.emit('error',new Error('private upstream detail'));sink.error();});assert.equal(sink.observationFailed,true);assert.equal(records,1);assert.equal(failures,1);
});

test('both actual launch atomic RPC names are observed with returned refusals unchanged',()=>{
 for(const operation of ['fn_begin_tournament_launch_atomic','fn_complete_tournament_launch_atomic']){const rows=[];const sink=observeIsolatedRequest({method:'POST',url:'/rest/v1/rpc/'+operation,ordinal:11,record:r=>rows.push(r),onFailure:()=>assert.fail()});assert.ok(sink);const response=new EventEmitter();response.statusCode=422;sink.response(response);response.emit('end');assert.equal(rows[1].operation,operation);assert.equal(rows[1].httpStatus,422);assert.equal(rows[1].outcome,'returned');}
});
