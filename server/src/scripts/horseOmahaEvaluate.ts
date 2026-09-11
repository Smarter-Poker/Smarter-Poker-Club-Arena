import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  defaultOmahaEvidence,
  runOmahaEvidence,
  type OmahaEvidenceInput,
} from '../benchmark/OmahaEvidence.js';
import { OMAHA_EQUITY_LIMITS } from '../benchmark/OmahaEquityOracle.js';

const sourceRoot = fileURLToPath(new URL('../../../', import.meta.url));
const sourceFiles = [
  'src/benchmark/OmahaReference.ts',
  'src/benchmark/OmahaEquityOracle.ts',
  'src/benchmark/OmahaEvidence.ts',
  'src/scripts/horseOmahaEvaluate.ts',
  'src/engine/HandController.ts',
  'src/engine/omaha/OmahaCardFacts.ts',
  'package.json',
  'package-lock.json',
].map((f) => `server/${f}`);
const hash = (content: string | Buffer) => createHash('sha256').update(content).digest('hex');
const git = (...args: string[]) =>
  execFileSync('git', args, { cwd: sourceRoot, encoding: 'utf8' }).trim();
async function fingerprint() {
  return Object.fromEntries(
    await Promise.all(
      sourceFiles.map(async (file) => [file, hash(await readFile(resolve(sourceRoot, file)))])
    )
  );
}
async function main() {
  const options = new Map<string, string>();
  for (const arg of process.argv.slice(2)) {
    const match = /^--(input|output)=(.+)$/.exec(arg);
    if (!match || options.has(match[1]))
      throw new Error(
        'Usage: horse:omaha-evaluate -- --output=NEW_DIRECTORY [--input=SCENARIOS_JSON]'
      );
    options.set(match[1], match[2]);
  }
  if (!options.has('output')) throw new Error('A new --output directory is required');
  let input: OmahaEvidenceInput;
  if (options.has('input')) {
    const path = resolve(options.get('input')!);
    if ((await stat(path)).size > 1_048_576) throw new Error('Input exceeds one megabyte');
    const data = await readFile(path);
    if (data.length > 1_048_576) throw new Error('Input exceeds one megabyte');
    input = JSON.parse(data.toString('utf8')) as OmahaEvidenceInput;
  } else input = defaultOmahaEvidence();
  const output = resolve(options.get('output')!);
  await mkdir(dirname(output), { recursive: true });
  await mkdir(output); // Never overwrite or mix a previous evidence run.
  let continuing = true;
  const stop = () => {
    continuing = false;
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  try {
    const sourceHashes = await fingerprint();
    const head = git('rev-parse', 'HEAD');
    const sourceStatus = git('status', '--porcelain', '--', ...sourceFiles);
    const startedAt = new Date().toISOString();
    const evidence = await runOmahaEvidence(input, () => continuing);
    if (
      JSON.stringify(sourceHashes) !== JSON.stringify(await fingerprint()) ||
      head !== git('rev-parse', 'HEAD')
    )
      throw new Error('Source changed during evaluation; rerun against a stable checkout');
    const report = {
      ...evidence,
      startedAt,
      finishedAt: new Date().toISOString(),
      provenance: {
        head,
        sourceStatus,
        sourceHashes,
        inputSha256: hash(JSON.stringify(input)),
        nodeVersion: process.version,
      },
      limits: OMAHA_EQUITY_LIMITS,
    };
    await writeFile(resolve(output, 'scenarios.json'), JSON.stringify(input, null, 2) + '\n', {
      flag: 'wx',
    });
    await writeFile(resolve(output, 'evidence.json'), JSON.stringify(report, null, 2) + '\n', {
      flag: 'wx',
    });
    console.log(
      JSON.stringify({
        complete: report.complete,
        scenarios: report.completedScenarios,
        maxConservationError: report.maxConservationError,
        output,
      })
    );
    if (!report.complete) process.exitCode = continuing ? 1 : 130;
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
}
main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Omaha evidence failed');
  process.exitCode = 1;
});
