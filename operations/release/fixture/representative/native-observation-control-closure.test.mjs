import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
async function smokeHelpers() {
  const script = await readFile(
    path.join(root, 'operations/release/fixture/smoke-image.sh'),
    'utf8'
  );
  const list = script.match(/^helpers=\(([^\n)]+)\)$/m);
  assert.ok(list, 'explicit smoke helper allowlist missing');
  return list[1].trim().split(/\s+/);
}

test('actual isolated smoke control staging can import its observation protocol dependency closure', async () => {
  const helpers = await smokeHelpers(),
    scratch = await mkdtemp(path.join(tmpdir(), 'fixture-observation-controls-'));
  try {
    for (const helper of helpers) {
      assert.match(helper, /^operations\/release\/native\/[a-z-]+\.mjs$/);
      const destination = path.join(scratch, helper);
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, await readFile(path.join(root, helper)), {
        flag: 'wx',
        mode: 0o444,
      });
    }
    const url = pathToFileURL(
      path.join(scratch, 'operations/release/native/component-observation-protocol.mjs')
    ).href;
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        "await import(process.argv[1]);console.log('isolated observation controls imported');",
        url,
      ],
      { encoding: 'utf8', cwd: scratch, timeout: 10000 }
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /isolated observation controls imported/);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('native source hash evidence covers exactly the staged observation control allowlist', async () => {
  const python = path.join(root, 'operations/release/ci/fixture-smoke.py');
  const code =
    "import importlib.util,json,sys;spec=importlib.util.spec_from_file_location('smoke',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);print(json.dumps(m.CONTROL_FILES))";
  const result = spawnSync('python3', ['-B', '-c', code, python], {
    encoding: 'utf8',
    timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).sort(), (await smokeHelpers()).sort());
});
