import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Owner, 2026-10-31: remove the Lightning Internal Pilot with every trace. The
// pilot was the first retired club with weekly accounting history; without this
// rule the scheduler would close an empty week for it every Monday and fail on
// the retirement guard each time.
const sql = readFileSync(
  resolve(
    __dirname,
    '../supabase/migrations/20261031202949_a_retired_club_opens_no_empty_accounting_week.sql'
  ),
  'utf8'
);

describe('a retired club opens no empty accounting week', () => {
  it('patches only the eligible standalone-club selection, on one exact anchor', () => {
    expect(sql).toContain(
      'FROM standalone_work w JOIN public.clubs c ON c.id=w.club_id\\n           WHERE c.is_union IS NOT TRUE AND GREATEST('
    );
    expect(sql).toContain('RETIRED_WEEK_RULE_ANCHOR_CHANGED');
    expect(sql).toContain('RETIRED_WEEK_RULE_METADATA_CHANGED');
  });

  it('keeps a retired club due while anything is unfinished or earned after its last close', () => {
    expect(sql).toContain("c.lifecycle_status=''retired''");
    expect(sql).toContain("rq.status<>''complete''");
    expect(sql).toContain('accounting_cash_rake_sources rs WHERE rs.club_id=c.id');
    expect(sql).toContain('accounting_tournament_fee_sources ts WHERE ts.club_id=c.id');
    expect(sql).toContain(
      "max(rq.period_end) FROM public.union_accounting_runs rq WHERE rq.standalone_club_id=c.id AND rq.status=''complete''"
    );
  });

  it('is applied once, in one transaction, with a live proof', () => {
    expect(sql.match(/^BEGIN;$/gm)?.length).toBe(1);
    expect(sql.match(/^COMMIT;$/gm)?.length).toBe(1);
    expect(sql).toMatch(/^-- @live-proof: /m);
  });
});
