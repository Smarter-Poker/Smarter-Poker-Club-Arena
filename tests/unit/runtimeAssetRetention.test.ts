import { describe, expect, it } from 'vitest';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const read = (file: string) => readFile(path.join(process.cwd(), file), 'utf8');

const ACTIVATION_SCRIPT = '.github/scripts/publish-origin-activate.sh';

/**
 * THE TRANSACTION IS A FILE NOW (2026-09-22). `jobs.<job_id>.steps[*].run`
 * may not exceed 21,000 characters and the inlined heredoc took the
 * publisher's step to 24,626, at which point GitHub stopped LOADING the
 * workflow at all: no jobs, no name, no publish, for over an hour. The
 * publishing job checks the repository out at the exact SHA it is publishing
 * and pipes this file to the origin, byte for byte what the heredoc fed to
 * `bash -s`. It comes back carrying the ten spaces the heredoc gave it, so
 * every window below reads exactly as it always did.
 */
const activationTransaction = (workflow: string) => {
  expect(
    workflow.includes(ACTIVATION_SCRIPT),
    'the publisher no longer pipes the host-owned activation transaction'
  ).toBe(true);
  return readFileSync(path.join(process.cwd(), ACTIVATION_SCRIPT), 'utf8')
    .split('\n')
    .map((line) => (line === '' ? line : `          ${line}`))
    .join('\n');
};

const shellFunction = (transaction: string, name: string) => {
  const start = transaction.indexOf(`${name}() {`);
  expect(start, `missing ${name}`).toBeGreaterThan(-1);
  const endMarker = '\n          }\n\n';
  const end = transaction.indexOf(endMarker, start);
  expect(end, `unterminated ${name}`).toBeGreaterThan(start);
  return transaction.slice(start, end + '\n          }'.length).replace(/^ {10}/gm, '');
};

const writeAdoptionProbe = async (sandbox: string, transaction: string) => {
  const probe = path.join(sandbox, 'adopt-font-stylesheet.sh');
  await writeFile(
    probe,
    `#!/usr/bin/env bash
set -euo pipefail
${shellFunction(transaction, 'adopt_legacy_font_stylesheet_pointer')}
mv() {
  [ "$#" -eq 3 ] && [ "$1" = '-Tf' ] || return 97
  /bin/mv -f "$2" "$3"
}
adopt_legacy_font_stylesheet_pointer "$1" "$2" "$3"
`
  );
  await chmod(probe, 0o755);
  return probe;
};

const writeRollbackSealProbe = async (sandbox: string, transaction: string) => {
  const probe = path.join(sandbox, 'seal-current-release.sh');
  await writeFile(
    probe,
    `#!/usr/bin/env bash
set -euo pipefail
${shellFunction(transaction, 'verify_release_identity')}
${shellFunction(transaction, 'verify_complete_manifest')}
${shellFunction(transaction, 'seal_current_release_for_rollback')}
mv() {
  [ "$#" -eq 3 ] && [ "$1" = '-Tf' ] || return 97
  /bin/mv -f "$2" "$3"
}
sync() {
  [ "$#" -eq 2 ] && [ "$1" = '-f' ] && [ -e "$2" ]
}
seal_current_release_for_rollback "$1" "$2" "$3" "$4" "$5" "$6"
`
  );
  await chmod(probe, 0o755);
  return probe;
};

const writeReleaseIdentity = async (
  release: string,
  sha: string,
  repository = 'Smarter-Poker/Smarter-Poker-Club-Arena',
  runId = '123456'
) => {
  await writeFile(
    path.join(release, 'build-info.json'),
    JSON.stringify({
      ca_sha: sha,
      built_at: '2026-09-10T15:48:00Z',
      built_by: 'publish-club-arena.yml',
      run_id: runId,
    })
  );
  await writeFile(
    path.join(release, 'ca-provenance.json'),
    JSON.stringify({
      schema: 1,
      commit: sha,
      builtBy: 'github-actions',
      dirty: false,
      historyComplete: true,
      behindMain: 0,
      aheadMain: 0,
      ciRun: `https://github.com/${repository}/actions/runs/${runId}`,
    })
  );
};

/**
 * A tab holding the previous index.html must retain access to its hashed
 * chunks. Publication therefore copies verified release bytes into an
 * additive origin pool before the public `current` pointer can move. Runtime
 * Runtime URL paths are append-only because a stable-looking name is not proof
 * of stable bytes. Source maps have a separate deny rule because they are
 * debugging material and are never part of the player runtime.
 */
describe('Club Arena runtime asset retention', () => {
  it('serves hashed assets and fonts from the additive pool', async () => {
    const caddy = await read('infra/ca-origin/Caddyfile');
    const pooled = caddy.indexOf('@pooled path /assets/* /fonts/*');
    const poolRoot = caddy.indexOf('root * /srv/club-arena/pool', pooled);
    const releaseRoot = caddy.indexOf('root * /srv/club-arena/current', poolRoot);

    expect(pooled).toBeGreaterThan(-1);
    expect(poolRoot).toBeGreaterThan(pooled);
    expect(releaseRoot).toBeGreaterThan(poolRoot);
  });

  it('fills and flushes the additive pool before atomically exposing a release', async () => {
    const workflow = await read('.github/workflows/publish-club-arena.yml');
    const transaction = activationTransaction(workflow);
    const lock = transaction.indexOf('flock -w 45 9');
    const verifiedRelease = transaction.indexOf('verify_complete_manifest "$FINAL"');
    const collisionGuard = transaction.indexOf(
      'assert_additive_pool_has_no_collision "$FINAL/assets" "$ROOT/pool/assets"'
    );
    const assetSync = transaction.indexOf(
      'rsync -a --ignore-existing --fsync "$FINAL/assets/" "$ROOT/pool/assets/"'
    );
    const fontSync = transaction.indexOf(
      'rsync -a --ignore-existing --fsync --exclude=\'/fonts.css\' "$FINAL/fonts/" "$ROOT/pool/fonts/"'
    );
    const poolProof = transaction.indexOf(
      'prove_additive_pool_contains_release "$FINAL/assets" "$ROOT/pool/assets"'
    );
    const fontPointer = transaction.indexOf('ln -s "$ROOT/current/fonts/fonts.css" "$FONT_NEXT"');
    const flush = transaction.indexOf('sync -f "$ROOT"', fontPointer);
    const swap = transaction.indexOf('mv -Tf "$NEXT" "$ROOT/current"');

    expect(lock).toBeGreaterThan(-1);
    expect(verifiedRelease).toBeGreaterThan(lock);
    expect(collisionGuard).toBeGreaterThan(verifiedRelease);
    expect(assetSync).toBeGreaterThan(collisionGuard);
    expect(fontSync).toBeGreaterThan(assetSync);
    expect(poolProof).toBeGreaterThan(fontSync);
    expect(fontPointer).toBeGreaterThan(poolProof);
    expect(flush).toBeGreaterThan(fontPointer);
    expect(swap).toBeGreaterThan(flush);
  });

  it('never delete-syncs the pool and has no bundle-membership prune', async () => {
    const workflow = await read('.github/workflows/publish-club-arena.yml');
    const transaction = activationTransaction(workflow);
    const poolSyncs = transaction
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('rsync ') && line.includes('$ROOT/pool/'));

    expect(poolSyncs).toEqual([
      'rsync -a --ignore-existing --fsync "$FINAL/assets/" "$ROOT/pool/assets/"',
      'rsync -a --ignore-existing --fsync --exclude=\'/fonts.css\' "$FINAL/fonts/" "$ROOT/pool/fonts/"',
    ]);
    for (const line of poolSyncs) expect(line).not.toContain('--delete');
    expect(transaction).toContain(
      'find "$ROOT/pool/fonts" -type l ! -path "$ROOT/pool/fonts/fonts.css"'
    );
    expect(transaction).toContain('adopt_legacy_font_stylesheet_pointer \\\n');
    expect(shellFunction(transaction, 'adopt_legacy_font_stylesheet_pointer')).toContain(
      '[ "$(readlink "$pointer")" = "$current_stylesheet" ]'
    );

    const runtimePrunes = transaction
      .split('\n')
      .map((line) => line.trim())
      .filter(
        (line) =>
          line.startsWith('find "$ROOT/pool"') &&
          line.endsWith('-delete') &&
          !line.includes("'*.map'")
      );
    expect(runtimePrunes).toEqual([]);
    expect(workflow).not.toContain('sync-club-arena-dist.mjs');
  });

  it('atomically adopts the legacy regular fonts.css only when its bytes exactly match current', async () => {
    const workflow = await read('.github/workflows/publish-club-arena.yml');
    const transaction = activationTransaction(workflow);
    const sandbox = await mkdtemp(path.join(tmpdir(), 'club-arena-font-adoption-'));
    try {
      const currentDir = path.join(sandbox, 'current', 'fonts');
      const poolDir = path.join(sandbox, 'pool', 'fonts');
      const current = path.join(currentDir, 'fonts.css');
      const pointer = path.join(poolDir, 'fonts.css');
      const staged = path.join(poolDir, '.fonts.css.stage');
      await mkdir(currentDir, { recursive: true });
      await mkdir(poolDir, { recursive: true });
      await writeFile(current, '/* exact current stylesheet */');
      await writeFile(pointer, '/* exact current stylesheet */');
      const probe = await writeAdoptionProbe(sandbox, transaction);

      const adopted = spawnSync('bash', [probe, pointer, current, staged], { encoding: 'utf8' });
      expect(adopted.status, adopted.stderr).toBe(0);
      expect((await lstat(pointer)).isSymbolicLink()).toBe(true);
      expect(await readlink(pointer)).toBe(current);

      await rm(pointer);
      await writeFile(pointer, '/* changed legacy bytes */');
      const mismatched = spawnSync('bash', [probe, pointer, current, staged], {
        encoding: 'utf8',
      });
      expect(mismatched.status).toBe(1);
      expect(mismatched.stderr).toContain(
        'legacy mutable font stylesheet differs from current release'
      );
      expect((await lstat(pointer)).isFile()).toBe(true);
      expect(await readFile(pointer, 'utf8')).toBe('/* changed legacy bytes */');
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  it('accepts the canonical pointer and rejects directories, special files, and wrong symlinks', async () => {
    const workflow = await read('.github/workflows/publish-club-arena.yml');
    const transaction = activationTransaction(workflow);
    const sandbox = await mkdtemp(path.join(tmpdir(), 'club-arena-font-shapes-'));
    try {
      const currentDir = path.join(sandbox, 'current', 'fonts');
      const poolDir = path.join(sandbox, 'pool', 'fonts');
      const current = path.join(currentDir, 'fonts.css');
      const pointer = path.join(poolDir, 'fonts.css');
      const staged = path.join(poolDir, '.fonts.css.stage');
      await mkdir(currentDir, { recursive: true });
      await mkdir(poolDir, { recursive: true });
      await writeFile(current, '/* current */');
      const probe = await writeAdoptionProbe(sandbox, transaction);

      await symlink(current, pointer);
      const canonical = spawnSync('bash', [probe, pointer, current, staged], { encoding: 'utf8' });
      expect(canonical.status, canonical.stderr).toBe(0);
      expect(await readlink(pointer)).toBe(current);

      await rm(pointer);
      await symlink(path.join(sandbox, 'wrong.css'), pointer);
      const wrongLink = spawnSync('bash', [probe, pointer, current, staged], { encoding: 'utf8' });
      expect(wrongLink.status).toBe(1);
      expect(wrongLink.stderr).toContain('mutable font stylesheet pointer is malformed');
      expect(await readlink(pointer)).toBe(path.join(sandbox, 'wrong.css'));

      await rm(pointer);
      await mkdir(pointer);
      const directory = spawnSync('bash', [probe, pointer, current, staged], { encoding: 'utf8' });
      expect(directory.status).toBe(1);
      expect(directory.stderr).toContain('legacy mutable font stylesheet is not a regular file');

      await rm(pointer, { recursive: true });
      const fifo = spawnSync('mkfifo', [pointer], { encoding: 'utf8' });
      expect(fifo.status, fifo.stderr).toBe(0);
      const special = spawnSync('bash', [probe, pointer, current, staged], { encoding: 'utf8' });
      expect(special.status).toBe(1);
      expect(special.stderr).toContain('legacy mutable font stylesheet is not a regular file');
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  it('seals the exact legacy current release once so first-adoption rollback is verifiable', async () => {
    const workflow = await read('.github/workflows/publish-club-arena.yml');
    const transaction = activationTransaction(workflow);
    const sandbox = await mkdtemp(path.join(tmpdir(), 'club-arena-rollback-seal-'));
    try {
      const sha = 'a'.repeat(40);
      const repository = 'Smarter-Poker/Smarter-Poker-Club-Arena';
      const releases = path.join(sandbox, 'releases');
      const incoming = path.join(sandbox, 'incoming');
      const release = path.join(releases, sha);
      const current = path.join(sandbox, 'current');
      const staged = path.join(incoming, '.legacy-release-manifest.stage');
      const check = path.join(incoming, '.manifest-check.stage');
      await mkdir(release, { recursive: true });
      await mkdir(incoming, { recursive: true });
      await writeFile(path.join(release, 'index.html'), '<main>Current</main>');
      await writeReleaseIdentity(release, sha, repository);
      await symlink(release, current);
      const probe = await writeRollbackSealProbe(sandbox, transaction);

      const first = spawnSync('bash', [probe, current, release, sha, repository, staged, check], {
        encoding: 'utf8',
      });
      expect(first.status, first.stderr).toBe(0);
      const manifest = path.join(release, '.release-manifest.sha256');
      expect((await lstat(manifest)).isFile()).toBe(true);
      const sealedBytes = await readFile(manifest, 'utf8');
      expect(sealedBytes).toContain('  ./index.html');
      expect(sealedBytes).toContain('  ./build-info.json');
      expect(sealedBytes).toContain('  ./ca-provenance.json');
      expect(sealedBytes).not.toContain('.release-manifest.sha256');

      const second = spawnSync('bash', [probe, current, release, sha, repository, staged, check], {
        encoding: 'utf8',
      });
      expect(second.status, second.stderr).toBe(0);
      expect(await readFile(manifest, 'utf8')).toBe(sealedBytes);
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  it('refuses to seal an untrusted, incomplete, linked, or special legacy release', async () => {
    const workflow = await read('.github/workflows/publish-club-arena.yml');
    const transaction = activationTransaction(workflow);
    const repository = 'Smarter-Poker/Smarter-Poker-Club-Arena';
    const sha = 'b'.repeat(40);

    const runCase = async (
      name: string,
      mutate: (release: string, current: string) => Promise<void>,
      expectedError?: string
    ) => {
      const sandbox = await mkdtemp(path.join(tmpdir(), `club-arena-seal-${name}-`));
      try {
        const release = path.join(sandbox, 'releases', sha);
        const incoming = path.join(sandbox, 'incoming');
        const current = path.join(sandbox, 'current');
        const staged = path.join(incoming, '.legacy-release-manifest.stage');
        const check = path.join(incoming, '.manifest-check.stage');
        await mkdir(release, { recursive: true });
        await mkdir(incoming, { recursive: true });
        await writeFile(path.join(release, 'index.html'), '<main>Current</main>');
        await writeReleaseIdentity(release, sha, repository);
        await symlink(release, current);
        await mutate(release, current);
        const probe = await writeRollbackSealProbe(sandbox, transaction);
        const result = spawnSync(
          'bash',
          [probe, current, release, sha, repository, staged, check],
          { encoding: 'utf8' }
        );
        expect(result.status, `${name}: ${result.stderr}`).not.toBe(0);
        if (expectedError) expect(result.stderr).toContain(expectedError);
        return { release, result };
      } finally {
        await rm(sandbox, { recursive: true, force: true });
      }
    };

    await runCase(
      'identity',
      async (release) => {
        const provenance = JSON.parse(
          await readFile(path.join(release, 'ca-provenance.json'), 'utf8')
        );
        provenance.commit = 'c'.repeat(40);
        await writeFile(path.join(release, 'ca-provenance.json'), JSON.stringify(provenance));
      },
      'release provenance does not match its source SHA'
    );
    await runCase(
      'symlink',
      async (release) => {
        await symlink(path.join(release, 'index.html'), path.join(release, 'linked.html'));
      },
      'current rollback release contains a symlink'
    );
    await runCase(
      'special',
      async (release) => {
        const fifo = spawnSync('mkfifo', [path.join(release, 'special.fifo')], {
          encoding: 'utf8',
        });
        expect(fifo.status, fifo.stderr).toBe(0);
      },
      'current rollback release contains a special file'
    );
    await runCase('incomplete-manifest', async (release) => {
      const hash = spawnSync('sha256sum', ['index.html'], { cwd: release, encoding: 'utf8' });
      expect(hash.status, hash.stderr).toBe(0);
      await writeFile(path.join(release, '.release-manifest.sha256'), hash.stdout);
    });
  });

  it('executes the production collision guard and rejects a reused URL with changed bytes', async () => {
    const workflow = await read('.github/workflows/publish-club-arena.yml');
    const transaction = activationTransaction(workflow);
    const functionStart = transaction.indexOf('assert_additive_pool_has_no_collision() {');
    const functionEndMarker = '\n          }\n\n          prove_additive_pool_contains_release() {';
    const functionEnd = transaction.indexOf(functionEndMarker, functionStart);
    expect(functionStart).toBeGreaterThan(-1);
    expect(functionEnd).toBeGreaterThan(functionStart);
    const functionSource = transaction.slice(functionStart, functionEnd + '\n          }'.length);

    const sandbox = await mkdtemp(path.join(tmpdir(), 'club-arena-pool-collision-'));
    try {
      const release = path.join(sandbox, 'release assets');
      const pool = path.join(sandbox, 'pooled assets');
      await mkdir(release, { recursive: true });
      await mkdir(pool, { recursive: true });
      await writeFile(path.join(release, 'stable-name.webp'), 'new bytes');
      await writeFile(path.join(pool, 'stable-name.webp'), 'old bytes');
      const probe = path.join(sandbox, 'probe.sh');
      await writeFile(
        probe,
        `#!/usr/bin/env bash\nset -euo pipefail\n${functionSource}\nassert_additive_pool_has_no_collision "$1" "$2"\n`
      );
      await chmod(probe, 0o755);

      const changed = spawnSync('bash', [probe, release, pool], { encoding: 'utf8' });
      expect(changed.status).toBe(1);
      expect(changed.stderr).toContain('pooled runtime URL would change bytes: stable-name.webp');

      await writeFile(path.join(pool, 'stable-name.webp'), 'new bytes');
      const identical = spawnSync('bash', [probe, release, pool], { encoding: 'utf8' });
      expect(identical.status, identical.stderr).toBe(0);
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });
});
