// tests/unit/horseQualificationPipeline.test.ts
import { describe, expect, it } from 'vitest';
import {
  SUPPORTED_PHASES,
  PHASE_VARIANTS,
  getPhaseConfig,
  buildAssemblerArgs,
  validateQualificationResult,
  verifyPolicyDigestMatch,
  summarizeRunJobs,
  downloadRunArtifacts,
  retryFailedShards,
  pollRunCompletion,
  executeQualificationPipeline,
} from '../../scripts/ops/horse-qualification-pipeline.mjs';

describe('Horse Qualification Pipeline Orchestrator', () => {
  describe('Phase and Variant Configuration', () => {
    it('supports Phase 10, 11, 12, and 13', () => {
      expect(SUPPORTED_PHASES).toEqual([10, 11, 12, 13]);
    });

    it('rejects unsupported phases', () => {
      expect(() => getPhaseConfig(9)).toThrow(/Unsupported phase 9/);
      expect(() => getPhaseConfig(14)).toThrow(/Unsupported phase 14/);
    });

    it('resolves Phase 10 configuration', () => {
      const cfg = getPhaseConfig(10, 'plo4');
      expect(cfg.phase).toBe(10);
      expect(cfg.variant).toBe('plo4');
      expect(cfg.script).toBe('scripts/phase10-strength-assemble.mjs');
      expect(cfg.needsVariantFlag).toBe(false);
    });

    it('resolves Phase 11 Omaha variants', () => {
      for (const v of ['plo5', 'plo6', 'plo8']) {
        const cfg = getPhaseConfig(11, v);
        expect(cfg.phase).toBe(11);
        expect(cfg.variant).toBe(v);
        expect(cfg.script).toBe('scripts/phase11-strength-assemble.mjs');
        expect(cfg.needsVariantFlag).toBe(true);
      }
      expect(() => getPhaseConfig(11, 'nlh')).toThrow(/Invalid variant "nlh" for Phase 11/);
    });

    it('resolves Phase 12 Fixed & Specialty variants', () => {
      for (const v of ['flh', 'flo8', 'pineapple', 'short_deck']) {
        const cfg = getPhaseConfig(12, v);
        expect(cfg.phase).toBe(12);
        expect(cfg.variant).toBe(v);
        expect(cfg.script).toBe('scripts/phase12-strength-assemble.mjs');
        expect(cfg.needsVariantFlag).toBe(true);
      }
    });

    it('resolves Phase 13 joint league variants', () => {
      for (const v of PHASE_VARIANTS[13]) {
        const cfg = getPhaseConfig(13, v);
        expect(cfg.phase).toBe(13);
        expect(cfg.variant).toBe(v);
        expect(cfg.script).toBe('scripts/phase13-strength-assemble.mjs');
        expect(cfg.needsVariantFlag).toBe(true);
      }
    });
  });

  describe('Assembler Argument Builder', () => {
    it('constructs Phase 10 assembler arguments without variant flag', () => {
      const { command, args } = buildAssemblerArgs({
        phase: 10,
        variant: 'plo4',
        runsDir: 'fixtures/runs10',
        outDir: 'fixtures/out10',
        noFormat: true,
      });
      expect(command).toBe('node');
      expect(args).toEqual([
        '--import',
        'tsx',
        'scripts/phase10-strength-assemble.mjs',
        '--runs=fixtures/runs10',
        '--out=fixtures/out10',
        '--no-format',
      ]);
    });

    it('constructs Phase 11 assembler arguments with variant flag', () => {
      const { command, args } = buildAssemblerArgs({
        phase: 11,
        variant: 'plo6',
        runsDir: 'fixtures/runs11',
        outDir: 'fixtures/out11',
        noFormat: true,
      });
      expect(command).toBe('node');
      expect(args).toEqual([
        '--import',
        'tsx',
        'scripts/phase11-strength-assemble.mjs',
        '--runs=fixtures/runs11',
        '--out=fixtures/out11',
        '--variant=plo6',
        '--no-format',
      ]);
    });

    it('supports defective file parameter when provided', () => {
      const { args } = buildAssemblerArgs({
        phase: 12,
        variant: 'flh',
        runsDir: 'fixtures/runs12',
        outDir: 'fixtures/out12',
        noFormat: true,
        defectiveFile: 'fixtures/defective.json',
      });
      expect(args).toContain('--defective=fixtures/defective.json');
    });

    it('requires runsDir and outDir', () => {
      expect(() => buildAssemblerArgs({ phase: 11, variant: 'plo5' })).toThrow(
        /runsDir is required/
      );
      expect(() =>
        buildAssemblerArgs({ phase: 11, variant: 'plo5', runsDir: 'fixtures/mock-runs' })
      ).toThrow(/outDir is required/);
    });
  });

  describe('Qualification Result Validation', () => {
    it('accepts valid qualification output', () => {
      const valid = JSON.stringify({
        refused: false,
        qualified: true,
        reasons: [],
        variant: 'plo6',
        strength: 'docs/evidence/phase11/strength-2026-10-17-plo6/strength.json',
        qualification: 'docs/evidence/phase11/phase11-qualification-2026-10-17-plo6.json',
        evidenceSha256: 'abc123def456',
      });
      const res = validateQualificationResult(valid);
      expect(res.qualified).toBe(true);
      expect(res.refused).toBe(false);
      expect(res.evidenceSha256).toBe('abc123def456');
    });

    it('rejects refused output with reasons', () => {
      const refused = JSON.stringify({
        refused: true,
        reasons: ['dirty_checkout', 'policy_source_changed'],
      });
      expect(() => validateQualificationResult(refused)).toThrow(/Assembler execution refused/);
    });

    it('rejects unqualified output', () => {
      const failed = JSON.stringify({
        refused: false,
        qualified: false,
        reasons: ['missing_shards'],
      });
      expect(() => validateQualificationResult(failed)).toThrow(/Qualification verdict FAILED/);
    });

    it('rejects non-empty reasons even if qualified flag is true', () => {
      const tainted = JSON.stringify({
        refused: false,
        qualified: true,
        reasons: ['unexpected_shard'],
      });
      expect(() => validateQualificationResult(tainted)).toThrow(
        /Disqualifying reasons encountered/
      );
    });
  });

  describe('Policy Digest Verification', () => {
    it('passes when digests match', () => {
      const match = verifyPolicyDigestMatch({
        qualificationDigest: '670b01e51c19493170258905a5f786994b9fdd342a3de3ba74f603a10714d44d',
        expectedEngineDigest: '670b01e51c19493170258905a5f786994b9fdd342a3de3ba74f603a10714d44d',
        variant: 'plo6',
        phase: 11,
      });
      expect(match).toBe(true);
    });

    it('fails when digests diverge', () => {
      expect(() =>
        verifyPolicyDigestMatch({
          qualificationDigest: '1111111111111111111111111111111111111111111111111111111111111111',
          expectedEngineDigest: '2222222222222222222222222222222222222222222222222222222222222222',
          variant: 'plo6',
          phase: 11,
        })
      ).toThrow(/Policy digest mismatch/);
    });
  });

  describe('Job Progress Summarization', () => {
    it('correctly tallies job states', () => {
      const jobs = [
        { status: 'completed', conclusion: 'success' },
        { status: 'completed', conclusion: 'success' },
        { status: 'completed', conclusion: 'failure' },
        { status: 'in_progress', conclusion: null },
        { status: 'queued', conclusion: null },
      ];
      const summary = summarizeRunJobs(jobs);
      expect(summary.total).toBe(5);
      expect(summary.completed).toBe(3);
      expect(summary.failed).toBe(1);
      expect(summary.in_progress).toBe(1);
      expect(summary.queued).toBe(1);
      expect(summary.isAllDone).toBe(false);
      expect(summary.isGreen).toBe(false);
    });

    it('identifies 100% green completion', () => {
      const jobs = [
        { status: 'completed', conclusion: 'success' },
        { status: 'completed', conclusion: 'success' },
      ];
      const summary = summarizeRunJobs(jobs);
      expect(summary.isAllDone).toBe(true);
      expect(summary.isGreen).toBe(true);
    });
  });

  describe('Execution Primitives Validation', () => {
    it('validates required parameters for downloadRunArtifacts', () => {
      expect(() => downloadRunArtifacts({})).toThrow(/runId is required/);
      expect(() => downloadRunArtifacts({ runId: 12345 })).toThrow(/targetDir is required/);
    });

    it('rejects pipeline execution when runs directory is nonexistent', async () => {
      await expect(
        executeQualificationPipeline({
          phase: 11,
          variant: 'plo6',
          runsDir: 'fixtures/nonexistent/path/for/tests',
          outDir: 'fixtures/mock-out',
        })
      ).rejects.toThrow(/Runs directory not found/);
    });

    it('validates required parameters for retryFailedShards', () => {
      expect(() => retryFailedShards({})).toThrow(/runId is required/);
    });

    it('validates required parameters for pollRunCompletion', async () => {
      await expect(pollRunCompletion({})).rejects.toThrow(/runId is required/);
    });

    it('handles pollRunCompletion timeout gracefully', async () => {
      await expect(
        pollRunCompletion({
          runId: '12345',
          ghBin: 'non-existent-gh-bin-test',
          intervalMs: 10,
          maxWaitMs: 30,
        })
      ).rejects.toThrow(/timed out/);
    });
  });
});
