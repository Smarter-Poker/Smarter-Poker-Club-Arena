import { describe, expect, it } from 'vitest';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

const read = (file: string) => readFile(path.join(process.cwd(), file), 'utf8');

const activationTransaction = (workflow: string) => {
  const startMarker = "<<'REMOTE_ACTIVATE'";
  const start = workflow.indexOf(startMarker);
  expect(start, 'missing host-owned activation transaction').toBeGreaterThan(-1);
  const bodyStart = start + startMarker.length;
  const end = workflow.indexOf('\n          REMOTE_ACTIVATE', bodyStart);
  expect(end, 'unterminated host-owned activation transaction').toBeGreaterThan(bodyStart);
  return workflow.slice(bodyStart, end);
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
    expect(transaction).toContain(
      '[ "$(readlink "$ROOT/pool/fonts/fonts.css")" = "$ROOT/current/fonts/fonts.css" ]'
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
