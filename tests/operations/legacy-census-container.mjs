// Isolated required qualification, never a production host or game operation.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const image =
  'node:22-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5';
const witness = randomUUID();
const name = `legacy-census-qualification-${witness}`;
const label = 'smarter-poker.test.legacy-census';
const files = [
  ['../../server/scripts/legacy-engine-checkpoint.mjs', 'legacy-engine-checkpoint.mjs'],
  ['legacy-census-projection.mjs', 'legacy-census-projection.mjs'],
  ['legacy-census-loaded.mjs', 'legacy-census-loaded.mjs'],
  ['legacy-census-interruption.mjs', 'legacy-census-interruption.mjs'],
];
const optionalTarget = new URL('legacy-census-interruption-target.mjs', import.meta.url);
if (existsSync(optionalTarget))
  files.push(['legacy-census-interruption-target.mjs', 'legacy-census-interruption-target.mjs']);
const mounts = files.flatMap(([relative, target]) => {
  const source = fileURLToPath(new URL(relative, import.meta.url));
  assert.ok(existsSync(source), `qualification source missing: ${target}`);
  return ['--mount', `type=bind,source=${source},target=/fixture/${target},readonly`];
});
const program = `
const assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');
assert.equal(process.version,'v22.23.2');
assert.equal(process.platform,'linux');
const deadline=Date.now()+170000;
const results={};
for(const scenario of ['projection','interruption','loaded']) {
  const budget=Math.min(65000,deadline-Date.now());
  assert.ok(budget>0,'native qualification deadline');
  const child=spawnSync(process.execPath,['--max-old-space-size=6144','/fixture/legacy-census-'+scenario+'.mjs','file:///fixture/legacy-engine-checkpoint.mjs'],{
    encoding:'utf8',timeout:budget,killSignal:'SIGKILL',maxBuffer:262144,
    env:{PATH:process.env.PATH,TMPDIR:'/tmp',TZ:'UTC'}
  });
  assert.equal(child.error,undefined,scenario+': '+child.error);
  assert.equal(child.signal,null,scenario+': '+child.signal);
  assert.equal(child.status,0,scenario+': '+child.stderr);
  results[scenario]=JSON.parse(child.stdout.trim());
  assert.equal(results[scenario].ok,true,scenario+': native proof did not pass');
}
console.log(JSON.stringify({ok:true,nativeVersion:process.version,platform:process.platform,results}));
`;
let result;
try {
  result = spawnSync(
    'docker',
    [
      'run',
      '--rm',
      '--name',
      name,
      '--label',
      `${label}=${witness}`,
      '--network',
      'none',
      '--read-only',
      '--memory',
      '8g',
      '--pids-limit',
      '128',
      '--tmpfs',
      '/tmp:rw,nosuid,size=64m',
      ...mounts,
      image,
      'node',
      '--no-inspect',
      '-e',
      program,
    ],
    { encoding: 'utf8', timeout: 190000, killSignal: 'SIGKILL', maxBuffer: 524288 }
  );
} finally {
  const owned = spawnSync(
    'docker',
    ['inspect', '--format', `{{index .Config.Labels "${label}"}}`, name],
    { encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL' }
  );
  if (owned.status === 0) {
    assert.equal(owned.stdout.trim(), witness, 'qualification container ownership changed');
    const removed = spawnSync('docker', ['rm', '-f', name], {
      encoding: 'utf8',
      timeout: 10000,
      killSignal: 'SIGKILL',
    });
    assert.equal(removed.status, 0, removed.stderr);
  } else {
    assert.equal(owned.error, undefined, 'qualification cleanup observation unavailable');
    assert.match(
      owned.stderr,
      /No such (?:object|container)/i,
      'qualification cleanup outcome unknown'
    );
  }
}
assert.equal(result.error, undefined, String(result.error));
assert.equal(result.signal, null, result.stderr);
assert.equal(result.status, 0, result.stderr);
const receipt = JSON.parse(result.stdout.trim());
assert.equal(receipt.ok, true);
console.log(JSON.stringify({ ...receipt, image }));
