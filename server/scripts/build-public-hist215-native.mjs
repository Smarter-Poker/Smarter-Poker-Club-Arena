import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Build from this checkout for the receiving Node platform. No downloaded or
// committed native binary can substitute for the maintained source.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(root, 'native/public_hist215_wtl.cc');
const outputDir = resolve(root, 'native/build');
const output = resolve(outputDir, 'public_hist215_wtl.node');
if (!['linux', 'darwin'].includes(process.platform)) {
  throw new Error('public_hist215_native_build_platform_unsupported');
}
const include = resolve(dirname(process.execPath), '../include/node');
if (!existsSync(resolve(include, 'node_api.h'))) {
  throw new Error('public_hist215_native_build_node_headers_missing');
}
mkdirSync(outputDir, { recursive: true });
const scratch = resolve(outputDir, '_tmp');
mkdirSync(scratch, { recursive: true });
const temporary = `${output}.${process.pid}.partial`;
const compiler = process.platform === 'darwin' ? '/usr/bin/clang++' : 'g++';
const args = [
  '-std=c++17', '-O3', '-Wall', '-Wextra', '-Werror', '-shared',
  ...(process.platform === 'darwin' ? ['-undefined', 'dynamic_lookup'] : ['-fPIC']),
  '-DNODE_GYP_MODULE_NAME=native_wtl', '-DNAPI_VERSION=8',
  `-I${include}`, source, '-o', temporary,
];
try {
  const result = spawnSync(compiler, args, {
    stdio: 'inherit', timeout: 120_000,
    env: { ...process.env, TMPDIR: scratch, TMP: scratch, TEMP: scratch,
      CLANG_MODULE_CACHE_PATH: resolve(scratch, 'clang-module-cache') },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`public_hist215_native_build_exit:${result.status}`);
  renameSync(temporary, output);
  const sha = path => createHash('sha256').update(readFileSync(path)).digest('hex');
  console.log(JSON.stringify({
    contract: 'public_hist215_native_build_v1', platform: process.platform,
    architecture: process.arch, node: process.version, napi: 8,
    source_sha256: sha(source), binary_sha256: sha(output), output,
  }));
} finally {
  rmSync(temporary, { force: true });
}
