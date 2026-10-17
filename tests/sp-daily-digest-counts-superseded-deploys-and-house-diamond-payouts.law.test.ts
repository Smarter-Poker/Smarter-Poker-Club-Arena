/**
 * THE DAILY DIGEST COUNTS A SUPERSEDED DEPLOY AS SHIPPED, AND A HOUSE DIAMOND
 * PAYOUT AS A PAYOUT (2026-10-16).
 *
 * LAW 1 - A release that stood down for a newer one that shipped is not a
 *   failed deploy. It counts as shipped only when the revision its reason names
 *   really shipped within twelve hours, and is reported as 'superseded'.
 * LAW 2 - Diamond Spins daily net settlements and Wheel cards booked as type
 *   'transfer' are house payouts. The digest names them and counts them in
 *   diamonds given out or taken in instead of dropping them with peer
 *   transfers.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIG = resolve(HERE, '../supabase/migrations');
const file = readdirSync(MIG).find((n) =>
  /^\d{14}_sp_daily_digest_counts_superseded_deploys_and_house_diamond_\.sql$/.test(n)
);
if (!file) throw new Error('the migration is not in the tree');
const sql = readFileSync(resolve(MIG, file), 'utf8');

describe('the daily digest counts superseded deploys and house diamond payouts', () => {
  it('LAW 1: a stand-down counts as shipped only when the revision it names shipped', () => {
    expect(sql).toContain("'public.fn_sp_daily_metrics_compute(date)'");
    expect(sql).toMatch(/'shipped', count\(\*\) FILTER \(WHERE a\.shipped OR a\.superseded\)/);
    expect(sql).toMatch(/'superseded', count\(\*\) FILTER \(WHERE a\.superseded\)/);
    expect(sql).toMatch(/\(NOT x\.shipped AND EXISTS \(/);
    expect(sql).toMatch(/WHERE y\.shipped\s+AND y\.target_sha = substring\(x\.reason from 'protected main had moved to \(\[0-9a-f\]\{40\}\)'\)/);
    expect(sql).toMatch(/y\.at BETWEEN x\.at - interval '12 hours' AND x\.at \+ interval '12 hours'/);
  });

  it('LAW 2: transfer-typed house payouts are named and counted', () => {
    expect(sql).toMatch(
      /AND metadata->>'reference_id' LIKE 'diamond-spin-day:%' THEN 'diamond_spins_daily_net'/
    );
    expect(sql).toMatch(/AND metadata->>'reference_id' LIKE 'wheel-cards%' THEN 'wheel_cards'/);
    expect(sql).toMatch(/ELSE COALESCE\(transaction_type, type, 'unknown'\) END tt, amount, created_at\$n\$/);
  });

  it('is one pinned exact substitution in one transaction', () => {
    expect(sql).toMatch(/'ba689a29f14e0e922969645550f8e9e6', '0a7241d8426993393e54accdeec01676'/);
    expect(sql).toMatch(/@live-proof: \(SELECT md5\(pg_get_functiondef\('public\.fn_sp_daily_metrics_compute\(date\)'/);
    expect((sql.match(/^BEGIN;$/gm) || []).length).toBe(1);
    expect((sql.match(/^COMMIT;$/gm) || []).length).toBe(1);
  });
});
