// Builds only the maintained ABI-specific addon. Never contacts a game host.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const args = Object.fromEntries(process.argv.slice(2).map((x) => {
  const n = x.indexOf('=');
  if (n < 3) throw Error('Use --headers=absolute --output=absolute');
  return [x.slice(2, n), x.slice(n + 1)];
}));
if (process.version !== 'v22.23.2' || process.versions.v8 !== '12.4.254.21-node.56' ||
    process.versions.modules !== '127' || !['darwin', 'linux'].includes(process.platform) ||
    !['arm64', 'x64'].includes(process.arch)) throw Error('Exact supported Node/V8/ABI required');
if (!path.isAbsolute(args.headers ?? '') || !path.isAbsolute(args.output ?? ''))
  throw Error('Absolute headers/output required');
const source = fileURLToPath(new URL('legacy-census.cc', import.meta.url));
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const control = fs.readFileSync(new URL('../legacy-engine-checkpoint.mjs', import.meta.url),'utf8');
const pin = /^export const LEGACY_CENSUS_NATIVE_SOURCE_SHA256 = '([0-9a-f]{64})';$/m.exec(control)?.[1];
if (pin !== sha(fs.readFileSync(source))) throw Error('Maintained native source pin mismatch');
const headers = [];
function walk(dir, prefix = '') {
  for (const item of fs.readdirSync(dir, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name))) {
    const rel = prefix + item.name;
    if (item.isSymbolicLink()) throw Error('Header symlink refused');
    if (item.isDirectory()) walk(path.join(dir,item.name), rel + '/');
    else if (item.isFile()) headers.push([rel, sha(fs.readFileSync(path.join(dir,item.name)))]);
  }
}
walk(args.headers);
const compiler = process.platform === 'darwin' ? '/usr/bin/clang++' : 'c++';
const version = spawnSync(compiler, ['--version'], { encoding:'utf8', timeout:5000 });
if (version.status !== 0) throw Error('Compiler unavailable');
fs.mkdirSync(path.dirname(args.output), { recursive:true });
const options = ['-std=c++17', '-O2', '-shared', '-fPIC', '-fno-exceptions', '-I'+args.headers, '-DLEGACY_CENSUS_SOURCE_SHA256="'+pin+'"',
  ...(process.platform === 'darwin' ? ['-undefined','dynamic_lookup'] : []), source, '-o',args.output];
const build = spawnSync(compiler, options, { encoding:'utf8', timeout:60000 });
if (build.error || build.status !== 0) throw Error(build.stderr || String(build.error));
const manifest = { schema:'legacy-native-census-build/v1', node:process.version,
  v8:process.versions.v8, modules:process.versions.modules, platform:process.platform,
  arch:process.arch, pointerCompression:process.config.variables.v8_enable_pointer_compression,
  sourceSHA256:sha(fs.readFileSync(source)), headersSHA256:sha(JSON.stringify(headers)),
  binarySHA256:sha(fs.readFileSync(args.output)), compiler:version.stdout.trim(),
  maxMatches:22096, managedOutputBytes:22096*8*4+65536,
  qualification:'unqualified-build-only' };
fs.writeFileSync(args.output+'.json', JSON.stringify(manifest,null,2)+'\n');
console.log(JSON.stringify(manifest));
