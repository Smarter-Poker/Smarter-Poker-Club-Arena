import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
const dir = 'scripts/qualification/retained18-correction/';
const migration =
  'supabase/migrations/20261013022132_a_retained_original_hand_corrects_its_exact_refused_source_o.sql';
describe('A retained original hand corrects its exact refused source once', () => {
  it('binds the real maintained source and qualification inputs', () => {
    const binding = JSON.parse(readFileSync(dir + 'source-binding.json', 'utf8'));
    for (const [path, pin] of Object.entries(binding.files) as [
      string,
      { bytes: number; sha256: string },
    ][]) {
      const bytes = readFileSync(path);
      expect(bytes.length, path).toBe(pin.bytes);
      expect(createHash('sha256').update(bytes).digest('hex'), path).toBe(pin.sha256);
    }
  });
  it('retains the original financial dispatch and refuses arbitrary spent originals', () => {
    const original = readFileSync(dir + 'installed-resume-preimage.sql', 'utf8');
    const next = readFileSync(migration, 'utf8');
    const financialBlock = (text: string) =>
      text.slice(
        text.indexOf('INSERT INTO smarter_private.hand_submission_dispatch'),
        text.indexOf('DELETE FROM smarter_private.hand_submission_dispatch')
      );
    expect(original).toContain('INSERT INTO smarter_private.hand_submission_dispatch');
    expect(original).toContain('DELETE FROM smarter_private.hand_submission_dispatch');
    expect(next).toContain('INSERT INTO smarter_private.hand_submission_dispatch');
    expect(next).toContain('DELETE FROM smarter_private.hand_submission_dispatch');
    expect(financialBlock(next)).not.toHaveLength(0);
    expect(financialBlock(next)).toBe(financialBlock(original));
    expect(next).toContain("'successor_financial_claim_spent'");
    expect(next).toContain('HAND_SOURCE_CORRECTION_ADMISSION_CHANGED');
    expect(next).toContain('original_hand_correction_sources_match() IS DISTINCT FROM true');
    expect(next).toContain('IS TRUE)');
    expect(next).not.toMatch(
      /(?:DELETE FROM|UPDATE)\s+smarter_private\.hand_submission_handoff(?:s|_results)\b/i
    );
    expect(next).not.toMatch(
      /CREATE\s+(?:OR REPLACE\s+)?FUNCTION\s+public\.(?:.*(?:repair|backpay|redrive)|fn_ca_commit_hand_settlement)\b/i
    );
  });
  it('directly enforces public safe qualification and keeps original private fixtures explicit', () => {
    const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');
    expect(workflow).toContain(
      'bash scripts/dev/probe-retained-source-correction-pg17.sh --public-safe'
    );
    expect(workflow).toContain('steps.retained_source_correction.outcome');
    expect(workflow).toContain(
      'retained-source-correction-${{ github.run_id }}-${{ github.run_attempt }}'
    );
    const runner = readFileSync(dir + 'probe-native-bootstrap.py', 'utf8');
    expect(runner).toContain('--private-fixture-input');
    expect(runner).toContain('tested_migration');
    expect(runner).toContain('source_sha256');
    expect(runner).toContain('Private fixture changed during native qualification');
  });
});
