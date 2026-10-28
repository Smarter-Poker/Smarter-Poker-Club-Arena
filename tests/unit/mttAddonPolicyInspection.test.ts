import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';
import ts from 'typescript';
import { parse } from 'yaml';

const root = resolve(__dirname, '../..');
const script = resolve(root, 'scripts/ci/inspect-tournament-refill.py');
const source = readFileSync(script, 'utf8');
const extracted = spawnSync(
  'python3',
  [
    '-B',
    '-c',
    'import json,runpy,sys;print(json.dumps(runpy.run_path(sys.argv[1])["ADDON_POLICY_JS"]))',
    script,
  ],
  { encoding: 'utf8', timeout: 5000 }
);
expect(extracted.status, extracted.stderr).toBe(0);
const program: string = JSON.parse(extracted.stdout);
const dataUrl = (value: string) =>
  `data:text/javascript;base64,${Buffer.from(value).toString('base64')}`;

function declaration(path: string, name: string) {
  const text = readFileSync(resolve(root, path), 'utf8');
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const node = file.statements.find(
    (statement) =>
      (ts.isFunctionDeclaration(statement) && statement.name?.text === name) ||
      (ts.isVariableStatement(statement) &&
        statement.declarationList.declarations.some(
          (item) => ts.isIdentifier(item.name) && item.name.text === name
        ))
  );
  expect(node, name).toBeDefined();
  return node!.getText(file);
}
const actualApi = ts.transpileModule(
  `import {createHash} from 'node:crypto';\n${[
    declaration('server/src/services/StableHand.ts', 'shHash'),
    declaration('server/src/services/FreeBuy.ts', 'HORSE_ADDON_PARTICIPATION_RATE'),
    declaration('server/src/services/FreeBuy.ts', 'horseTakesAddOn'),
  ].join('\n')}`,
  { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }
).outputText;

it.each(['actual', 'old-100', 'always-yes', 'always-no', 'unstable', 'ignores-event'])(
  'runs the actual selector declarations against the independent full-bucket witness: %s',
  (mode) => {
    const code = `const {inspectMttAddonPolicy}=await import(${JSON.stringify(dataUrl(program))});
const original=await import(${JSON.stringify(dataUrl(actualApi))});
let api=original,n=0;
if (${JSON.stringify(mode)}==='old-100') api={...original,HORSE_ADDON_PARTICIPATION_RATE:1};
if (${JSON.stringify(mode)}==='always-yes') api={...original,horseTakesAddOn:()=>true};
if (${JSON.stringify(mode)}==='always-no') api={...original,horseTakesAddOn:()=>false};
if (${JSON.stringify(mode)}==='unstable') api={...original,horseTakesAddOn:(...args)=>++n%2?original.horseTakesAddOn(...args):!original.horseTakesAddOn(...args)};
if (${JSON.stringify(mode)}==='ignores-event') api={...original,horseTakesAddOn:(h)=>original.horseTakesAddOn(h,'00000000-0000-4000-8000-000000000001')};
console.log(JSON.stringify(inspectMttAddonPolicy(api)));`;
    const result = spawnSync(
      'node',
      ['--input-type=module', '--max-old-space-size=64', '-e', code],
      { encoding: 'utf8', timeout: 5000 }
    );
    if (mode !== 'actual') {
      expect(result.status).not.toBe(0);
      return;
    }
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      rate: 0.74,
      buckets: 1000,
      selected: 740,
      declined: 260,
      repeatsPerPair: 8,
      stableOnRepeat: true,
      variedAcrossEvents: true,
      verified: true,
    });
  }
);

it.each([
  'stable',
  'bad-sha',
  'standby',
  'instance-change',
  'image-change',
  'bad-rate',
  'truthy-verified',
  'extra-field',
  'missing-digest',
  'oversize',
  'child-error',
])('the fixed read-only host mode refuses unknown runtime or policy evidence: %s', (mode) => {
  const fixture = `import contextlib,io,json,runpy,sys
m=runpy.run_path(sys.argv[1]);g=m['cli'].__globals__;mode=sys.argv[2];calls=[];identities=0
value={'rate':0.74,'buckets':1000,'selected':740,'declined':260,'repeatsPerPair':8,'stableOnRepeat':True,'variedAcrossEvents':True,'verified':True,'moduleSha256':'a'*64}
if mode=='bad-rate':value['rate']=1
if mode=='truthy-verified':value['verified']=1
if mode=='extra-field':value['private-token']='secret'
if mode=='missing-digest':del value['moduleSha256']
def identity(expected):
 global identities
 identities+=1
 return {'containerId':'c'*64,'imageId':'sha256:'+('e' if mode=='image-change' and identities>1 else 'd')*64,'health':'standby' if mode=='standby' else 'ok','instanceId':'2-bbbbbbbb' if mode=='instance-change' and identities>1 else '1-aaaaaaaa'}
def command(args,**kwargs):
 calls.append(args)
 if mode=='child-error':raise RuntimeError('private-token secret')
 return 'x'*4097 if mode=='oversize' else json.dumps(value)
g['identity']=identity;g['bounded_command']=command
out=io.StringIO();err=io.StringIO()
with contextlib.redirect_stdout(out),contextlib.redirect_stderr(err):status=m['cli'](['inspect','--mtt-addon-policy','bad;command' if mode=='bad-sha' else 'b'*40])
print(json.dumps({'status':status,'stdout':out.getvalue(),'stderr':err.getvalue(),'calls':calls,'identities':identities}))`;
  const ran = spawnSync('python3', ['-B', '-c', fixture, script, mode], {
    encoding: 'utf8',
    timeout: 5000,
  });
  expect(ran.status, ran.stderr).toBe(0);
  const result = JSON.parse(ran.stdout);
  expect(result.stdout + result.stderr).not.toMatch(/private-token|secret|Traceback/);
  if (mode === 'stable') {
    expect(result.status).toBe(0);
    const observed = JSON.parse(result.stdout);
    expect(observed.schema).toBe('mtt-addon-policy-observation/v1');
    expect(observed.runtimeStable).toBe(true);
    expect(observed.purchasesPerformed).toBe(false);
    expect(observed.naturalPurchaseCohortVerified).toBe(false);
    expect(observed.policy.selected).toBe(740);
  } else {
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
  }
  expect(result.calls).toHaveLength(['bad-sha', 'standby'].includes(mode) ? 0 : 1);
  if (result.calls.length) {
    expect(result.calls[0].slice(0, 8)).toEqual([
      'docker',
      'exec',
      '-i',
      'club-arena-engine',
      'node',
      '--input-type=module',
      '--max-old-space-size=64',
      '-e',
    ]);
    expect(result.calls[0].at(-1)).toBe('--inspect-mtt-addon-policy');
  }
});

it('uses an exclusive fixed mode in the existing manually invoked pinned inspector', () => {
  const workflow = parse(
    readFileSync(resolve(root, '.github/workflows/inspect-tournament-refill.yml'), 'utf8')
  );
  expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch']);
  expect(workflow.on.workflow_dispatch.inputs.mtt_addon_policy).toMatchObject({
    type: 'boolean',
    default: false,
  });
  expect(workflow.permissions).toEqual({ contents: 'read' });
  const run = workflow.jobs.inspect.steps.find((step: { run?: string }) => step.run)?.run;
  expect(run).toContain('Policy mode is exclusive');
  expect(run).toContain('python3 - --mtt-addon-policy');
  expect(run).toContain('StrictHostKeyChecking=yes');
  expect(source).toContain("const path='/app/dist/services/FreeBuy.js'");
  expect(program).not.toMatch(
    /process\.env|supabase|fetch\(|process_tournament_rebuy|writeFile|setTimeout|setInterval/
  );
});
