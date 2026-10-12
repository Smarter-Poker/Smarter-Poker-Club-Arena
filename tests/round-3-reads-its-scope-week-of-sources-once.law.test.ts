/**
 * ROUND 3 READS ITS SCOPE'S WEEK OF SOURCES ONCE (2026-10-03).
 *
 * Pinned on migration 20261003081100_round_3_reads_its_scope_week_of_sources_once.sql. In the 2026-10-01 Midway close, round 3
 * (fn_settle_accounting_rakeback_stage) spent 887 s admitting 382 periods of a
 * club outside the scope, one full scan of that club's week of sources per
 * period, and 240 s re-reading the scope's week of sources for the
 * missing-period check. The periods statement now reads the (club, player)
 * pairs once, in the same statement, and the missing-period check reads the
 * rows the set path already holds. Same periods, same locks, same refusals.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const sql = readFileSync(
  join(
    process.cwd(),
    'supabase/migrations/20261003081100_round_3_reads_its_scope_week_of_sources_once.sql'
  ),
  'utf8'
);

describe("round 3 reads its scope's week of sources once", () => {
  it('is one transaction with live proofs', () => {
    expect(sql).toMatch(/^BEGIN;$/m);
    expect(sql.trim().endsWith('COMMIT;')).toBe(true);
    expect(sql).toMatch(/^-- @live-proof: /m);
    expect(sql).toContain("SET LOCAL lock_timeout = '5s';");
  });

  it('edits only the 2026-10-03 preimage, by three exact anchors, and verifies the result', () => {
    expect(sql).toContain("IF md5(d)<>'413b4887556881e1a1de0a4c2d20abd1' THEN");
    for (const n of [1, 2, 3]) {
      expect(sql).toContain(`RAISE EXCEPTION 'rakeback stage anchor ${n} count'`);
    }
    expect(sql).toContain('IF pg_get_functiondef(s)<>d THEN');
  });

  it('admits outside periods by the same (club, player) test, read once in the same statement', () => {
    expect(sql).toContain(
      'FROM (WITH pclubs AS MATERIALIZED (SELECT DISTINCT p2.club_id FROM public.rakeback_periods p2'
    );
    expect(sql).toContain('AND (p2.club_id=ANY(scope.club_ids)) IS NOT TRUE)');
    expect(sql).toContain(
      'pairs AS MATERIALIZED (SELECT DISTINCT rs.club_id,rs.player_id FROM public.accounting_payable_earning_sources rs'
    );
    expect(sql).toContain(
      'THEN EXISTS(SELECT 1 FROM pairs q WHERE q.club_id=rp.club_id AND q.player_id=rp.user_id)'
    );
    // A club not covered by pclubs still asks the sources directly.
    expect(sql).toContain(
      'ELSE EXISTS(SELECT 1 FROM public.accounting_payable_earning_sources rs WHERE rs.club_id=rp.club_id AND rs.player_id=rp.user_id'
    );
    // rp stays the only locked table, in the original order.
    expect(sql).toContain('ORDER BY rp.club_id,rp.user_id,rp.id FOR UPDATE OF rp) x;');
  });

  it('keeps the original missing-period query whenever the set path did not admit the book', () => {
    expect(sql).toContain(
      "rs.contract->'membership'->'terms'->>'agent_id',rs.contract->>'is_union_house'"
    );
    expect(sql).toContain('IF (CASE WHEN v4_ok THEN EXISTS(SELECT 1 FROM pg_temp._rr3_week_v4 rs');
    expect(sql).toContain('WHERE COALESCE((rs.house_text)::boolean,false) IS FALSE');
    const y3 = sql.slice(sql.indexOf(' y3 text:='));
    expect(y3).toContain(
      'ELSE EXISTS(SELECT 1 FROM public.accounting_payable_earning_sources rs WHERE (rs.coordinator_union_id=p_union_id'
    );
    expect(y3).toContain(
      "THEN RAISE EXCEPTION 'routed_rakeback_player_period_missing' USING ERRCODE='55000'; END IF;"
    );
  });

  it('changes no table, index, grant or schedule', () => {
    expect(sql).not.toMatch(/^\s*(CREATE|DROP)\s+(UNIQUE\s+)?INDEX/im);
    expect(sql).not.toMatch(/ALTER\s+TABLE/i);
    expect(sql).not.toMatch(/^\s*(GRANT|REVOKE)\s/im);
    expect(sql).not.toMatch(/cron\.(schedule|alter_job|unschedule)\(/);
  });
});
