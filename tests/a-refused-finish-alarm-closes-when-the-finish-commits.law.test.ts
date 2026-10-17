/**
 * A REFUSED FINISH ALARM CLOSES WHEN THE FINISH COMMITS (2026-10-17)
 *
 * Tournament.atomic_finish_refused and Tournament.atomic_satellite_finish_refused
 * were closed automatically only for timeout/deadlock refusals of ordinary
 * tournaments; every other one waited for a person (Satellite 10's, after it
 * had completed and paid its winner). fn_resolve_settled_financial_alerts
 * class 6 closes a PROVEN refusal once the tournament is COMPLETED with its
 * receipt and its escrow closed at zero after the alarm was raised.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  'supabase/migrations/20261017105512_a_refused_finish_alarm_closes_when_the_finish_commits.sql',
  'utf8'
);
const start = sql.indexOf('-- CLASS 6:');
const body = sql.slice(start, sql.indexOf('INTO v_fin_ids FROM changed;', start));

describe('a refused finish alarm closes when the finish commits', () => {
  it('reads only the two refused-finish sources, and only proven refusals', () => {
    const sources = new Set(body.match(/'Tournament\.[a-z_]+'/g));
    expect(sources).toEqual(
      new Set([
        "'Tournament.atomic_finish_refused'",
        "'Tournament.atomic_satellite_finish_refused'",
      ])
    );
    expect(body).toContain(
      "lower(COALESCE(a.context->>'proven_refusal', '')) IN ('true', 't', '1')"
    );
  });

  it('closes only on the receipt of a committed finish after the alarm', () => {
    for (const clause of [
      "t.status = 'COMPLETED'",
      'e.terminal_closed_at IS NOT NULL',
      'e.terminal_closed_at >= a.created_at',
      'COALESCE(e.prize_balance, 0) = 0',
      'COALESCE(e.bounty_balance, 0) = 0',
      'public.tournament_satellite_settlements s',
      'public.tournament_terminal_settlements s',
    ]) {
      const preview = body.slice(0, body.indexOf('IF p_apply THEN'));
      const update = body.slice(body.indexOf('WITH changed AS'));
      expect(preview).toContain(clause);
      expect(update).toContain(clause);
    }
    expect(body).not.toMatch(/interval|now\(\)\s*-/);
  });

  it('casts the tournament id only behind a uuid shape check', () => {
    expect(body).not.toMatch(/=\s*\(a\.context->>'tournament_id'\)::uuid/);
  });

  it('installs only over the exact preimage and reads back the exact postimage', () => {
    expect(sql).toContain("'8adc7dfe51bab6388a174abf2db52e67'");
    expect(sql).toContain("md5(v_post) <> '24a8270d08af6a1f54a7ed57154ec625'");
    expect(sql).toContain('pg_get_functiondef(v_oid) IS DISTINCT FROM v_post');
  });
});
