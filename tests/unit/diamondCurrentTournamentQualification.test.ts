import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '../..');
const probe = String.raw`
import importlib.util,json,pathlib,sys
from unittest.mock import patch
path=pathlib.Path('tests/sql/run-diamond-scheduled-tournaments.py')
spec=importlib.util.spec_from_file_location('qualification',path)
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
manifest_path=module.SQL/'diamond-tournament-current.manifest.json'
manifest=json.loads(manifest_path.read_text())
mode=sys.argv[1]
if mode=='body': manifest['doors'][0]['definition']+=' '
elif mode=='population': manifest['doors'].pop()
elif mode=='grant': manifest['doors'][0]['acl']='{unexpected=X/postgres}'
elif mode=='constraint': manifest['constraints'][0]['definition']+=' '
elif mode=='input': manifest['inputs'][next(iter(manifest['inputs']))]='0'*64
elif mode=='missing_input': manifest['inputs'].pop(next(iter(manifest['inputs'])))
original=pathlib.Path.read_text
def read(self,*args,**kwargs):
    return json.dumps(manifest) if self==manifest_path else original(self,*args,**kwargs)
try:
    with patch.object(pathlib.Path,'read_text',read):
        result=module.current_authorities_sql()
    if mode!='valid': raise AssertionError('corrupt qualification was admitted')
    assert 'current function metadata differs' in result
    assert 'GRANT EXECUTE' in result and ' TO PUBLIC;' in result
    print('VALID')
except SystemExit as error:
    print('REFUSED: '+str(error))
`;

describe('current tournament qualification refuses stale or corrupted evidence before SQL', () => {
  function run(mode: string) {
    return execFileSync('python3', ['-c', probe, mode], {
      cwd: root,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
      encoding: 'utf8',
      timeout: 20_000,
    }).trim();
  }

  it('validates the complete current capture and retains its actual public grants', () => {
    expect(run('valid')).toBe('VALID');
  });

  it.each([
    ['body', 'current tournament capture differs:'],
    ['population', 'current tournament capture requires 134 distinct authorities'],
    ['grant', 'unexpected current tournament execute grant:'],
    ['constraint', 'current constraint capture differs:'],
    ['input', 'current tournament input differs:'],
    ['missing_input', 'current tournament input set is incomplete'],
  ])('refuses %s corruption', (mode, refusal) => {
    expect(run(mode)).toMatch(new RegExp('^REFUSED: ' + refusal));
  });
});
