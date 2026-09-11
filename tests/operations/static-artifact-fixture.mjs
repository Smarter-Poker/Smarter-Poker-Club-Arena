import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  symlink,
  chmod,
  rm,
  realpath,
  lstat,
} from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const repository = 'Smarter-Poker/Smarter-Poker-Club-Arena';
const digest = (v) => createHash('sha256').update(v).digest('hex');
export function receiptZip(value) {
  const result = spawnSync(
    'python3',
    [
      '-c',
      'import io,json,sys,zipfile; b=io.BytesIO(); z=zipfile.ZipFile(b,"w"); z.writestr(zipfile.ZipInfo("receipt.json",(1980,1,1,0,0,0)),sys.stdin.buffer.read()); z.close(); sys.stdout.buffer.write(b.getvalue())',
    ],
    { input: JSON.stringify(value), timeout: 10000 }
  );
  if (result.status !== 0) throw new Error('native receipt zip failed');
  return result.stdout;
}
export async function staticArtifactFixture(source = 'a'.repeat(40), runId = '567') {
  const work = fileURLToPath(new URL('../../work/', import.meta.url));
  await mkdir(work, { recursive: true });
  let parent;
  for (const candidate of [await realpath(os.tmpdir()), work]) {
    let secure = true;
    for (let p = candidate; p !== path.dirname(p); p = path.dirname(p)) {
      const s = await lstat(p);
      if (
        !s.isDirectory() ||
        s.isSymbolicLink() ||
        ![0, process.getuid()].includes(s.uid) ||
        s.mode & 0o022
      )
        secure = false;
    }
    if (secure) {
      parent = candidate;
      break;
    }
  }
  if (!parent) throw new Error('native fixture requires secured existing parent');
  const directory = await mkdtemp(path.join(parent, 'static-artifact-'));
  const root = path.join(directory, 'root'),
    release = path.join(root, 'releases', source);
  await mkdir(release, { recursive: true });
  await writeFile(path.join(root, '.publish.lock'), 'existing lock\n');
  await chmod(path.join(root, '.publish.lock'), 0o664);
  await symlink(release, path.join(root, 'current'));
  const documents = {
    'build-info.json': JSON.stringify({
      ca_sha: source,
      built_by: 'publish-club-arena.yml',
      built_at: '2026-09-11T18:13:00Z',
      run_id: runId,
    }),
    'ca-provenance.json': JSON.stringify({
      commit: source,
      builtBy: 'github-actions',
      dirty: false,
      historyComplete: true,
      aheadMain: 0,
      behindMain: 0,
      ciRun: `https://github.com/${repository}/actions/runs/${runId}`,
    }),
    'index.html': '<html>Real isolated immutable artifact</html>\n',
  };
  for (const [name, bytes] of Object.entries(documents))
    await writeFile(path.join(release, name), bytes);
  await writeFile(
    path.join(release, '.release-manifest.sha256'),
    Object.keys(documents)
      .sort()
      .map((name) => `${digest(documents[name])}  ./${name}\n`)
      .join('')
  );
  const nativePath = fileURLToPath(
    new URL('../../operations/release/native/read-native-frontend.py', import.meta.url)
  );
  const readNative = async (expected = source) => {
    const result = spawnSync(
      'python3',
      [
        '-c',
        'import importlib.util,json,sys; s=importlib.util.spec_from_file_location("native",sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); print(json.dumps(m.read_artifact(sys.argv[2],sys.argv[3],0.1)))',
        nativePath,
        expected,
        root,
      ],
      { encoding: 'utf8', timeout: 10000 }
    );
    if (result.status !== 0) throw new Error(`native artifact refusal: ${result.stderr}`);
    return JSON.parse(result.stdout);
  };
  const readPublic = async () =>
    Object.fromEntries(
      ['origin', 'public'].map((side) => [
        side,
        Object.fromEntries(
          ['build-info.json', 'ca-provenance.json'].map((name) => [
            name,
            { value: JSON.parse(documents[name]), sha256: digest(documents[name]) },
          ])
        ),
      ])
    );
  return {
    source,
    runId,
    root,
    release,
    readNative,
    readPublic,
    manifestDigest: digest(await readFile(path.join(release, '.release-manifest.sha256'))),
    close: () => rm(directory, { recursive: true, force: true }),
  };
}
