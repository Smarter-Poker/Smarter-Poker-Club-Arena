import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '../..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');
const catalog = JSON.parse(read('docs/lightning/release-gates.json'));
const rollout = read('docs/lightning/ROLLOUT.md');
const review = read('docs/lightning/FINAL-RELEASE-REVIEW.md');
const stage1 = rollout.split('## Stage 1:')[1].split('## Stage 2:')[0];
const stage2 = rollout.split('## Stage 2:')[1].split('## Stage 3:')[0];

describe('the original Lightning final gate survives the release review', () => {
  it('retains all 54 exact requirements in their original order', () => {
    expect(catalog.schemaVersion).toBe(1);
    expect(catalog.programmePhase).toBe(14);
    expect(catalog.specificationPhases).toEqual([23, 24]);
    expect(catalog.requirements.map((g: { id: string }) => g.id)).toEqual(
      Array.from({ length: 54 }, (_, i) => `L${String(i + 1).padStart(2, '0')}`)
    );
    const titles = catalog.requirements.map((g: { requirement: string }) => g.requirement);
    expect(createHash('sha256').update(titles.join('\n')).digest('hex')).toBe(
      'd7b3c1586aa87c44d41685d47f41d03ddb1e812e370777d5d79f94098c3c8205'
    );
  });

  it('maps every requirement to existing maintained qualification, without file existence claiming a pass', () => {
    expect(catalog.purpose).toContain('File existence is not execution evidence');
    for (const gate of catalog.requirements) {
      expect(gate.qualificationFiles.length, gate.id).toBeGreaterThan(0);
      for (const path of gate.qualificationFiles)
        expect(existsSync(resolve(root, path)), path).toBe(true);
      expect(review).toContain(`| ${gate.id} | ${gate.requirement} |`);
    }
    expect(review).toContain('Current public-launch verdict: NO_GO');
    expect(review).toContain('not silently promoted from a source assertion');
  });
});

describe('a shadow-only stage cannot manufacture hand evidence', () => {
  it('matches the actual no-hands worker and empty-ledger behavior', () => {
    const sql = read(
      'supabase/migrations/20261009235505_lightning_phase_13_rollout_drain_and_rollback.sql'
    );
    const ledger = read('server/src/lightning/LightningLatencyLedger.ts');
    expect(sql).toContain('worker_mode shadow plans and compares and forms no hands');
    expect(sql).toContain("'NO_LATENCY_EVIDENCE', 'severity', 'evidence'");
    expect(ledger).toContain('if (Object.keys(legs).length === 0) return;');
    expect(stage1).toContain('NO_LATENCY_EVIDENCE');
    expect(stage1).toContain('zero samples are missing evidence, never a passing p95');
    expect(stage1).not.toContain("Latency windows recorded for the Cluster with every leg's p95");
  });

  it('requires a viable comparison window within the unchanged stage budget', () => {
    expect(stage1).toContain('at most 60 minutes');
    expect(stage1).toContain('at least 30 nonempty comparisons');
    expect(stage1).toContain('300000ms windows cannot');
    expect(stage1).toContain('never extend the time box or fabricate comparisons');
    expect(stage1).toContain('verdict `calibrated`');
  });

  it('requires actual nonempty hand measurements in form mode, preserving the pilot and club periods', () => {
    expect(stage2).toContain('every configured leg with nonzero samples');
    expect(stage2).toContain('absent leg is missing evidence');
    expect(stage2).toContain('At least 7 days and 5,000 Lightning hands');
    expect(rollout).toContain('at least 14 days across at least five clubs and both table sizes');
    expect(review).toContain(
      'No synthetic hands, backdated timestamps or manufactured ledger rows'
    );
  });

  it('gives a real read-only proof route and preserves the separate readiness proof boundary', () => {
    expect(rollout).not.toContain('bin/proofs.sh');
    expect(rollout).toContain('configured read-only database tool');
    expect(rollout).toContain('proofs_evaluated_in_sql');
    expect(rollout).toContain('Separate exact installed-migration proof readback is required');
    expect(rollout).toContain('An unavailable, cancelled, skipped or stale result is not PASS');
  });
});
