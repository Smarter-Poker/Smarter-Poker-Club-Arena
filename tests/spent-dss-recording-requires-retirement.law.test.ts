import { describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import {
  retiredDssRecordingIsBound,
  verifySpentDssRetirement,
  DSS_HISTORY_FILE,
  DSS_RETIREMENT_FILE,
  DSS_HISTORY_VERSION,
} from '../scripts/ci/spent-dss-recording.mjs';

const root = join(__dirname, '..');
describe('spent DSS recording requires retirement', () => {
  it('binds only exact historical bytes, manifest identity and mandatory retirement reader', () => {
    expect(retiredDssRecordingIsBound(root)).toBe(true);
    const scratch = mkdtempSync(
      join(
        process.env.RUNNER_TEMP ||
          process.env.TMPDIR ||
          (process.platform === 'darwin' ? '/Volumes/SmarterWork/agent-work' : tmpdir()),
        'dss-recording-'
      )
    );
    const files = [
      DSS_HISTORY_FILE,
      DSS_RETIREMENT_FILE,
      'scripts/ci/recorded-migrations.manifest.json',
      'scripts/ci/check-recorded-migrations-evidence.mjs',
      '.github/workflows/applied-migrations-recorded.yml',
    ];
    try {
      for (const file of files) {
        mkdirSync(dirname(join(scratch, file)), { recursive: true });
        writeFileSync(join(scratch, file), readFileSync(join(root, file)));
      }
      expect(retiredDssRecordingIsBound(scratch)).toBe(true);
      for (const file of [DSS_HISTORY_FILE, DSS_RETIREMENT_FILE]) {
        const original = readFileSync(join(scratch, file));
        writeFileSync(join(scratch, file), Buffer.concat([original, Buffer.from('\n')]));
        expect(retiredDssRecordingIsBound(scratch)).toBe(false);
        writeFileSync(join(scratch, file), original);
      }
      const readerPath = join(scratch, 'scripts/ci/check-recorded-migrations-evidence.mjs');
      const reader = readFileSync(readerPath, 'utf8');
      const missingCall = reader.replace(
        'await verifySpentDssRetirement',
        'await removedRetirementCall'
      );
      expect(missingCall).not.toBe(reader);
      expect(missingCall).toContain('verifySpentDssRetirement'); // Import remains.
      writeFileSync(readerPath, missingCall);
      expect(retiredDssRecordingIsBound(scratch)).toBe(false);
      writeFileSync(readerPath, reader);
      const workflowPath = join(scratch, '.github/workflows/applied-migrations-recorded.yml');
      const workflow = readFileSync(workflowPath, 'utf8');
      writeFileSync(
        workflowPath,
        workflow.replace(
          'node scripts/ci/check-recorded-migrations-evidence.mjs',
          'echo skipped-recording-proof'
        )
      );
      expect(readFileSync(workflowPath, 'utf8')).toContain('SUPABASE_DB_URL');
      expect(retiredDssRecordingIsBound(scratch)).toBe(false);
      writeFileSync(workflowPath, workflow);
      const manifestPath = join(scratch, 'scripts/ci/recorded-migrations.manifest.json');
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      manifest.recordings = manifest.recordings.filter(
        (r: { version: string }) => r.version !== DSS_HISTORY_VERSION
      );
      writeFileSync(manifestPath, JSON.stringify(manifest));
      expect(retiredDssRecordingIsBound(scratch)).toBe(false);
    } finally {
      rmSync(scratch, { recursive: true });
    }
  });
  it('requires a positive live proof and never folds refusal or unknown into success', async () => {
    expect(await verifySpentDssRetirement(async () => 't')).toBe(true);
    expect(await verifySpentDssRetirement(async () => 'f')).toBe(false);
    await expect(verifySpentDssRetirement(async () => '')).rejects.toThrow('unreadable');
    await expect(
      verifySpentDssRetirement(async () => {
        throw new Error('unavailable');
      })
    ).rejects.toThrow('unavailable');
  });
  it('the native qualifier exercises active, missing, altered and actual retired catalog evidence', () => {
    const runner = readFileSync(join(root, 'scripts/dev/test-spent-dss-retirement.py'), 'utf8');
    expect(runner).toContain('SPENT_DSS_RETIREMENT_PROOF');
    expect(runner).toContain("ARRAY['wrong']");
    expect(runner).toContain("sql(proof).stdout.strip() == 'f'");
    expect(runner).toContain("sql(proof).stdout.strip() == 't'");
  });
});
