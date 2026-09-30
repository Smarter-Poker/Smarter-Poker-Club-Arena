/**
 * THE RAKEBACK SETTLER READS ONLY WHAT EVERY WRITER HAS COMMITTED (2026-09-27)
 *
 * rake_records.created_at is the writer's transaction start. The settler paged
 * by (created_at, id) through now(), so a hand that committed a few seconds
 * after later-stamped rows were read ended up behind the durable cursor and
 * was never accrued: fifty-one cash sources between 2026-09-26 13:38 and
 * 2026-09-27 13:18, in every club, and the union's certified week refused
 * (union_cash_sources_do_not_match_bank).
 *
 * The laws:
 *   1. the database names the horizon from EVERY open transaction in its own
 *      database that can write a table, minus a margin, never from a guess,
 *      and names none while a prepared transaction (invisible to
 *      pg_stat_activity) is open;
 *   2. only the engine can ask for it;
 *   3. the settler asks BEFORE it reads a page, bounds every page by it, and
 *      holds its cursor when it cannot get one;
 *   4. a cash source below the cursor that was never submitted, and a horizon
 *      held by a forgotten transaction, reach operational_alert_events with
 *      the fleet's target_task_id.
 *
 * The runtime behaviour (a late-committing row is still submitted) is proved
 * in server/src/services/rakebackWatermark.test.ts against the real service,
 * and with real concurrent transactions on PostgreSQL 17 by
 * scripts/ci/test-rakeback-settler-read-horizon-postgres.py (CI accounting
 * shard 4).
 *
 * 20260927144455.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { functionBody, latestDeclaring } from './helpers/migrations';

const FN = 'fn_rakeback_settler_read_horizon';

describe('the settler read horizon', () => {
  const { name, sql } = latestDeclaring(FN);
  const body = functionBody(sql, FN);

  it('is declared by the migration that introduced it or a later one', () => {
    expect(name >= '20260927144455').toBe(true);
  });

  it('reads the oldest open transaction start and never answers later than now()', () => {
    expect(body).toMatch(/pg_stat_activity/);
    expect(body).toMatch(/xact_start/);
    expect(body).toMatch(/ORDER BY a\.xact_start/);
    expect(body).toMatch(/LEAST\(v_now, COALESCE\(v_oldest, v_now\)\) - c_margin/);
    expect(body).toMatch(/c_margin\s+constant interval := interval '60 seconds'/);
    // Only a backend of this database can write rake_records.
    expect(body).toMatch(/a\.datid = v_db/);
    expect(body).toMatch(/d\.datname = pg_catalog\.current_database\(\)/);
    // A client backend is where every rake writer runs; it may not be excluded.
    expect(body).not.toMatch(/'client backend'/);
  });

  it('names no horizon while a prepared transaction is open', () => {
    expect(body).toMatch(/pg_prepared_xacts/);
    expect(body).toMatch(/'horizon', NULL/);
  });

  it('is read-only, SECURITY DEFINER, and executable by service_role alone', () => {
    expect(body).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/i);
    expect(sql).toMatch(/SECURITY DEFINER/);
    expect(sql).toMatch(
      new RegExp(`REVOKE ALL ON FUNCTION public\\.${FN}\\(\\) FROM anon, authenticated`)
    );
    expect(sql).toMatch(
      new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${FN}\\(\\) TO service_role`)
    );
  });

  it('refuses to install where its premises do not hold', () => {
    expect(sql).toMatch(/max_prepared_transactions/);
    expect(sql).toMatch(/pg_read_all_stats/);
    expect(sql).toMatch(/column_name = 'created_at'/);
  });
});

describe('a stranded cash source or a held horizon reaches the fleet', () => {
  const CHECK = 'fn_rakeback_settler_stranded_source_check';
  const { name, sql } = latestDeclaring(CHECK);
  const body = functionBody(sql, CHECK);

  it('is declared by the migration that introduced it or a later one', () => {
    expect(name >= '20260927144455').toBe(true);
  });

  it('looks only below the settler cursor, at positive cash rows, as an index range', () => {
    expect(body).toMatch(/FROM public\.daemon_state WHERE daemon = 'rakeback_settler'/);
    expect(body).toMatch(/rr\.created_at >= v_from\s+AND rr\.created_at <\s+v_cursor/);
    expect(body).toMatch(/rr\.rake_amount > 0/);
    expect(body).toMatch(/NOT COALESCE\(rr\.is_tournament, false\)/);
    expect(body).toMatch(/rr\.tournament_id IS NULL/);
    for (const evidence of [
      'accounting_cash_accrual_batches',
      'accounting_cash_source_receipts',
      'accounting_cash_source_work',
      'accounting_cash_rake_sources',
    ])
      expect(body).toMatch(new RegExp(`NOT EXISTS \\(SELECT 1 FROM public\\.${evidence} `));
    // No club or union filter: the forty non-union rows had no alert at all.
    expect(body).not.toMatch(/union_id/);
  });

  it('records into operational_alert_events with the fleet task, and writes nothing else', () => {
    expect(body.match(/public\.fn_record_operational_alert\(/g)).toHaveLength(2);
    expect(body.match(/'target_task_id', c_task/g)).toHaveLength(2);
    expect(body).toMatch(/c_task\s+constant text := '01a09b86-5ba8-7290-8657-1041f13dd3ca'/);
    expect(body).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/i);
    expect(body).not.toMatch(/fn_credit_agent_commissions_batch|fn_retry_cash_accounting_sources/);
  });

  it('runs hourly outside the maintenance window, and only the owner can run it', () => {
    expect(sql).toMatch(
      /cron\.schedule\('rakeback-settler-stranded-source-check-hourly', '28 \* \* \* \*'/
    );
    expect(sql).toMatch(
      new RegExp(`REVOKE ALL ON FUNCTION public\\.${CHECK}\\(\\) FROM anon, authenticated`)
    );
  });
});

describe('the settler bounds every page by the horizon', () => {
  const src = readFileSync(
    resolve(__dirname, '../server/src/services/RakebackSettlerService.ts'),
    'utf8'
  )
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
  const start = src.indexOf('private async _runSettlementInner(');
  const inner = src.slice(start);

  it('asks for the horizon before the first page read and holds the cursor without one', () => {
    const ask = inner.indexOf('supabase.rpc(SETTLER_READ_HORIZON_RPC)');
    const firstRead = inner.indexOf(".from('rake_records')");
    expect(ask).toBeGreaterThan(-1);
    expect(firstRead).toBeGreaterThan(ask);
    expect(inner.slice(ask, firstRead)).toMatch(/read_horizon_holds_cursor'\);\s*return 'halted';/);
  });

  it('applies the horizon inside the one query builder every page uses', () => {
    const builder = inner.slice(
      inner.indexOf('const sourceQuery = () =>'),
      inner.indexOf('let rows: RakeRecordRow[]')
    );
    expect(builder).toContain(".lt('created_at', horizon)");
    expect(inner.match(/\.from\('rake_records'\)/g)).toHaveLength(1);
  });
});
