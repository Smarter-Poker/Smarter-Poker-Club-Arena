import test from 'node:test';
import assert from 'node:assert/strict';
import { validateAssignmentBrowserIdentity } from './qualify-agent-assignment-browser.mjs';
const club='a41434bb-8d0c-400a-8f0d-e8b3d65afed4';
const account={id:'11111111-1111-4111-8111-111111111111',email:'ca-customization-cert-postdeploy-fixture@example.invalid'};
const session={user:{id:account.id,email:account.email},access_token:'fixture-access',refresh_token:'fixture-refresh'};
test('browser proof permits only the existing reserved identity and club',()=>{
 assert.doesNotThrow(()=>validateAssignmentBrowserIdentity(account,session,club));
 assert.throws(()=>validateAssignmentBrowserIdentity({...account,email:'person@example.com'},session,club));
 assert.throws(()=>validateAssignmentBrowserIdentity(account,session,'unrelated-club'));
});
test('browser proof refuses missing, cross-user or incomplete sessions before launching Chromium',()=>{
 assert.throws(()=>validateAssignmentBrowserIdentity(account,null,club));
 assert.throws(()=>validateAssignmentBrowserIdentity(account,{...session,user:{...session.user,id:'another-user'}},club));
 assert.throws(()=>validateAssignmentBrowserIdentity(account,{...session,user:{...session.user,email:'someone@example.invalid'}},club));
 assert.throws(()=>validateAssignmentBrowserIdentity(account,{...session,refresh_token:null},club));
});
