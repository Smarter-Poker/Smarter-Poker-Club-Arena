import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const path=new URL('../../supabase/migrations/20261007043848_v4_policy_schema_is_immutable_input_metadata.sql',import.meta.url);
const sql=readFileSync(path,'utf8');
test('explicit V4 pin is strict and absent pin has empty legacy identity',()=>{
 assert.match(sql,/NOT p_request \? 'policy_export_schema'/);
 assert.match(sql,/jsonb_typeof\(p_request->'policy_export_schema'\)='string'/);
 assert.match(sql,/IF p_schema IS NULL THEN RETURN '\{\}'::jsonb/);
 assert.match(sql,/IF p_schema<>'smarter-poker\.pio-policy\.v4' THEN RAISE EXCEPTION/);
 for(const bad of ['null','smarter-poker.pio-policy.v3','unknown'])assert.ok(sql.includes(`policy_export_schema\":${bad==='null'?'null':`\"${bad}\"`}`));
});
test('metadata connects checksum, approval, registration, worker receipt and immutability',()=>{
 for(const signature of ['fn_gto_v31_input_bundle_checksum(jsonb)','ca_gto_v31_approve_input_bundle(jsonb)','fn_gto_v31_register_dataset(jsonb)','fn_gto_v31_worker_contract(text)','fn_gto_v31_feature_binding_immutable()'])assert.ok(sql.includes(signature));
 assert.ok(sql.includes('v_bundle.policy_export_schema IS DISTINCT FROM'));
 assert.ok(sql.includes('b.policy_export_schema IS NOT DISTINCT FROM'));
 assert.ok(sql.includes('NEW.policy_export_schema IS DISTINCT FROM OLD.policy_export_schema'));
 assert.ok(sql.includes('public.fn_gto_v31_policy_identity(d.policy_export_schema) INTO v_result'));
 assert.ok(sql.includes('public.fn_gto_v31_policy_identity(p_bundle->>'));
 assert.ok(sql.includes('missing or duplicated'));
 assert.ok(sql.includes('actual IS DISTINCT FROM pg_temp.v31_policy_metadata_patch'));
 for(const attr of ['proowner','proacl','proconfig','prosecdef'])assert.ok(sql.includes(`p.${attr}`));
});
test('no installed migration or approved row is rewritten; schema declaration changes identity',()=>{
 assert.doesNotMatch(sql,/UPDATE\s+public\.gto_v31_(?:input_bundles|datasets|runtime_cells)/i);
 const legacy={contract:'smarter-poker.horse-solver-v31-input-bundle.v2',bundle_key:'real',files:[]};
 const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
 assert.equal(hash({...legacy,...{}}),hash(legacy));
 assert.notEqual(hash({...legacy,policy_export_schema:'smarter-poker.pio-policy.v4'}),hash(legacy));
 for(const signature of ['fn_gto_v31_source_node_valid(jsonb)','fn_gto_v31_build_cell(uuid,jsonb)','fn_gto_v31_heldout_metrics(uuid,text)','fn_gto_v31_seal_build(uuid)'])assert.ok(!sql.includes(signature));
});
