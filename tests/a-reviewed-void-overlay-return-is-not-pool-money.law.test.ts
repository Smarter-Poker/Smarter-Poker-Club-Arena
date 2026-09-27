/**
 * A REVIEWED VOID'S OVERLAY RETURN IS NOT POOL MONEY (2026-09-27)
 *
 * The reviewed void of 615783bf and 5a387a75 returned each guarantee overlay
 * to its funder as one 'reversal' leg out of prize_liability. The escrow
 * shadow and the conservation delta did not know that leg and read 250.00 /
 * 100.00 still in the pool (fn_ca_escrow_balance_drift raised both at 14:35
 * UTC). Both now subtract it; every other event reads as before (checked
 * read-only against production for the voided pair and five other events).
 *
 * docs/changelog/2026-09-27-a-reviewed-void-overlay-return-is-not-pool-money.md
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SQL = readFileSync(
  join(
    __dirname,
    '..',
    'supabase',
    'migrations',
    '20260927150903_a_reviewed_void_overlay_return_is_not_pool_money.sql'
  ),
  'utf8'
);
const md5 = (s: string) => createHash('md5').update(s, 'utf8').digest('hex');

function body(name: string): string {
  const start = SQL.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  expect(start, `the file defines ${name}`).toBeGreaterThanOrEqual(0);
  const open = SQL.indexOf('$function$', start) + '$function$'.length;
  return SQL.slice(open, SQL.indexOf('$function$', open));
}

const ESCROW = body('fn_ca_tournament_escrow_chips');
const DELTA = body('fn_tournament_conservation_delta');
const LEG = "metadata->>'kind'";

describe("a reviewed void's overlay return is not pool money", () => {
  it('installs exactly the reviewed bodies over the production pre-images', () => {
    expect(md5(ESCROW)).toBe('6e3889909fd0830f6b374e7ac026c1c0');
    expect(md5(DELTA)).toBe('ce248ae34ecb66dd36a55c50fee8d07b');
    expect(SQL).toContain("md5(p.prosrc) = '6d76d2f0946ba93475ea5e9e185f027f'");
    expect(SQL).toContain("md5(p.prosrc) = 'ac92ee4f3f1a5e7aca3b9bd3cbe9ef34'");
  });

  it('nets only the reviewed-void reversal leg out of the counted overlay', () => {
    for (const b of [ESCROW, DELTA]) {
      expect(b).toContain("'reviewed_void_overlay_return'");
      expect(b).toContain(LEG);
      expect(b).toMatch(/category ?= ?'reversal'/);
      expect(b).toMatch(/from_type ?= ?'prize_liability'/);
    }
    expect(ESCROW).toContain('ELSE tgo.tgo_amount END-ov.returned,2) AS overlay_in,');
    expect(DELTA).toMatch(
      /\)\s+-- A REVIEWED VOID RETURNS ITS OVERLAY[\s\S]*- COALESCE\(\(SELECT sum\(r\.amount\)/
    );
  });

  it('asserts both voided events read neutral after the change', () => {
    expect(SQL).toContain(
      "'615783bf-15e3-40b7-9368-75f21b6ac53b', '5a387a75-754a-416e-8fee-b85b15fc2702'"
    );
    expect(SQL).toContain('OR public.fn_tournament_conservation_delta(r.id) <> 0 THEN');
  });

  it('keeps both readers service_role only', () => {
    for (const fn of ['fn_ca_tournament_escrow_chips', 'fn_tournament_conservation_delta']) {
      expect(SQL).toContain(
        `REVOKE ALL ON FUNCTION public.${fn}(uuid) FROM PUBLIC, anon, authenticated;`
      );
      expect(SQL).toContain(`GRANT EXECUTE ON FUNCTION public.${fn}(uuid) TO service_role;`);
    }
  });
});
