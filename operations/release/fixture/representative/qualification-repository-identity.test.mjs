import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('qualification binds the canonical transferred namespace and original numeric repository', () => {
  const source = fileURLToPath(new URL('../../native/qualify-components.py', import.meta.url));
  const code = `
import importlib.util
import sys
spec=importlib.util.spec_from_file_location('qualifier',sys.argv[1])
module=importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
canonical='Smarter-Software-PIQ/Smarter-Poker-Club-Arena'
old='Smarter-Poker/Smarter-Poker-Club-Arena'
metadata={'id':1132369872,'full_name':canonical}
module.validate_repository_identity(canonical,canonical,metadata)
cases=[(old,canonical,metadata),(canonical,old,metadata),
 (canonical,canonical,{'id':1132369873,'full_name':canonical}),
 (canonical,canonical,{'id':1132369872,'full_name':old}),
 (canonical,canonical,None),(canonical,canonical,{}),
 ('Other/Smarter-Poker-Club-Arena',canonical,metadata),
 (canonical,'Other/Smarter-Poker-Club-Arena',metadata)]
for request,context,actual in cases:
 try: module.validate_repository_identity(request,context,actual)
 except RuntimeError as error:
  assert str(error)=='RELEASE_SEMANTIC_REPOSITORY_IDENTITY_REQUIRED'
 else: raise AssertionError('foreign, aliased or unreadable identity accepted')
print('exact identity accepted; 8 negative bindings refused')
`;
  const result = spawnSync('python3', ['-B', '-c', code, source], {
    encoding: 'utf8',
    timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /8 negative bindings refused/);
});

test('isolated RIT controller refuses incomplete, skipped or mismatched native receipts', () => {
  const source = fileURLToPath(new URL('../../native/qualify-components.py', import.meta.url));
  const code = `
import importlib.util,sys,copy
spec=importlib.util.spec_from_file_location('qualifier',sys.argv[1])
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
tuple_value={'club-arena-engine':{'source_sha':'a'*40}}
schema={'fixture_sha256':'b'*64,'catalogue_digest':'c'*64}
names=['exact-schema-and-stable-component-identities','browser-raise-call-allin-fold-saved-once','actual-three-run-choice-and-acceptance','three-board-winning-card-timing-and-chip-landings','settled-choice-clearing-and-cold-reload']
r={'version':1,'scope':'isolated-rit-player-ui-observations','product_certificate':False,'tuple':tuple_value,'runtime_image':'runtime','schema_fixture_sha256':schema['fixture_sha256'],'schema_catalogue_digest':schema['catalogue_digest'],'success':True,'executed':5,'failed':0,'skipped':0,'retries':0,'cases':[{'name':n,'passed':True} for n in names],'engine_readiness':{'timeout_ms':90000,'elapsed_ms':0,'observations':1,'source_sha':'a'*40,'running':True},'cleanup':{'complete':False,'owner':'outer-native-driver'}}
actors=['a1000000-0000-4000-8000-000000000001','a1000000-0000-4000-8000-000000000002']
r['proof']={'actionHistory':{'table_id':'b1000000-0000-4000-8000-000000000001','hand_number':42,
 'accepted_http_count':4,'wire_event_count':4,'history_count':1,
 'actions':[{'ordinal':i+3,'user_id':actors[[0,1,1,0][i]],'seat':[1,2,2,1][i],
 'action':action,'amount':[6,4,194,0][i],'street':'preflop' if i<2 else 'flop','origin':'player'}
 for i,action in enumerate(['raise','call','all_in','fold'])]}}
m.validate_rit_player_ui_native(r,tuple_value,schema,'runtime')
for key,value in [('scope','isolated-tournament-player-ui-observations'),('executed',3),('skipped',1),('retries',1),('product_certificate',True),('schema_fixture_sha256','wrong'),('runtime_image','wrong'),('cases',r['cases'][:-1]),('engine_readiness',{}),('cleanup',{'complete':True})]:
 bad=copy.deepcopy(r);bad[key]=value
 try:m.validate_rit_player_ui_native(bad,tuple_value,schema,'runtime')
 except RuntimeError as error:assert str(error)=='RELEASE_RIT_PLAYER_UI_EXECUTION_REQUIRED'
 else:raise AssertionError('incomplete native receipt accepted')
print('10 incomplete native receipts refused')
`;
  const result = spawnSync('python3', ['-B', '-c', code, source], {
    encoding: 'utf8',
    timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /10 incomplete native receipts refused/);
});
