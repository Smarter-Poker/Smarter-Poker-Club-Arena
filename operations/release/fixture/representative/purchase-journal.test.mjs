import test from 'node:test';import assert from 'node:assert/strict';import {recoverPurchases} from './purchase-journal.mjs';
const state=()=>({groups:[{kind:'cash',tableId:'table',clubId:'club',users:[{id:'cash',buyinOp:'buy'}]},{kind:'sng',tournamentId:'tour',users:[{id:'touruser',registrationOp:'reg'}]}]});
const buy={id:'op',label:'atomic_table_buyin',requestIdentity:{p_user_id:'cash',p_table_id:'table',p_club_id:'club',p_idempotency_key:'buy'},outcome:'returned',httpStatus:200,result:{ok:true}};
const entry={requestId:'reg',actorId:'touruser',tournamentId:'tour',phase:'returned',httpStatus:200,result:{ok:true,registration_id:'original',request_id:'reg'}};
test('interrupted missing snapshot flags recover only acknowledged exact original operations',()=>{const s=state();recoverPurchases(s,[{...buy,outcome:'unknown'},buy,{...entry,phase:'unknown'},entry]);assert.equal(s.groups[0].users[0].buyinEntered,true);assert.equal(s.groups[1].users[0].registered,true);});
test('unknown/refused/foreign custody cannot become a new purchase',()=>{for(const rows of [[{...buy,outcome:'unknown'}],[{...buy,httpStatus:400}],[{...entry,phase:'unknown'}],[{...entry,tournamentId:'foreign'}]])assert.throws(()=>recoverPurchases(state(),rows));});

test('actual native void buy-in204 restores its exact operation, malformed acknowledgement refuses',()=>{const s=state();recoverPurchases(s,[{...buy,httpStatus:204,result:null}]);assert.equal(s.groups[0].users[0].buyinEntered,true);assert.throws(()=>recoverPurchases(state(),[{...buy,httpStatus:200,result:null}]));});
