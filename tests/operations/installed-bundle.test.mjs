import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBundle } from '../../operations/release/build-bundle.mjs';
import { verifyBundle } from '../../operations/release/installed-bundle.mjs';
import { validateUpgrade } from '../../operations/release/upgrade-check.mjs';

test('real dependency bundle is reproducible, binds rendered identity and rejects changed or unmanifested bytes', async () => {
  const work = fileURLToPath(new URL('../../work/', import.meta.url));
  await mkdir(work, { recursive: true });
  const directory = await mkdtemp(path.join(work, 'bundle-test-'));
  try {
    const first = await buildBundle({
      output: path.join(directory, 'first'),
      serviceUser: 'existing_test_user',
      serviceGroup: 'existing_test_group',
    });
    const second = await buildBundle({
      output: path.join(directory, 'second'),
      serviceUser: 'existing_test_user',
      serviceGroup: 'existing_test_group',
    });
    assert.equal(first.bundle_digest, second.bundle_digest);
    const manifest = await verifyBundle(first.output, first.bundle_digest, readFile);
    assert.ok(manifest.files['node_modules/pg/lib/client.js']);
    assert.ok(manifest.files['fixture/package-lock.json']);
    assert.ok(manifest.files['fixture/fixture-server.mjs']);
    assert.equal(
      Object.keys(manifest.files).some((name) => name.startsWith('fixture/node_modules/')),
      false
    );
    const unit = await readFile(
      path.join(first.output, 'native/club-arena-release-controller.service'),
      'utf8'
    );
    assert.match(unit, /User=existing_test_user/);
    assert.match(unit, /flock --exclusive --nonblock --no-fork/);
    await writeFile(path.join(first.output, 'unmanifested.mjs'), 'extra');
    await assert.rejects(
      verifyBundle(first.output, first.bundle_digest, readFile),
      /RELEASE_INSTALLED_MANIFEST_INVALID/
    );
    await rm(path.join(first.output, 'unmanifested.mjs'));
    await writeFile(path.join(first.output, 'controller.mjs'), 'changed');
    await assert.rejects(
      verifyBundle(first.output, first.bundle_digest, readFile),
      /RELEASE_INSTALLED_BUNDLE_MISMATCH/
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test('excluding fixture installs never permits symlinks in installed control source', async () => {
  const work = fileURLToPath(new URL('../../work/', import.meta.url));
  await mkdir(work, { recursive: true });
  const directory = await mkdtemp(path.join(work, 'bundle-link-test-'));
  try {
    await writeFile(path.join(directory, 'outside'), 'synthetic outside bytes');
    for (const [index, name] of ['controller.mjs', 'fixture/fixture-server.mjs'].entries()) {
      const source = path.join(directory, 'source-' + index);
      await mkdir(path.dirname(path.join(source, name)), { recursive: true });
      await symlink(path.join(directory, 'outside'), path.join(source, name));
      await assert.rejects(
        buildBundle({
          source,
          output: path.join(directory, 'output-' + index),
          serviceUser: 'existing_test_user',
          serviceGroup: 'existing_test_group',
        }),
        /RELEASE_BUNDLE_SYMLINK_REFUSED/
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('native upgrade must be an exact component of the pending active release and restored DB identity', () => {
  const native_upgrade = { bundle_digest: 'b'.repeat(64), prior_bundle_digest: 'a'.repeat(64) };
  const intent = {
    operation_id: 'op',
    instance_id: 'instance',
    release_id: 'release',
    native_upgrade,
  };
  const snapshot = {
    controller: { instance_id: 'instance', active_release: 'release' },
    queue: [
      {
        release_id: 'release',
        resolution_manifest_digest: 'manifest',
        resolution_manifest: {
          components: [{ target: 'club-arena-web', controller_upgrade: native_upgrade }],
        },
      },
    ],
    external: [
      {
        id: 'op',
        status: 'UNKNOWN',
        intent: { target: 'club-arena-web', manifest_digest: 'manifest', native_upgrade },
      },
    ],
  };
  assert.equal(validateUpgrade(snapshot, intent).pending, true);
  for (const mutate of [
    (s) => {
      s.external[0].status = 'SUCCEEDED';
    },
    (s) => {
      s.controller.active_release = 'another';
    },
    (s) => {
      s.controller.instance_id = 'restored';
    },
    (s) => {
      s.queue[0].resolution_manifest.components[0].controller_upgrade = {};
    },
  ]) {
    const changed = structuredClone(snapshot);
    mutate(changed);
    assert.throws(() => validateUpgrade(changed, intent));
  }
});
