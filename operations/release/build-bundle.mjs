#!/usr/bin/env node
import { readdir, lstat, readFile, writeFile, mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { operationPolicyDigest } from './operation-policy.mjs';
import { hash } from './installed-bundle.mjs';

export async function buildBundle({
  source = fileURLToPath(new URL('.', import.meta.url)),
  output,
  serviceUser,
  serviceGroup,
  verifierUser,
  verifierGroup,
}) {
  if (![serviceUser, serviceGroup].every((name) => /^[a-z_][a-z0-9_-]{0,31}$/.test(name)))
    throw new Error('RELEASE_EXISTING_IDENTITY_REQUIRED');
  if ((verifierUser || verifierGroup) && (!verifierUser || verifierUser === serviceUser ||
    ![verifierUser,verifierGroup].every(name=>/^[a-z_][a-z0-9_-]{0,31}$/.test(name))))
    throw new Error('RELEASE_INDEPENDENT_VERIFIER_IDENTITY_REQUIRED');
  if (!path.isAbsolute(output)) throw new Error('RELEASE_BUNDLE_OUTPUT_INVALID');
  source = await realpath(source);
  output = path.join(await realpath(path.dirname(output)), path.basename(output));
  if (output === source || output.startsWith(source + path.sep))
    throw new Error('RELEASE_BUNDLE_OUTPUT_INVALID');
  const files = {};
  await mkdir(output, { recursive: false });
  async function walk(directory, prefix = '') {
    for (const entry of (await readdir(directory)).sort()) {
      if (entry === '__pycache__' || entry.endsWith('.pyc')) continue;
      const name = prefix + entry;
      // These packages belong inside the independently built Linux fixture
      // image. Host installs include CLI symlinks and are not controller deps.
      if (name === 'fixture/node_modules') continue;
      const from = path.join(directory, entry);
      const info = await lstat(from);
      if (info.isSymbolicLink()) throw new Error('RELEASE_BUNDLE_SYMLINK_REFUSED');
      if (info.isDirectory()) {
        await mkdir(path.join(output, name));
        await walk(from, `${name}/`);
      } else if (info.isFile()) {
        let bytes = await readFile(from);
        if (name === 'native/club-arena-release-controller.service')
          bytes = Buffer.from(
            bytes
              .toString()
              .replaceAll('@EXISTING_SERVICE_USER@', serviceUser)
              .replaceAll('@EXISTING_SERVICE_GROUP@', serviceGroup)
          );
        if (name.startsWith('native/club-arena-maintenance-verifier') && verifierUser)
          bytes=Buffer.from(bytes.toString().replaceAll('@EXISTING_VERIFIER_USER@',verifierUser)
            .replaceAll('@EXISTING_VERIFIER_GROUP@',verifierGroup).replaceAll('@EXISTING_SERVICE_GROUP@',serviceGroup));
        await writeFile(path.join(output, name), bytes, { mode: info.mode & 0o777 });
        files[name] = hash(bytes);
      } else throw new Error('RELEASE_BUNDLE_FILE_INVALID');
    }
  }
  await walk(source);
  if (!files['node_modules/pg/package.json'])
    throw new Error('RELEASE_BUNDLE_DEPENDENCIES_REQUIRED');
  const manifest = {
    format: 1,
    schema_version: 1,
    provider_schema_version: 1,
    operation_policy_digest: operationPolicyDigest,
    service_user: serviceUser,
    service_group: serviceGroup,
    ...(verifierUser ? {verifier_user:verifierUser,verifier_group:verifierGroup} : {}),
    files,
  };
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(path.join(output, 'bundle-manifest.json'), bytes);
  return { bundle_digest: hash(bytes), output, file_count: Object.keys(files).length };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [output, serviceUser, serviceGroup, verifierUser, verifierGroup] = process.argv.slice(2);
  buildBundle({ output, serviceUser, serviceGroup, verifierUser, verifierGroup })
    .then((value) => console.log(JSON.stringify(value)))
    .catch(() => {
      console.error('RELEASE_BUNDLE_BUILD_FAILED');
      process.exitCode = 1;
    });
}
