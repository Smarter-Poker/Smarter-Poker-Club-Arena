import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { validateWindowMigration } from '../scripts/ci/maintenance-window-migrations.mjs';

const read = (p: string) => readFileSync(p, 'utf8');
const folder = 'scripts/qualification/own-agent-v1';
const binding = JSON.parse(read(`${folder}/source-binding.json`));
const migration = read(
  'supabase/migrations/20261028184531_own_playing_agent_earnings_keep_typed_wallet_receipts.sql'
);

describe('own playing earnings source qualification stays connected', () => {
  it('binds every maintained owner file and exact original/postimage in the whole installer', () => {
    for (const [file, hash] of Object.entries(binding.source_sha256)) {
      expect(file).toMatch(/^supabase\/accounting\/own-agent-v1\/[^/]+\.sql$/);
      const source = read(file);
      expect(createHash('sha256').update(source).digest('hex')).toBe(hash);
      if (
        !['fn_prepare_accounting_week.sql', 'fn_calculate_cash_rakeback_periods.sql'].includes(
          file.split('/').at(-1)!
        )
      )
        expect(migration).toContain(source.trim().replace(/;$/, '') + ';');
    }
    expect(binding.preimages).toHaveLength(15);
    expect(binding.postimages).toHaveLength(24);
    for (const owner of [...binding.preimages, ...binding.postimages]) {
      expect(migration).toContain(owner.signature);
      expect(migration).toContain(owner.md5);
    }
    expect(migration).toContain('-- @install-window: daily-maintenance');
    expect(migration).not.toMatch(
      /REFERENCES\s+(?:public\.)?(?:clubs|tournaments|hand_history|tables)\b/i
    );
  });

  it('installs exact readable public owner deltas while preserving their original runtime locks', () => {
    const patches = JSON.parse(read(`${folder}/original-owner-deltas.json`));
    const originals = JSON.parse(read(`${folder}/original-owners.json`));
    expect(patches).toHaveLength(2);
    for (const patch of patches) {
      const original = originals.find(
        (p: { signature: string }) => p.signature === patch.signature
      );
      expect(patch.preimage).toBe(original.md5);
      let derived = original.definition.trimEnd().replace(/;$/, '') + '\n';
      for (const pair of patch.replacements) {
        expect(derived.split(pair.old)).toHaveLength(2);
        expect(pair.old + pair.new).not.toContain('pg_advisory_xact_lock');
        derived = derived.replace(pair.old, pair.new);
      }
      const name = patch.signature.split('(')[0].split('.').pop();
      expect(derived).toBe(
        read(`supabase/accounting/own-agent-v1/${name}.sql`).trimEnd().replace(/;$/, '') + '\n'
      );
      expect(migration).toContain(JSON.stringify(patch.replacements));
    }
    expect(validateWindowMigration('own-agent-v1.sql', migration)).toBe(true);
  });

  it('composes every original financial phase guard without retagging the inventory', () => {
    const patches = JSON.parse(read(`${folder}/pause-owner-patches.json`));
    for (const patch of patches) {
      const name = patch.signature.split('(')[0].split('.').pop();
      const source = read(`supabase/accounting/own-agent-v1/${name}.sql`);
      expect(
        binding.preimages.find(
          (p: { signature: string }) =>
            p.signature.replace(/^public\./, '') === patch.signature.replace(/^public\./, '')
        )?.md5
      ).toBe(patch.postimage);
      for (const pair of patch.replacements) expect(source.split(pair.new)).toHaveLength(2);
    }
    expect(migration).toContain("version='20261028162126'");
    expect(migration).toContain('original-inventory-245-v1:72b51e4349fc9cd371bfb7f771b7ae20');
    expect(migration).not.toContain(
      'CREATE OR REPLACE FUNCTION smarter_private.original_inventory'
    );
  });

  it('bounds IDs before historical review and retains unchanged progress in original R0', () => {
    const source = read('supabase/accounting/own-agent-v1/unpaid-interpretation.sql');
    const selection = source.split('FOR item IN ')[1].split(' LOOP')[0];
    expect(selection).toContain('LIMIT p_limit');
    expect(selection).not.toContain('own_agent_interpreted_contract(');
    expect(selection).toContain('accounting_own_agent_source_reviews');
    expect(source).toContain("CASE WHEN did_admit THEN'admitted'ELSE'unchanged'END");
    expect(source).toContain('own_agent_source_review_immutable');
    expect(source).toContain('own_agent_source_review_no_truncate');
    expect(read('scripts/ci/test-own-agent-financial-postgres.py')).toContain(
      'maximum_historical_calls_per_request'
    );
  });

  it('continues only the explicit reviewed-progress result under the original caller budget', () => {
    const phase = JSON.parse(read(`${folder}/phase-preparation-owner.json`));
    expect(
      binding.preimages.find((p: { signature: string }) => p.signature === phase.signature)?.md5
    ).toBe(phase.md5);
    const caller = read('supabase/accounting/own-agent-v1/weekly_payout_prepare_due.sql');
    expect(caller).toContain("LEAST(began+interval '30 seconds'");
    expect(caller).toContain("'own_agent_source_interpretation_in_progress'");
    expect(caller).toContain("'{problems,0,source_check,reviewed}'");
    expect(caller).toContain("'{problems,0,source_check,budget_exhausted}'");
    expect(caller).toContain("coalesce(saved_preparation_deadline,'')");
    expect(read('scripts/ci/test-own-agent-financial-postgres.py')).toContain(
      'actual-original-precompute-consumes-over256'
    );
  });

  it('executes the whole native installer and real documents from the required accounting path', () => {
    const parent = read('scripts/ci/test_launch_reset_floor.py');
    for (const name of [
      'test-own-agent-rakeback-postgres.py',
      'test-own-agent-financial-postgres.py',
    ])
      expect(parent).toContain(name);
    expect(read('.github/workflows/ci.yml')).toContain(
      'python3 -B scripts/ci/test_launch_reset_floor.py'
    );
    const native = read('scripts/ci/test-own-agent-financial-postgres.py');
    expect(native).toContain(
      '20261028184531_own_playing_agent_earnings_keep_typed_wallet_receipts.sql'
    );
    expect(native).toContain('document_module.install(');
    expect(native).not.toContain("load(DR/'receipt-boundary.sql')");
    expect(native).toContain('whole-installer-rollback-');
    expect(native).toContain('history_only_no_messenger');
    expect(native).toContain('input_sha256');
    expect(read(`${folder}/README.md`)).toContain('controlled isolation boundaries');
  });
});
