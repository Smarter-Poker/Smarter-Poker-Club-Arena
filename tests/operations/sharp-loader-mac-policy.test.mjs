import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SourceTextModule, SyntheticModule, createContext } from 'node:vm';
import path from 'node:path';
const source = readFileSync(new URL('../../scripts/lib/sharp-loader.mjs', import.meta.url), 'utf8');
async function harness(platform, { imported, installError, prefixExists = false } = {}) {
  const effects = [];
  const sentinel = { sharp: true };
  const context = createContext({
    process: { platform, env: {} },
    console: { warn: (...a) => effects.push(['warn', ...a]) },
  });
  const direct = new SyntheticModule(
    ['default'],
    function () {
      this.setExport('default', sentinel);
    },
    { context }
  );
  const mocks = {
    'node:child_process': {
      execSync: (...a) => {
        effects.push(['install', ...a]);
        if (installError) throw new Error('registry failure');
      },
    },
    'node:module': {
      createRequire: (root) => {
        effects.push(['require-prefix', root]);
        return () => sentinel;
      },
    },
    'node:fs': {
      existsSync: () => prefixExists,
      mkdirSync: (...a) => effects.push(['mkdir', ...a]),
      writeFileSync: (...a) => effects.push(['write', ...a]),
    },
    'node:os': { default: { tmpdir: () => '/controlled-temp' } },
    'node:path': { default: path },
  };
  const module = new SourceTextModule(source, {
    context,
    importModuleDynamically: async (specifier) => {
      assert.equal(specifier, 'sharp');
      if (!imported) throw new Error('ERR_MODULE_NOT_FOUND');
      await direct.link(() => {});
      await direct.evaluate();
      return direct;
    },
  });
  await module.link((name) => {
    assert.ok(Object.hasOwn(mocks, name), name);
    const values = mocks[name];
    return new SyntheticModule(
      Object.keys(values),
      function () {
        for (const [k, v] of Object.entries(values)) this.setExport(k, v);
      },
      { context }
    );
  });
  await module.evaluate();
  return { result: await module.namespace.loadSharp(), effects, sentinel };
}
for (const platform of ['darwin', 'linux'])
  test(`${platform} reads an already installed sharp without provisioning`, async () => {
    const r = await harness(platform, { imported: true });
    assert.equal(r.result, r.sentinel);
    assert.deepEqual(r.effects, []);
  });
test('missing sharp on Mac returns optional null before any file or process mutation', async () => {
  const r = await harness('darwin');
  assert.equal(r.result, null);
  assert.deepEqual(
    r.effects.map((x) => x[0]),
    ['warn']
  );
  assert.match(r.effects[0][1], /installation belongs in CI/);
});
test('Linux missing sharp retains the exact temp-prefix install and loads its result', async () => {
  const r = await harness('linux');
  assert.equal(r.result, r.sentinel);
  assert.deepEqual(
    r.effects.map((x) => x[0]),
    ['warn', 'mkdir', 'write', 'install', 'require-prefix']
  );
  const [, command, options] = r.effects.find((x) => x[0] === 'install');
  assert.equal(command, 'npm install --no-save --no-audit --no-fund --loglevel=error sharp');
  assert.equal(options.cwd, '/controlled-temp/ca-webp-sharp');
  assert.equal(options.timeout, 180000);
  assert.equal(options.env.NODE_ENV, 'development');
});
test('Linux existing prefix manifest is not overwritten', async () => {
  const r = await harness('linux', { prefixExists: true });
  assert.equal(r.result, r.sentinel);
  assert.equal(r.effects.filter((x) => x[0] === 'write').length, 0);
});
test('Linux fallback failure remains optional null', async () => {
  const r = await harness('linux', { installError: true });
  assert.equal(r.result, null);
  assert.equal(r.effects.filter((x) => x[0] === 'install').length, 1);
  assert.equal(r.effects.filter((x) => x[0] === 'require-prefix').length, 0);
});
