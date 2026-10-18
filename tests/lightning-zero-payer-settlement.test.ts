import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(path, 'utf8');

describe('zero-contribution folders reach the native accepted-hand contract', () => {
  it('runs the regression inside the existing required accounting owner', () => {
    expect(read('.github/workflows/ci.yml')).toContain(
      'run: bash scripts/dev/test-lightning-phase6-settlement.sh'
    );
    const harness = read('scripts/dev/test-lightning-phase6-settlement.sh');
    expect(harness).toContain('LIGHTNING_ZERO_PAYER_SOCKET="$fixture/socket"');
    expect(harness).toContain('python3 "$root/scripts/ci/test-lightning-zero-payer-settlement.py"');
    const native = read('scripts/ci/test-lightning-zero-payer-settlement.py');
    expect(native).toContain('post_commit_fee_mismatch');
    expect(native).toContain('harness.settle(c.hand_id,c.request_id,c.results');
    expect(native).not.toContain('CREATE FUNCTION public.fn_ca_commit_hand_settlement');
  });
  it('preserves the dealt count and changes the canonical map plus positive-only promo together', () => {
    const migration = read(
      'supabase/migrations/20261018230728_lightning_settlement_names_zero_contribution_dealt_players.sql'
    );
    expect(migration).toContain('WHERE (e.value::text)::numeric > 0;');
    expect(migration).toContain('0670ed75762f05e7ad3346a1c95e84dc');
    expect(migration).toContain('lightning_settlement_preimage_refused');
    expect(migration).toContain('lightning_settlement_postimage_or_security_refused');
    expect(migration).not.toMatch(
      /UPDATE\s+(?:public\.)?(?:table_seats|club_members|lightning_hand)\b/i
    );
  });
});
