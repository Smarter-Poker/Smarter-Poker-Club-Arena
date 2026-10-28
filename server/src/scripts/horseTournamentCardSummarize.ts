/** Original same-run artifact reader; never promotes or changes live options. */
import { readFile, readdir, mkdir, writeFile, unlink } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve, join } from 'node:path';
const args = new Map<string, string>();
for (const arg of process.argv.slice(2)) {
  const m = /^--(source-sha|card|input|output)=(.+)$/.exec(arg);
  if (!m || args.has(m[1])) throw Error('Unknown or duplicate argument');
  args.set(m[1], m[2]);
}
for (const key of ['source-sha', 'card', 'input', 'output'])
  if (!args.has(key)) throw Error('Missing ' + key);
const {
  assertTournamentFlagSource,
  tournamentFlagProvider,
  assembleTournamentFlag,
  verifyTournamentFlagArchive,
  FLAG_REPOSITORY,
} = await import('../benchmark/HorseTournamentFlagQualification.js');
const plan = JSON.parse(
  await readFile(new URL('../benchmark/HorseTournamentFlagPlan.json', import.meta.url), 'utf8')
);
assertTournamentFlagSource(plan, args.get('source-sha')!);
const provider = await tournamentFlagProvider(args.get('card')!);
if (!provider.artifacts) throw Error('Original artifact inventory missing');
const input = resolve(args.get('input')!),
  output = resolve(args.get('output')!);
const dirs = await readdir(input, { withFileTypes: true });
if (dirs.length !== 48 || dirs.some((d) => !d.isDirectory() || d.isSymbolicLink()))
  throw Error('Missing or foreign original artifact directories');
const results = [];
for (const dir of dirs) {
  if (!dir.name.startsWith('tfc-' + args.get('card') + '-') || !dir.name.endsWith('-a1'))
    throw Error('Wrong original artifact name');
  const files = await readdir(join(input, dir.name));
  if (!files.includes('manifest.json') || !files.includes('result.json'))
    throw Error('Incomplete original shard artifact');
  const artifact = provider.artifacts.find((a: any) => a.name === dir.name);
  if (!artifact || !Number.isSafeInteger(artifact.id)) throw Error('Original artifact id missing');
  const response = await fetch(
    `https://api.github.com/repos/${FLAG_REPOSITORY}/actions/artifacts/${artifact.id}/zip`,
    {
      headers: {
        Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
      },
      signal: AbortSignal.timeout(60000),
    }
  );
  if (!response.ok || !response.body) throw Error('Original archive unavailable');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of response.body as any) {
    size += chunk.length;
    if (size > 16 * 1024 * 1024) throw Error('Original archive exceeds finite card bound');
    chunks.push(Buffer.from(chunk));
  }
  const archive = Buffer.concat(chunks);
  verifyTournamentFlagArchive(archive, artifact.digest);
  const archivePath = join(input, dir.name + '.zip');
  await writeFile(archivePath, archive, { flag: 'wx' });
  try {
    const entries = execFileSync('unzip', ['-Z1', archivePath], {
      encoding: 'utf8',
      maxBuffer: 4096,
    })
      .trim()
      .split('\n')
      .sort();
    if (entries.join(',') !== 'manifest.json,result.json')
      throw Error('Unexpected archive members');
    for (const member of entries) {
      const original = execFileSync('unzip', ['-p', archivePath, member], {
        maxBuffer: 16 * 1024 * 1024,
      });
      if (!original.equals(await readFile(join(input, dir.name, member))))
        throw Error('Downloaded result differs from authenticated archive');
    }
  } finally {
    await unlink(archivePath);
  }
  const envelope = JSON.parse(await readFile(join(input, dir.name, 'result.json'), 'utf8'));
  const manifest = JSON.parse(await readFile(join(input, dir.name, 'manifest.json'), 'utf8'));
  for (const [key, value] of Object.entries(manifest))
    if (JSON.stringify(value) !== JSON.stringify(envelope[key]))
      throw Error('Original manifest/result disagree');
  if (dir.name !== `tfc-${envelope.cell.key}-a1`)
    throw Error('Artifact/cell identity disagreement');
  results.push(envelope);
}
const verdict = assembleTournamentFlag(plan, args.get('source-sha')!, args.get('card')!, results, {
  run: provider.run,
  jobs: provider.jobs,
  artifacts: provider.artifacts,
});
await mkdir(output, { recursive: false });
await writeFile(
  join(output, 'provider.json'),
  JSON.stringify(
    { run: provider.run, jobs: provider.jobs, artifacts: provider.artifacts },
    null,
    2
  ) + '\n',
  { flag: 'wx' }
);
await writeFile(join(output, 'verdict.json'), JSON.stringify(verdict, null, 2) + '\n', {
  flag: 'wx',
});
console.log(JSON.stringify(verdict));
process.exit(verdict.measured ? 0 : 1);
