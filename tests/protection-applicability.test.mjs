import {test} from 'node:test';
import assert from 'node:assert/strict';
import {assertProtection,assertReadonlyApplicability} from '../scripts/ci/assert-money-trigger-protection.mjs';
const app='123';
const rule=()=>({target:'branch',enforcement:'active',bypass_actors:[],conditions:{ref_name:{include:['refs/heads/main'],exclude:[]}},rules:[{type:'required_status_checks',parameters:{required_status_checks:[{context:'Money trigger declaration authority',integration_id:123}]}}]});
test('applicable exact main branch with exact source accepted',()=>assert.doesNotThrow(()=>assertProtection(rule(),app)));
test('unresolved default branch selector alone refused',()=>{const r=rule();r.conditions.ref_name.include=['~DEFAULT_BRANCH'];assert.throws(()=>assertProtection(r,app),/main branch rule/)});
for(const exclude of [['refs/heads/main'],['refs/heads/*'],['~ALL'],['refs/heads/other']])test('nonempty exclusion refused '+exclude,()=>{const r=rule();r.conditions.ref_name.exclude=exclude;assert.throws(()=>assertProtection(r,app),/zero exclusions/)});
for(const target of ['tag','push',undefined])test('nonbranch target refused '+target,()=>{const r=rule();r.target=target;assert.throws(()=>assertProtection(r,app),/main branch rule/)});
for(const mutate of [r=>delete r.conditions,r=>delete r.conditions.ref_name.exclude,r=>r.conditions.ref_name.include=['refs/heads/other'],r=>r.enforcement='evaluate',r=>r.bypass_actors=[{actor_id:1}],r=>delete r.bypass_actors])test('incomplete or inapplicable protection refused '+String(mutate),()=>{const r=rule();mutate(r);assert.throws(()=>assertProtection(r,app))});
test('wrong reporting app refused',()=>assert.throws(()=>assertProtection(rule(),'124'),/exact-source/));
test('missing required context refused',()=>{const r=rule();r.rules=[];assert.throws(()=>assertProtection(r,app),/exact-source/)});

test('readonly applicability accepts hidden metadata without certifying full protection',()=>{
 const r=rule();delete r.bypass_actors;
 assert.doesNotThrow(()=>assertReadonlyApplicability(r,app));
 assert.throws(()=>assertProtection(r,app),/no-bypass/);
});
test('readonly applicability accepts an explicitly empty visible bypass list',()=>assert.doesNotThrow(()=>assertReadonlyApplicability(rule(),app)));
for(const bypass of [null,undefined,{},'',[{actor_id:1}]])test('readonly refuses visible malformed or nonempty bypass '+JSON.stringify(bypass),()=>{
 const r=rule();r.bypass_actors=bypass;assert.throws(()=>assertReadonlyApplicability(r,app),/bypass/);
});
for(const mutate of [r=>delete r.conditions,r=>delete r.conditions.ref_name.exclude,r=>r.conditions.ref_name.exclude=['refs/heads/other'],r=>r.conditions.ref_name.include=['~DEFAULT_BRANCH'],r=>r.target='tag',r=>r.enforcement='evaluate',r=>r.rules=[]])test('readonly refuses inapplicable or unbound protection '+String(mutate),()=>{
 const r=rule();delete r.bypass_actors;mutate(r);assert.throws(()=>assertReadonlyApplicability(r,app));
});
test('readonly refuses a different reporting App',()=>assert.throws(()=>assertReadonlyApplicability(rule(),'124'),/exact-source/));
