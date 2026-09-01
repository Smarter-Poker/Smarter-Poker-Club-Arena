/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A GUARD THAT STARTS FROM THE TABLE CANNOT SEE A MISSING ROW
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `v_tournament_rake_attribution_gaps` is the estate's watcher for tournament
 * rake, and it opens with
 *
 *     FROM tournament_rake_settlements r
 *     LEFT JOIN tournaments t ON t.id = r.tournament_id
 *
 * so it can say a settlement credited nobody, or threw, or was never measured.
 * What it structurally cannot say is that a settlement DOES NOT EXIST - an
 * unsettled tournament has no row to start from, so it is not a gap the view
 * reports, it is a row the query never reaches.
 *
 * On 2026-08-31 that blind spot cost 215.98 in union rake across 29 terminal
 * events over two and a half hours, while the attribution view sat at zero
 * rows the entire time. Every settlement it could see was fine. The wrong ones
 * were the ones that were not there.
 *
 * `fn_tournament_rake_settlement_check` starts from `tournaments` instead. This
 * test pins that direction, because the tempting "simplification" - joining
 * from the settlements table like its sibling view - reintroduces the exact
 * blind spot the function exists to close, and would still pass any test that
 * only checked it runs.
 *
 * Reads the SQL as TEXT: no database connection, runs on every pull request.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const DIR = resolve(__dirname, '../../supabase/migrations');
const guardSql = readFileSync(
  resolve(DIR, '20260831234200_tournament_rake_settlement_guard.sql'),
  'utf8'
);
const scheduleSql = readFileSync(
  resolve(DIR, '20260831234300_tournament_rake_settlement_guard_schedule.sql'),
  'utf8'
);

const body = guardSql.slice(guardSql.indexOf('AS $function$'), guardSql.indexOf('$function$;'));
/** `--` comments stripped, so prose about a filter is not a filter. */
const code = guardSql
  .split('\n')
  .map((l) => l.replace(/--.*$/, ''))
  .join('\n');

describe('the rake settlement guard looks from the tournaments side', () => {
  it('drives off tournaments, not off the settlements table', () => {
    expect(body).toMatch(/FROM\s+public\.tournaments\s+t/);
  });

  it('finds tournaments that have NO settlement row', () => {
    expect(body).toMatch(/NOT EXISTS\s*\(\s*SELECT 1 FROM public\.tournament_rake_settlements/);
  });

  it('only counts events that actually banked rake', () => {
    expect(body).toMatch(
      /EXISTS\s*\(\s*SELECT 1 FROM public\.rake_records[\s\S]{0,120}is_tournament/
    );
  });

  it('covers every terminal status, cancellations included', () => {
    for (const status of ['COMPLETED', 'CANCELLED', 'CANCELED']) {
      expect(body).toContain(`'${status}'`);
    }
  });

  it('gives settlement a grace window instead of alarming on latency', () => {
    expect(body).toMatch(/p_grace_minutes/);
    expect(body).toMatch(/ended_at\s*<\s*now\(\)\s*-\s*make_interval\(mins\s*=>\s*v_grace\)/);
  });

  it('escalates a pile of misses above a single one', () => {
    expect(body).toMatch(/v_missing\s*>=\s*5\s*OR\s*v_owed\s*>=\s*50/);
    expect(body).toContain("'critical'");
    expect(body).toContain("'warning'");
  });

  it('reports and repairs nothing, so a broken sweep cannot hide behind it', () => {
    expect(body).not.toMatch(/fn_settle_tournament_rake/);
    expect(body).not.toMatch(/\bUPDATE\s+public\./i);
    expect(body).not.toMatch(/\bDELETE\s+FROM\b/i);
    const inserts = body.match(/\bINSERT\s+INTO\s+public\.(\w+)/gi) ?? [];
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toMatch(/financial_alerts/);
  });

  it('treats horses as players - CLAUDE.md 10.5', () => {
    expect(code).not.toMatch(/is_horse/i);
    expect(code).not.toMatch(/p_include_horses/i);
  });

  it('is closed to anon and authenticated, and proves it', () => {
    expect(guardSql).toMatch(/REVOKE ALL ON FUNCTION[\s\S]*FROM anon;/);
    expect(guardSql).toMatch(/REVOKE ALL ON FUNCTION[\s\S]*FROM authenticated;/);
    expect(guardSql).toMatch(/GRANT EXECUTE ON FUNCTION[\s\S]*TO service_role;/);
    expect(guardSql).toMatch(/has_function_privilege\('anon'/);
  });
});

describe('the schedule points at the function it claims to', () => {
  it('runs hourly at :19, a minute no other hourly job holds', () => {
    expect(scheduleSql).toMatch(/'19 \* \* \* \*'/);
  });

  it('calls the function this migration pair defines', () => {
    expect(scheduleSql).toContain('public.fn_tournament_rake_settlement_check(');
  });

  it('takes the advisory lock so two runs cannot overlap', () => {
    expect(scheduleSql).toMatch(
      /pg_try_advisory_lock\(hashtext\('tournament_rake_settlement_check'\)\)/
    );
  });

  it('verifies the job landed instead of trusting cron.schedule', () => {
    expect(scheduleSql).toMatch(
      /RAISE EXCEPTION 'tournament_rake_settlement_check_hourly was not scheduled'/
    );
  });
});
