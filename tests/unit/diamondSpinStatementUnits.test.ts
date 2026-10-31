import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { classifyChangedPaths } from '../../scripts/ci/classify-ci-changes.mjs';

const migration =
  'supabase/migrations/20261026220723_diamond_spin_statements_label_collected_diamonds_and_actual_.sql';
const runner = readFileSync('scripts/dev/test-accounting-delivery.sh', 'utf8');
const sql = readFileSync(migration, 'utf8');

describe('Diamond Spins statement units', () => {
  it('keeps actual funded payouts separate from diamond settlement arithmetic', () => {
    expect(sql).toContain('FROM public.chip_ledger l');
    expect(sql).toContain("l.status='posted' AND l.to_type='player_wallet'");
    expect(sql).toContain('public.fn_diamond_spin_ledger_category(l.category)');
    expect(sql).toContain("'America/Chicago'");
    expect(sql).toContain('Chip Payouts: %s (Paid Separately)');
    expect(sql).toContain('Your Net %s: %s Diamonds.');
    expect(sql).toContain('v_credit:=v_net-v_burn;');
    expect(sql.match(/public.add_diamonds_to_balance\(/g)).toHaveLength(1);
    expect(sql).not.toMatch(/UPDATE public\.(chip_ledger|diamond_transactions|ca_mint_ledger)/);
    expect(sql).not.toContain('Entries:');
  });
  it('runs the native connected and historical regressions in the existing accounting lane', () => {
    expect(runner).toContain(migration);
    for (const path of [
      'tests/sql/diamond-spin-statement-units.sql',
      'tests/sql/diamond-spin-statement-history.sql',
    ]) {
      expect(classifyChangedPaths([path])).toMatchObject({ server: true, tests: true });
      expect(readFileSync(path, 'utf8')).toContain('RAISE EXCEPTION');
      expect(runner).toContain(
        path.endsWith('units.sql') ? 'run_game_probe diamond-spin-statement-units' : path
      );
    }
    expect(classifyChangedPaths([migration])).toMatchObject({ server: true, tests: true });
  });
});
