import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const read = (p: string) => readFileSync(p, 'utf8');
const folder = 'scripts/qualification/own-agent-v1';
const binding = JSON.parse(read(`${folder}/source-binding.json`));
const migration = read(
  'supabase/migrations/20261028184531_own_playing_agent_earnings_keep_typed_wallet_receipts.sql'
);

describe('own playing earnings source qualification stays connected', () => {
  it('binds every maintained owner file and exact original/postimage in the whole installer', () => {
    for (const [file, hash] of Object.entries(binding.source_sha256)) {
      const source = read(`supabase/accounting/own-agent-v1/${file}`);
      expect(createHash('sha256').update(source).digest('hex')).toBe(hash);
      expect(migration).toContain(source.trim().replace(/;$/, '') + ';');
    }
    expect(binding.preimages).toHaveLength(14);
    expect(binding.postimages).toHaveLength(23);
    for (const owner of [...binding.preimages, ...binding.postimages]) {
      expect(migration).toContain(owner.signature);
      expect(migration).toContain(owner.md5);
    }
    expect(migration).toContain('-- @install-window: daily-maintenance');
    expect(migration).not.toMatch(
      /REFERENCES\s+(?:public\.)?(?:clubs|tournaments|hand_history|tables)\b/i
    );
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
