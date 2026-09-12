import { readFile, lstat, realpath, readdir } from 'node:fs/promises';
import path from 'node:path';
import { operationPolicyDigest } from './operation-policy.mjs';
import { createHash } from 'node:crypto';

export const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
export async function rootOwnedFile(filename) {
  if (!path.isAbsolute(filename)) throw new Error('RELEASE_INSTALLED_PATH_INVALID');
  for (let current = filename; ; current = path.dirname(current)) {
    const info = await lstat(current);
    if (info.uid !== 0 || info.mode & 0o022 || info.isSymbolicLink())
      throw new Error('RELEASE_INSTALLED_OWNERSHIP_INVALID');
    if (current === path.dirname(current)) break;
  }
  if (!(await lstat(filename)).isFile()) throw new Error('RELEASE_INSTALLED_PATH_INVALID');
  return readFile(filename);
}

export async function verifyBundle(directory, expectedDigest, read = rootOwnedFile) {
  const bytes = await read(path.join(directory, 'bundle-manifest.json'));
  if (hash(bytes) !== expectedDigest) throw new Error('RELEASE_INSTALLED_BUNDLE_MISMATCH');
  const manifest = JSON.parse(bytes);
  if (
    manifest.schema_version !== 1 ||
    manifest.provider_schema_version !== 1 ||
    manifest.operation_policy_digest !== operationPolicyDigest ||
    manifest.format !== 1 ||
    !manifest.files ||
    Object.keys(manifest.files).length < 5
  )
    throw new Error('RELEASE_SCHEMA_VERSION_UNSUPPORTED');
  for (const [name, digest] of Object.entries(manifest.files)) {
    if (
      !/^[a-zA-Z0-9_@.+/-]+$/.test(name) ||
      name.startsWith('/') ||
      name.split('/').includes('..') ||
      !/^[a-f0-9]{64}$/.test(digest)
    )
      throw new Error('RELEASE_INSTALLED_MANIFEST_INVALID');
    if (hash(await read(path.join(directory, name))) !== digest)
      throw new Error('RELEASE_INSTALLED_BUNDLE_MISMATCH');
  }
  const actual = [];
  async function visit(prefix = '') {
    for (const entry of await readdir(path.join(directory, prefix), { withFileTypes: true })) {
      const name = prefix + entry.name;
      if (entry.isDirectory()) await visit(`${name}/`);
      else if (entry.isFile()) actual.push(name);
      else throw new Error('RELEASE_INSTALLED_MANIFEST_INVALID');
    }
  }
  await visit();
  if (
    JSON.stringify(actual.sort()) !==
    JSON.stringify([...Object.keys(manifest.files), 'bundle-manifest.json'].sort())
  ) {
    throw new Error('RELEASE_INSTALLED_MANIFEST_INVALID');
  }
  return manifest;
}

export async function installedConfiguration(filename) {
  const bytes = await rootOwnedFile(filename);
  const config = JSON.parse(bytes);
  const directory = await realpath(new URL('.', import.meta.url));
  const digest = path.basename(directory);
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('RELEASE_IMMUTABLE_BUNDLE_REQUIRED');
  await verifyBundle(directory, digest);
  if (!['OBSERVE', 'RECONCILE', 'EXECUTE'].includes(config.mode ?? 'OBSERVE'))
    throw new Error('RELEASE_PROVIDER_MODE_INVALID');
  return { config, installation: { bundle_digest: digest, config_digest: hash(bytes) } };
}
