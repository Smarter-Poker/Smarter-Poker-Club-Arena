import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
const read = (path: string) => readFileSync(path, 'utf8');
describe('Lightning anchor ordering native qualification is enforced', () => {
  it('executes the actual concurrency regression in the existing required settlement chain', () => {
    const harness = read('scripts/dev/test-lightning-phase6-settlement.sh');
    expect(harness).toContain('python3 "$root/scripts/ci/test-lightning-anchor-lock-order.py"');
    expect(read('.github/workflows/ci.yml')).toContain(
      'run: bash scripts/dev/test-lightning-phase6-settlement.sh'
    );
    const native = read('scripts/ci/test-lightning-anchor-lock-order.py');
    expect(native).toContain("harness.lock_race('before',true)");
    expect(native).toContain("harness.lock_race('after',false)");
    expect(native).toContain('harness.dblink_send_query');
    expect(native).toContain('pg_blocking_pids(mpid)');
    expect(native).toContain('result.returncode == 0');
    expect(native).toContain("result.stdout.count('PASS anchor:') == 3");
  });
});
