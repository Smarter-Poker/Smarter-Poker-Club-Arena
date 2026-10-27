import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(resolve(__dirname, '../..', path), 'utf8');
const migration =
  'supabase/migrations/20261027010432_capacity_receipt_reads_admit_seated_tournament_tables.sql';

describe('capacity receipt read qualification', () => {
  it('keeps the native role/consumer fixture enforced in the existing accounting gate', () => {
    const workflow = read('.github/workflows/ci.yml');
    expect(workflow).toContain('python3 -B scripts/ci/test-late-registration-clock.py');
    const runner = read('scripts/ci/test-late-registration-clock.py');
    expect(runner).toContain(
      "subprocess.run([sys.executable, '-B', str(ROOT / 'scripts/ci/test-capacity-receipt-read-postgres.py')], check=True)"
    );
    const fixture = read('scripts/ci/test-capacity-receipt-read-postgres.py');
    expect(fixture).toContain(migration);
    expect(fixture).toContain('CANDIDATE.read_text()');
    expect(fixture).toContain("denied('service_role', query)");
    expect(fixture).toContain('fn_ack_tournament_capacity_tables');
  });
  it('keeps installation additive and restricted to the engine reader columns', () => {
    const sql = read(migration);
    expect(sql).toMatch(
      /GRANT SELECT \(table_id, tournament_id, created_at, manager_admitted_at\)\s+ON TABLE public\.tournament_capacity_table_receipts TO service_role;/
    );
    expect(sql).not.toMatch(/GRANT\s+(?:ALL|INSERT|UPDATE|DELETE)/i);
    expect(sql).not.toMatch(/(?:UPDATE|DELETE FROM|INSERT INTO)\s+public\./i);
    expect(sql.trim()).toMatch(/COMMIT;$/);
  });
});
