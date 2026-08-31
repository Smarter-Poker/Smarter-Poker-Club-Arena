import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const MANIFEST = 'runtime-asset-manifest.json';
const isRuntimeAsset = (name) => /\.(?:css|js)$/i.test(name);

async function filesBelow(root, relative = '') {
  const directory = path.join(root, relative);
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const files = [];
  for (const entry of entries) {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) files.push(...(await filesBelow(root, child)));
    else if (entry.isFile()) files.push(child.split(path.sep).join('/'));
  }
  return files;
}

async function removeEmptyDirectories(root, relative = '') {
  const directory = path.join(root, relative);
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.isDirectory()) await removeEmptyDirectories(root, path.join(relative, entry.name));
  }
  if (relative && (await readdir(directory).catch(() => [])).length === 0) await rm(directory);
}

async function readPreviousRuntimeAssets(target, targetAssetFiles) {
  try {
    const manifest = JSON.parse(await readFile(path.join(target, MANIFEST), 'utf8'));
    if (Array.isArray(manifest.assets)) {
      return manifest.assets.filter((entry) => typeof entry === 'string' && isRuntimeAsset(entry));
    }
  } catch {
    // The first rollout has no manifest. The checked-out target is exactly the
    // currently deployed bundle, so its runtime files are the safe fallback.
  }
  return targetAssetFiles.filter(isRuntimeAsset);
}

export async function syncClubArenaDist(source, target) {
  const sourceAssets = path.join(source, 'assets');
  const targetAssets = path.join(target, 'assets');
  const currentAssetFiles = await filesBelow(sourceAssets);
  const targetAssetFiles = await filesBelow(targetAssets);
  const previousRuntimeAssets = await readPreviousRuntimeAssets(target, targetAssetFiles);
  const currentRuntimeAssets = currentAssetFiles.filter(isRuntimeAsset);

  await mkdir(target, { recursive: true });
  const sourceRootEntries = new Set(
    (await readdir(source, { withFileTypes: true })).map((entry) => entry.name)
  );
  for (const entry of await readdir(target, { withFileTypes: true })) {
    if (entry.name === 'assets' || entry.name === MANIFEST) continue;
    if (!sourceRootEntries.has(entry.name))
      await rm(path.join(target, entry.name), { recursive: true });
  }
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.name === 'assets') continue;
    await cp(path.join(source, entry.name), path.join(target, entry.name), {
      recursive: true,
      force: true,
    });
  }

  await mkdir(targetAssets, { recursive: true });
  await cp(sourceAssets, targetAssets, { recursive: true, force: true });

  const allowedRuntime = new Set([...previousRuntimeAssets, ...currentRuntimeAssets]);
  const currentAssets = new Set(currentAssetFiles);
  for (const asset of await filesBelow(targetAssets)) {
    const keep = isRuntimeAsset(asset) ? allowedRuntime.has(asset) : currentAssets.has(asset);
    if (!keep) await rm(path.join(targetAssets, asset));
  }
  await removeEmptyDirectories(targetAssets);

  await writeFile(
    path.join(target, MANIFEST),
    `${JSON.stringify({ assets: currentRuntimeAssets.sort() }, null, 2)}\n`
  );
  return {
    currentRuntimeAssets: currentRuntimeAssets.length,
    retainedPreviousRuntimeAssets: previousRuntimeAssets.filter(
      (asset) => !currentRuntimeAssets.includes(asset)
    ).length,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [source, target] = process.argv.slice(2);
  if (!source || !target) throw new Error('Usage: sync-club-arena-dist.mjs <dist> <target>');
  console.log(JSON.stringify(await syncClubArenaDist(path.resolve(source), path.resolve(target))));
}
