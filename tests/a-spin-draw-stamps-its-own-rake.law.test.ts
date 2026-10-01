/**
 * A SPIN DRAW STAMPS ITS OWN RAKE (2026-10-01)
 *
 * fn_spin_draw_and_settle_atomic stamped the tournament row from the draw it
 * had just booked but never total_rake, so every completed Spin read
 * total_rake 0.00 while its escrow fee_out held the real rake, and
 * atomic_cancel_tournament refuses a tournament whose rake cache disagrees
 * with its escrow. Supersedes the held PR #5495, whose preimage no longer
 * matched production.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const SQL = readFileSync(
  resolve(
    __dirname,
    '..',
    'supabase/migrations/20261001202004_a_spin_draw_stamps_its_own_rake.sql'
  ),
  'utf8'
);

describe('the Spin draw', () => {
  it('is patched only from the exact live version, in one transaction', () => {
    expect(SQL).toContain("md5(p.prosrc) = '82ad42a0f71a0cdca23ccdcf65fafe7d'");
    expect(SQL).toContain("md5(pg_get_functiondef(p.oid)) = 'bbbb1f3d3c221060860384b557bd0472'");
    expect(SQL).toMatch(/^BEGIN;$/m);
    expect(SQL).toMatch(/^COMMIT;$/m);
    expect(SQL.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(SQL).toMatch(/^-- @live-proof: /m);
  });

  it('stamps total_rake from the settlement it just booked, and reads it back', () => {
    expect(SQL).toContain("total_rake        = round((v_settle->>''house_rake'')::numeric, 2),");
    expect(SQL).toContain(
      "AND t.total_rake IS NOT DISTINCT FROM round((v_settle->>''house_rake'')::numeric, 2)) THEN"
    );
  });

  it('keeps the owner, grants, settings, security and volatility it found', () => {
    expect(SQL).toContain("p.proacl::text = '{postgres=X/postgres,service_role=X/postgres}'");
    expect(SQL).toContain(
      "p.proconfig = ARRAY['search_path=public, extensions, pg_temp', 'statement_timeout=30s']"
    );
    expect(SQL).toContain('TO service_role;');
    expect(SQL.match(/AND p\.prosecdef/g)).toHaveLength(2);
  });

  it('back-fills nothing', () => {
    expect(SQL).not.toMatch(/^\s*UPDATE\s+public\.tournaments/im);
  });
});
