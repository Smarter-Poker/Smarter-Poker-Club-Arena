#!/usr/bin/env node
import { lstat, readdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { engineDoors } from '../../scripts/ci/check-engine-doors-exist.mjs';

export async function doorManifest(directory) {
  let bytes = 0;
  async function validate(folder) {
    for (const name of await readdir(folder)) {
      const full = path.join(folder, name), info = await lstat(full);
      if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) throw new Error('RELEASE_SOURCE_SYMLINK_REFUSED');
      if (info.isDirectory()) await validate(full);
      else { bytes += info.size; if (bytes > 64 * 1024 * 1024) throw new Error('RELEASE_SOURCE_SIZE_LIMIT'); }
    }
  }
  await validate(directory);
  const names = [...engineDoors(directory).keys()].sort();
  const allowlist = JSON.parse(await readFile(new URL('../../scripts/ci/engine-doors.allowlist.json', import.meta.url), 'utf8'));
  const exceptions = Object.fromEntries(names.filter((name) => allowlist[name]).map((name) => [name, allowlist[name]]));
  return { names, exceptions, digest: createHash('sha256').update(JSON.stringify({ names, exceptions })).digest('hex') };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await writeFile(process.argv[3], JSON.stringify(await doorManifest(path.resolve(process.argv[2]))));
