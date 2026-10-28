import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import {
  runTournamentLeague,
  tournamentRunCanPromote,
  TOURNAMENT_PROMOTION_SEEDS,
} from './HorseTournamentLeague.js';
import {
  HorseLeagueComputeWorkerClient,
  horseLeagueComputeResponseIsValid,
} from './HorseLeagueComputeWorkerClient.js';
import {
  TOURNAMENT_FLAG_DESIGN,
  TOURNAMENT_FLAG_CARDS,
  TOURNAMENT_FLAG_HOLDOUT_SEEDS,
  tournamentFlagCells,
  tournamentFlagHash,
  validateTournamentFlagRequest,
} from './HorseTournamentFlagContract.js';
import {
  assembleTournamentFlag,
  verifyTournamentFlagArchive,
  assertTournamentFlagPlan,
  FLAG_WORKFLOW,
  FLAG_REPOSITORY,
  type FlagEnvelope,
  type TournamentFlagPlan,
} from './HorseTournamentFlagQualification.js';
import { gtoChartCount } from '../engine/GtoCharts.js';
import { gtoPostflopCount } from '../engine/GtoPostflop.js';
import { gtoPostflopV31Count, gtoPostflopV31Dataset } from '../engine/GtoPostflopV31.js';

const DEV_SEED = 9019131;
describe('PLO tournament flag qualification custody', () => {
  it('separates the six original payout cards and new reserved seeds from Phase8 and development', () => {
    expect(TOURNAMENT_FLAG_CARDS).toHaveLength(6);
    expect(
      JSON.parse(readFileSync('src/benchmark/HorseTournamentFlagPlan.json', 'utf8')).designDigest
    ).toBe(tournamentFlagHash(TOURNAMENT_FLAG_DESIGN));
    for (const card of TOURNAMENT_FLAG_CARDS) {
      expect(card.a).toEqual({ v53PloTourneyIcm: true });
      expect(card.b).toEqual({});
      expect(tournamentFlagCells(card.name)).toHaveLength(48);
    }
    for (const seed of TOURNAMENT_FLAG_HOLDOUT_SEEDS) {
      expect(TOURNAMENT_PROMOTION_SEEDS).not.toContain(seed);
      expect(() =>
        validateTournamentFlagRequest({
          objective: 'sng',
          flagCard: 'plo4_v53_icm_sng',
          seed,
          pairs: 1,
        })
      ).toThrow('Reserved');
    }
    expect(() =>
      assertTournamentFlagPlan({
        ...JSON.parse(readFileSync('src/benchmark/HorseTournamentFlagPlan.json', 'utf8')),
        state: 'awaiting_protected_source_lock',
      })
    ).toThrow('not protected-source locked');
  });
  it('refuses reserved seeds through generic and forged-admission execution before any deal', async () => {
    for (const seed of TOURNAMENT_FLAG_HOLDOUT_SEEDS) {
      await expect(
        runTournamentLeague({ objective: 'sng', seed, pairs: 1 }, () => false)
      ).rejects.toThrow('Reserved');
      await expect(
        runTournamentLeague(
          {
            objective: 'sng',
            seed,
            pairs: 64,
            firstPair: 0,
            flagCard: 'plo4_v53_icm_sng',
            opponentPopulation: TOURNAMENT_FLAG_DESIGN.field,
            flagQualification: {
              sourceSha: 'a'.repeat(40),
              planDigest: 'b'.repeat(64),
              providerRunId: 1,
              providerJobId: 1,
              runAttempt: 1,
            },
          },
          () => false
        )
      ).rejects.toThrow();
    }
  });
  it('binds accepted artifact bytes to the provider archive digest', () => {
    const original = Buffer.from('original-archive');
    const digest = 'sha256:' + createHash('sha256').update(original).digest('hex');
    expect(() => verifyTournamentFlagArchive(original, digest)).not.toThrow();
    expect(() =>
      verifyTournamentFlagArchive(Buffer.from('coherently-forged-local-results'), digest)
    ).toThrow('digest mismatch');
    expect(() => verifyTournamentFlagArchive(original, 'sha256:' + '0'.repeat(64))).toThrow(
      'digest mismatch'
    );
  });
  it('refuses unsupported domain, arbitrary offsets and qualification relabeling without dealing', () => {
    const r = { objective: 'sng' as const, flagCard: 'plo4_v53_icm_sng', seed: DEV_SEED, pairs: 1 };
    for (const bad of [
      { ...r, flagCard: 'plo8_v53_icm_sng' },
      { ...r, objective: 'mtt' as const },
      { ...r, firstPair: -1 },
      { ...r, firstPair: 1024 },
      { ...r, phase8PolicyFamily: 'catastrophe_guard_v1' as const },
      { ...r, evidenceMode: 'promotion' as const },
      { ...r, flagQualification: {} as never },
    ])
      expect(() => validateTournamentFlagRequest(bad)).toThrow();
  });
  it('assembles only original same-source, same-field, same-provider unique partitions from raw pairs', async () => {
    const card = 'plo4_v53_icm_sng',
      sourceSha = 'a'.repeat(40);
    const plan: TournamentFlagPlan = {
      schema: 'horse-tournament-flag-plan-v1',
      state: 'heldout_locked',
      designDigest: tournamentFlagHash(TOURNAMENT_FLAG_DESIGN),
      runtimeSourceDigest: 'b'.repeat(64),
      dependencyDigest: 'c'.repeat(64),
      workflowDigest: 'd'.repeat(64),
      baselineReferenceRevision: 'e'.repeat(40),
    };
    const empty = await runTournamentLeague(
      {
        objective: 'sng',
        flagCard: card,
        seed: DEV_SEED,
        pairs: 64,
        opponentPopulation: TOURNAMENT_FLAG_DESIGN.field,
      },
      () => false
    );
    const cells = tournamentFlagCells(card);
    const provider = {
      run: {
        id: 41,
        head_sha: 'f'.repeat(40),
        event: 'workflow_dispatch',
        head_branch: 'main',
        path: FLAG_WORKFLOW,
        run_attempt: 1,
      },
      jobs: cells.map((c, i) => ({
        id: i + 1,
        name: 'Card ' + c.key,
        status: 'completed',
        conclusion: 'success',
      })),
      artifacts: cells.map((c) => ({
        name: `tfc-${c.key}-a1`,
        expired: false,
        digest: 'sha256:' + 'a'.repeat(64),
        workflow_run: { id: 41, head_sha: 'f'.repeat(40) },
      })),
    };
    const envelopes: FlagEnvelope[] = cells.map((cell, i) => {
      const result = {
        ...structuredClone(empty),
        seed: cell.seed,
        firstPair: cell.firstPair,
        pairs: 64,
        complete: true,
        cardDecisions: 64,
        decisions: 128,
        cardChanged: 64,
        cardPairs: Array.from({ length: 64 }, (_, j) => ({
          index: cell.firstPair + j,
          candidate: 0.65,
          reference: 0.35,
        })),
        candidateReturn: 0.65,
        baselineReturn: 0.35,
        meanDifference: 0.3,
        standardError: 0,
        confidence99: [-1, 1] as [number, number],
        candidateFinish: [64, 0, 0, 0, 0, 0],
        baselineFinish: [0, 64, 0, 0, 0, 0],
      };
      expect(
        horseLeagueComputeResponseIsValid({ type: 'TOURNAMENT_RESULT', jobId: 1, result })
      ).toBe(true);
      return {
        schema: 'horse-tournament-flag-result-v1',
        sourceSha,
        sourceDigest: plan.runtimeSourceDigest!,
        dependencyDigest: plan.dependencyDigest!,
        workflowDigest: plan.workflowDigest!,
        planDigest: tournamentFlagHash(plan),
        designDigest: plan.designDigest,
        field: TOURNAMENT_FLAG_DESIGN.field,
        card,
        cell,
        reporter: {
          repository: FLAG_REPOSITORY,
          workflow: FLAG_WORKFLOW,
          runId: 41,
          runAttempt: 1,
          jobId: i + 1,
          workflowControlSha: provider.run.head_sha,
        },
        result,
        resultDigest: tournamentFlagHash(result),
        originalExitCode: 0,
      };
    });
    expect(assembleTournamentFlag(plan, sourceSha, card, envelopes, provider)).toMatchObject({
      measured: true,
      wins: true,
      activation: false,
    });
    for (const mutate of [
      (x: FlagEnvelope[]) => x.pop(),
      (x: FlagEnvelope[]) => x.push(x[0]),
      (x: FlagEnvelope[]) => (x[0].sourceSha = '0'.repeat(40)),
      (x: FlagEnvelope[]) => (x[0].field = 'horse'),
      (x: FlagEnvelope[]) => (x[0].reporter.jobId = 2),
      (x: FlagEnvelope[]) => (x[0].reporter.runAttempt = 2),
      (x: FlagEnvelope[]) => x[0].result.cardPairs![0].index++,
      (x: FlagEnvelope[]) => (x[0].result.meanDifference = 0.9),
      (x: FlagEnvelope[]) => (x[0].originalExitCode = 1),
    ]) {
      const x = structuredClone(envelopes);
      mutate(x);
      expect(assembleTournamentFlag(plan, sourceSha, card, x, provider).wins).toBe(false);
    }
    const nonpositiveSeed = structuredClone(envelopes);
    for (const e of nonpositiveSeed.filter(
      (e) => e.cell.seed === TOURNAMENT_FLAG_HOLDOUT_SEEDS[0]
    )) {
      e.result.cardPairs = e.result.cardPairs!.map((p) => ({
        ...p,
        candidate: 0.35,
        reference: 0.65,
      }));
      e.result.candidateReturn = 0.35;
      e.result.baselineReturn = 0.65;
      e.result.meanDifference = -0.3;
      e.resultDigest = tournamentFlagHash(e.result);
    }
    expect(assembleTournamentFlag(plan, sourceSha, card, nonpositiveSeed, provider)).toMatchObject({
      measured: true,
      wins: false,
      reasons: ['nonpositive_seed'],
    });
    const badProvider = structuredClone(provider);
    badProvider.artifacts[0].expired = true;
    expect(assembleTournamentFlag(plan, sourceSha, card, envelopes, badProvider).wins).toBe(false);
  });
});

describe('real PLO whole tournament development path', { timeout: 180000 }, () => {
  it.each(['plo4', 'plo5', 'plo6'] as const)(
    '%s completes a legal development pair with the declared payout field',
    async (variant) => {
      const result = await runTournamentLeague({
        objective: 'sng',
        flagCard: `${variant}_v53_icm_sng`,
        seed: DEV_SEED,
        pairs: 1,
        opponentPopulation: TOURNAMENT_FLAG_DESIGN.field,
      });
      expect(result.complete).toBe(true);
      expect(result.illegalActions).toBe(0);
      expect(result.conservationErrors).toBe(0);
      expect(result.truncatedHands).toBe(0);
      expect(result.cardDecisions).toBeGreaterThan(0);
      expect(result.cardPairs).toHaveLength(1);
      expect(result.promotionEligible).toBe(false);
      expect(tournamentRunCanPromote({ ...result, evidenceMode: 'promotion' })).toBe(false);
      expect(
        horseLeagueComputeResponseIsValid({ type: 'TOURNAMENT_RESULT', jobId: 1, result })
      ).toBe(true);
    }
  );
  it('completes the original eighteen-entrant MTT field without deck overlap or lost chips', async () => {
    const result = await runTournamentLeague({
      objective: 'mtt',
      flagCard: 'plo6_v53_icm_mtt',
      seed: DEV_SEED,
      pairs: 1,
      opponentPopulation: TOURNAMENT_FLAG_DESIGN.field,
    });
    expect(result.complete).toBe(true);
    expect(result.illegalActions).toBe(0);
    expect(result.conservationErrors).toBe(0);
    expect(result.truncatedHands).toBe(0);
    expect(result.cardPairs).toHaveLength(1);
    expect(result.promotionEligible).toBe(false);
    expect(horseLeagueComputeResponseIsValid({ type: 'TOURNAMENT_RESULT', jobId: 1, result })).toBe(
      true
    );
  });
  it.runIf(process.platform === 'linux')(
    'uses the actual isolated Linux compute child for one development pair',
    async () => {
      // Vitest transforms the parent only. The real child runs source TS and
      // needs the same explicit tsx registration as the module-worker fixture.
      const originalExecArgv = process.execArgv;
      const tsxApi = pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm/api')).href;
      const bootstrap = `import { register } from ${JSON.stringify(tsxApi)};register();`;
      process.execArgv = [
        ...originalExecArgv,
        '--import',
        `data:text/javascript,${encodeURIComponent(bootstrap)}`,
      ];
      const client = new HorseLeagueComputeWorkerClient({
        hydrateSolverStores: false,
        expectedSolverStores: {
          charts: gtoChartCount(),
          postflop: gtoPostflopCount(),
          postflopV31: gtoPostflopV31Count(),
          postflopV31Dataset: gtoPostflopV31Dataset(),
        },
      });
      try {
        await client.ready();
        const r = await client.runTournamentLeague({
          objective: 'sng',
          flagCard: 'plo4_v53_icm_sng',
          seed: DEV_SEED,
          pairs: 1,
          opponentPopulation: TOURNAMENT_FLAG_DESIGN.field,
        });
        expect(r.complete).toBe(true);
        expect(r.cardPairs).toHaveLength(1);
      } finally {
        try {
          await client.shutdown();
        } finally {
          process.execArgv = originalExecArgv;
        }
      }
    }
  );
});
