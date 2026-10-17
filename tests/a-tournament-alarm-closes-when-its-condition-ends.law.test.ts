/**
 * A TOURNAMENT ALARM CLOSES WHEN ITS CONDITION ENDS (2026-10-16)
 *
 * Tournament.table_admission_failing and GameServer.tournament_dark_after_rebuild
 * had no closer: all 147 raised from 2026-10-13 were closed by hand, in five
 * separate migrations. fn_resolve_settled_financial_alerts class 5 closes one
 * only on evidence that its condition ended: the tournament finished, or the
 * named table (or, for a dark event, any table) committed a hand after the
 * alarm, or the named table closed. Elapsed time alone never closes one.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  'supabase/migrations/20261017002943_a_tournament_alarm_closes_when_its_condition_ends.sql',
  'utf8'
);
// Class 5 runs from its comment to the end of its own apply block.
const classStart = sql.indexOf('-- CLASS 5:');
const body = sql.slice(
  classStart,
  sql.indexOf("SELECT COALESCE(array_agg(id), '{}') INTO v_ops_ids FROM changed;", classStart)
);

describe('a tournament alarm closes when its condition ends', () => {
  it('closes only the two tournament alarm sources', () => {
    const sources = new Set(body.match(/'(?:Tournament|GameServer)\.[a-z_]+'/g));
    expect(sources).toEqual(
      new Set([
        "'Tournament.table_admission_failing'",
        "'GameServer.tournament_dark_after_rebuild'",
      ])
    );
  });

  it('closes on evidence: a finished event, a hand committed after the alarm, or a closed table', () => {
    expect(body).toContain("t.status IN ('COMPLETED', 'CANCELLED')");
    expect(body).toContain('c.committed_at > a.created_at');
    expect(body).toContain("lower(tb.status) = 'closed'");
    expect(body).toContain('AND tb.tournament_id = t.id');
    // Never on age alone.
    expect(body).not.toMatch(/interval|now\(\)\s*-/);
  });

  it('repeats the whole predicate under the UPDATE, so a preview is never the authority', () => {
    const preview = body.slice(0, body.indexOf('IF p_apply THEN'));
    const update = body.slice(body.indexOf('WITH changed AS'));
    for (const clause of [
      "t.status IN ('COMPLETED', 'CANCELLED')",
      'c.committed_at > a.created_at',
      "lower(tb.status) = 'closed'",
    ]) {
      expect(preview).toContain(clause);
      expect(update).toContain(clause);
    }
  });

  it('casts a context id only behind a uuid shape check', () => {
    expect(body).not.toMatch(/=\s*\(a\.context->>'(?:tournament|table)_id'\)::uuid/);
    expect(body).toMatch(/CASE WHEN \(a\.context->>'tournament_id'\) ~ /);
  });

  it('installs only over the exact preimage and reads back the exact postimage', () => {
    expect(sql).toContain("'edd4397b2daeadade433cd01a26a1c70'");
    expect(sql).toContain("md5(v_post) <> '8adc7dfe51bab6388a174abf2db52e67'");
    expect(sql).toContain('pg_get_functiondef(v_oid) IS DISTINCT FROM v_post');
  });
});
