/** Owner October 29: all new MTTs pay the top 15% of the field. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  MTT_DEFAULT_PAYOUT_DEPTH,
  MTT_PAYOUT_DEPTH_CHOICES,
  mttPayoutDepthColumn,
} from '../server/src/tournament/mttPayoutDepth';
const read = (path: string) => readFileSync(path, 'utf8');
const migration = read(
  'supabase/migrations/20261029202310_all_new_mtt_tournaments_pay_the_top_fifteen_percent.sql'
);
const capture = JSON.parse(read('scripts/ci/fixtures/mtt-fifteen-percent-preimages.json'));
describe('every new MTT pays the top fifteen percent', () => {
  it('forces the database creation authority to fifteen without a standalone-club exception', () => {
    const guard = capture.functions.find(
      (f: { signature: string }) => f.signature === 'fn_ca_mtt_payout_depth_guard()'
    ).postimage;
    expect(migration).toContain(guard);
    expect(guard).toContain('v_depth := 15;');
    expect(guard).toContain('NEW.payout_percent := 15;');
    expect(guard).toContain('NEW.payout_percent := OLD.payout_percent;');
    expect(guard).not.toContain('IF v_enforced THEN');
    expect(guard).toContain("NOT IN ('spin','sng','satellite')");
    expect(guard).toMatch(
      /COALESCE\(OLD\.prize_pool_finalized, false\) THEN\s+NEW\.payout_depth_percent := OLD\.payout_depth_percent;/
    );
  });
  it('offers fifteen on all new MTT creation surfaces and overrides stale schedule depths', () => {
    expect(MTT_DEFAULT_PAYOUT_DEPTH).toBe(15);
    expect(MTT_PAYOUT_DEPTH_CHOICES).toEqual([
      { value: 'payout3', percent: 15, label: 'Top 15% Of Field (Standard)' },
    ]);
    for (const depth of [undefined, null, 0, 10, 12.5, 15, 20, 100, 101, '12.5', '15'])
      expect(mttPayoutDepthColumn(depth)).toBe(15);
    expect(read('src/pages/TableConfigPage.tsx')).toContain(
      "gameMode: 'mtt', payoutStructure: 'payout3'"
    );
    expect(read('src/components/club/CreateTournamentModal.tsx')).toContain(
      'Tournaments Always Pay The Top 15 Percent.'
    );
  });
  it('keeps rounding up, exact pool conservation and finalized historical depths in the native qualification', () => {
    expect(
      capture.functions.find(
        (f: { signature: string }) => f.signature === 'fn_ca_payout_structure(integer,numeric)'
      ).definition
    ).toContain('ceil(p_entrants * v_pct / 100.0)::int');
    expect(migration).not.toContain(
      'CREATE OR REPLACE FUNCTION public.fn_ca_effective_payout_depth'
    );
    const native = read('scripts/ci/test-mtt-fifteen-percent.py');
    for (const proof of [
      'original source reproduces 12.5 depth',
      'already finalized prize ladder stays booked',
      'rounded paid field and conserved 100%',
      'authority drift refuses before any replacement',
      'preserved rights',
    ])
      expect(native).toContain(proof);
    expect(read('scripts/ci/test-mtt-unlimited.py')).toContain(
      'root / "scripts/ci/test-mtt-fifteen-percent.py"'
    );
    expect(read('.github/workflows/ci.yml')).toContain(
      'scripts/ci/test-mtt-unlimited.py --mode preparation'
    );
  });
  it('carries only a finite certified incident continuation through the existing provider', () => {
    const { windows } = JSON.parse(read('server/release/owner-maintenance-windows.json'));
    const window = windows.find(
      (w: { id: string }) => w.id === '2026-10-29-tournament-hand-gap-and-paid-depth-recovery'
    );
    expect(window.notBefore).toBe('2026-10-29T21:00:00Z');
    expect(window.notAfter).toBe('2026-10-30T01:20:00Z');
    expect(Date.parse(window.notAfter) - Date.parse(window.notBefore)).toBeLessThanOrEqual(
      6 * 3600000
    );
    expect(window.announceAtChicagoMinutes).toEqual([53]);
    expect(window.migrations).toEqual([]);
    expect(window.releaseWitness.sha256).toBe(createHash('sha256').update(migration).digest('hex'));
    for (const safeguard of [
      'protected PR8648',
      'full285-second',
      'completed v3 thaw',
      'No forced action',
      'does not reuse or extend',
    ])
      expect(window.ownerOrder).toContain(safeguard);
  });

  it('installs once as an atomic exact-preimage replacement without hot-table locks or financial writes', () => {
    expect(migration.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(migration.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(migration).toContain('MTT_FIFTEEN_PREIMAGE_DRIFT');
    expect(migration).toContain('before_meta IS DISTINCT FROM after_meta');
    expect(migration).not.toMatch(
      /LOCK TABLE|ALTER TABLE|UPDATE public\.tournaments|INSERT INTO public\.tournament_payouts/i
    );
  });
});
