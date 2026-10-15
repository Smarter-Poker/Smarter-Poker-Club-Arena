/**
 * LAW: THE LAUNCH HAS ONE HEALTH READING (2026-10-15).
 *
 * fn_ca_launch_health() answers "is the platform ready right now" in one
 * call: one row per area (financial_alerts, hand_settlement, weekly_close,
 * tournaments, scheduled_jobs) and a final 'launch' row that is the worst of
 * them. It must stay a pure read, an unreadable area must count as red, and a
 * week the owner moved below a settlement floor is not an open close.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SQL = readFileSync(
  resolve(
    process.cwd(),
    'supabase/migrations/20261015101222_the_launch_has_one_health_reading.sql'
  ),
  'utf8'
);
const CODE = SQL.replace(/^\s*--[^\n]*$/gm, '');
const BODY = CODE.split('AS $fn$')[1].split('$fn$;')[0];

describe('the launch has one health reading', () => {
  it('is one transaction with a live proof, and the function is service role only', () => {
    expect(SQL.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(SQL.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(SQL).toMatch(/^-- @live-proof: to_regprocedure\('public\.fn_ca_launch_health\(\)'\)/m);
    expect(CODE).toContain(
      'REVOKE ALL ON FUNCTION public.fn_ca_launch_health() FROM PUBLIC, anon, authenticated;'
    );
    expect(CODE).toContain(
      'GRANT EXECUTE ON FUNCTION public.fn_ca_launch_health() TO service_role;'
    );
    expect(CODE).toContain("SET search_path TO 'pg_catalog', 'public'");
  });

  it('reads every launch area and ends with the worst of them', () => {
    for (const area of [
      "area := 'financial_alerts'",
      "area := 'hand_settlement'",
      "area := 'weekly_close'",
      "area := 'tournaments'",
      "area := 'scheduled_jobs'",
      "area := 'launch'",
    ])
      expect(BODY).toContain(area);
    expect(BODY).toContain(`'{"green":0,"amber":1,"red":2,"unknown":2}'`);
  });

  it('is a pure read and never calls a check that files alerts', () => {
    expect(BODY).not.toMatch(/\b(INSERT|UPDATE|DELETE|PERFORM)\b/i);
    expect(BODY).not.toContain('fn_money_check_health');
    expect(BODY).not.toContain('fn_raise');
  });

  it('respects the owner settlement floors when it reads the weekly close', () => {
    expect(BODY).toContain('public.union_settlement_floor');
    expect(BODY).toContain('public.club_settlement_floor');
    expect(BODY).toContain('r.period_start < u.earliest_period_start');
    expect(BODY).toContain('r.period_start < c.earliest_period_start');
  });
});
