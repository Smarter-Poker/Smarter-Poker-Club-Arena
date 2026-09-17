import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

const exec = promisify(execFile);

it('writes bounded PLO4 diagnostics, refuses incomplete position coverage and preserves existing output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'phase10-cli-'));
  const output = join(root, 'evidence');
  const run = (...args: string[]) =>
    exec(process.execPath, ['--import', 'tsx', 'src/scripts/plo4PolicyEvaluate.ts', ...args], {
      timeout: 20_000,
      maxBuffer: 1_048_576,
    });
  try {
    // One pair really runs each profile/seed once, but cannot cover every
    // relative position. The CLI must save the diagnostic and exit incomplete.
    await expect(run(`--output=${output}`, '--pairs=1', '--samples=1')).rejects.toMatchObject({
      code: 1,
      killed: false,
      stdout: expect.stringContaining('"complete":false,"profileSeedRuns":18'),
    });
    const before = await readFile(join(output, 'phase10-evidence.json'), 'utf8');
    const evidence = JSON.parse(before);
    expect(evidence.complete).toBe(false);
    expect(evidence.leagues).toHaveLength(18);
    for (const league of evidence.leagues) {
      expect(league).toMatchObject({
        illegalActions: 0,
        conservationErrors: 0,
        cardErrors: 0,
        truncatedHands: 0,
      });
    }
    expect(evidence.pairsPerProfileSeed).toBe(1);
    expect(
      evidence.leagues.every(
        (league: {
          complete: boolean;
          completedPairs: number;
          relativePositions: number[];
          positionCoverageComplete: boolean;
        }) =>
          league.complete &&
          league.completedPairs === 1 &&
          league.relativePositions.length === 1 &&
          !league.positionCoverageComplete
      )
    ).toBe(true);
    expect(evidence.promotionEligible).toBe(false);
    expect(evidence.liveActivated).toBe(false);
    expect(evidence.oracleSamplesPerReferenceSpot).toBe(1);
    expect(
      evidence.referenceSpots.every(
        (spot: { request: { samples: number } }) => spot.request.samples === 1
      )
    ).toBe(true);
    await writeFile(join(output, 'sentinel'), 'preserve me');
    await expect(run(`--output=${output}`)).rejects.toMatchObject({ code: 1, killed: false });
    expect(await readFile(join(output, 'phase10-evidence.json'), 'utf8')).toBe(before);
    expect(await readFile(join(output, 'sentinel'), 'utf8')).toBe('preserve me');
    await expect(run(`--output=${join(root, 'invalid')}`, '--pairs=33')).rejects.toMatchObject({
      code: 1,
      killed: false,
    });
    await expect(
      run(`--output=${join(root, 'invalid-samples')}`, '--samples=129')
    ).rejects.toMatchObject({
      code: 1,
      killed: false,
      stderr: expect.stringContaining('bounded whole-number work budgets'),
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 65_000);
