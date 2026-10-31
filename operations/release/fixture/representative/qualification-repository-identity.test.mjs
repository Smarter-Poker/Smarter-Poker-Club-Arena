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
