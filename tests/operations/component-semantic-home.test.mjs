import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, lstat, mkdir, symlink, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { prepareOracleHome } from '../../operations/release/native/component-semantic-home.mjs';

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'semantic-oracle-home-'));
  const home = path.join(root, 'qualification');
  return {
    root,
    home,
    cache: path.join(home, 'cache'),
    uid: process.getuid(),
    gid: process.getgid(),
  };
}

test('oracle creates and can reuse its own private home/cache with actual filesystem ownership', async () => {
  const f = await fixture();
  try {
    assert.deepEqual(await prepareOracleHome(f), { home: f.home, cache: f.cache });
    for (const directory of [f.home, f.cache]) {
      const state = await lstat(directory);
      assert.equal(state.mode & 0o777, 0o700);
      assert.equal(state.uid, f.uid);
      assert.equal(state.gid, f.gid);
    }
    await prepareOracleHome(f);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('oracle refuses a precreated permissive home and never repairs another owner mode', async () => {
  const f = await fixture();
  try {
    await mkdir(f.home, { mode: 0o755 });
    await assert.rejects(prepareOracleHome(f), /ORACLE_HOME_REFUSED/);
    assert.equal((await lstat(f.home)).mode & 0o777, 0o755);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('oracle refuses home or cache symlinks without writing through them', async () => {
  for (const target of ['home', 'cache']) {
    const f = await fixture();
    try {
      const elsewhere = path.join(f.root, 'elsewhere');
      await mkdir(elsewhere, { mode: 0o700 });
      if (target === 'cache') await mkdir(f.home, { mode: 0o700 });
      await symlink(elsewhere, f[target]);
      await assert.rejects(prepareOracleHome(f), /ORACLE_HOME_REFUSED/);
      assert.ok((await lstat(f[target])).isSymbolicLink());
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  }
});

test('fixture UID cannot create an oracle home through the initialization entrypoint', async () => {
  const f = await fixture();
  try {
    await assert.rejects(prepareOracleHome({ ...f, uid: f.uid + 1 }), /ORACLE_UID_REFUSED/);
    await assert.rejects(lstat(f.home), (error) => error.code === 'ENOENT');
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
