import assert from 'node:assert/strict';
import { mkdir, lstat } from 'node:fs/promises';
import path from 'node:path';

// This runs in the oracle process, never the fixture service process. The
// service UID cannot chown files to the oracle and must not pre-create its home.
export async function prepareOracleHome({
  home = '/tmp/qualification',
  cache = '/tmp/qualification/cache',
  uid = 1001,
  gid = 1001,
} = {}) {
  assert.equal(process.getuid(), uid, 'RELEASE_SEMANTIC_ORACLE_UID_REFUSED');
  assert.equal(process.getgid(), gid, 'RELEASE_SEMANTIC_ORACLE_GID_REFUSED');
  assert.ok(
    path.isAbsolute(home) && path.dirname(cache) === home && path.basename(cache) === 'cache',
    'RELEASE_SEMANTIC_ORACLE_HOME_REFUSED'
  );
  for (const directory of [home, cache]) {
    try {
      await mkdir(directory, { mode: 0o700 });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    const stat = await lstat(directory);
    assert.ok(
      stat.isDirectory() &&
        !stat.isSymbolicLink() &&
        stat.uid === uid &&
        stat.gid === gid &&
        (stat.mode & 0o777) === 0o700,
      'RELEASE_SEMANTIC_ORACLE_HOME_REFUSED'
    );
  }
  return { home, cache };
}
