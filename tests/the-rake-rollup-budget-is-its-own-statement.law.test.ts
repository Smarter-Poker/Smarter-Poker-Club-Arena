/**
 * ===========================================================================
 *  LAW: THE RAKE ROLLUP'S TIMEOUT IS ITS OWN STATEMENT, AND ITS DAY QUERY
 *  READS ONE DAY
 * ===========================================================================
 *
 * 2026-09-29T00:55Z to 2026-09-30T22:55Z: pg_cron job
 * `union-rake-rollup-catchup` failed 54 runs in a row, every one lasting
 * 00:02:00.00x, and union_rake_paid_daily_user stopped at 2026-09-27.
 *
 * 1. Its command raised statement_timeout with set_config(...) INSIDE its DO
 *    block. Postgres arms the statement timer when the top-level statement
 *    starts, so the 600 s never applied and the postgres role's 2 min did.
 *    The budget must be `SET statement_timeout = '...';` as its own top-level
 *    statement BEFORE the DO, never a set_config inside one.
 *
 * 2. fn_union_rake_rollup_refresh_day split each hand's rake with a window
 *    partitioned by rake_records.id, and the planner fed that window by
 *    walking rake_records_pkey over the whole table (> 55 s for one day).
 *    The hand total is a LATERAL SUM; the window must not come back.
 *
 * 3. fn_union_rake_rollup_catchup stops starting new days 240 s into its
 *    statement, so one slow day ends the pass and commits the rest instead of
 *    rolling every day back.
 *
 * The LATEST migration that defines each of these is what production runs, so
 * that is what this reads.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const DIR = join(__dirname, '..', 'supabase', 'migrations');
const files = readdirSync(DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort();

function latest(match: RegExp): { file: string; sql: string } {
  let hit: { file: string; sql: string } | null = null;
  for (const f of files) {
    const sql = readFileSync(join(DIR, f), 'utf8');
    if (match.test(sql)) hit = { file: f, sql };
  }
  if (!hit) throw new Error(`no migration matches ${match}`);
  return hit;
}

/** Strip SQL line comments so prose cannot satisfy or break an assertion. */
const code = (sql: string) => sql.replace(/--[^\n]*/g, '');

/** The body of the last CREATE [OR REPLACE] FUNCTION <name>( in a file. */
function functionBody(sql: string, name: string): string {
  const re = new RegExp(
    `CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+(?:public\\.)?${name}\\s*\\(`,
    'gi'
  );
  let start = -1;
  for (let m = re.exec(sql); m; m = re.exec(sql)) start = m.index;
  if (start < 0) throw new Error(`${name} not defined`);
  const open = sql.indexOf('$function$', start);
  const close = sql.indexOf('$function$', open + 10);
  return sql.slice(open, close);
}

describe('union-rake-rollup-catchup: the budget is its own top-level statement', () => {
  const { file, sql } = latest(
    /cron\.(?:alter_job|schedule)\s*\([\s\S]{0,400}union-rake-rollup-catchup/i
  );
  const body = code(sql);
  const cmd = /\$cmd\$([\s\S]*?)\$cmd\$/.exec(body)?.[1] ?? '';

  it(`the latest migration scheduling it (${file}) carries a readable command`, () => {
    expect(cmd.length).toBeGreaterThan(0);
  });

  it('opens with SET statement_timeout as its own statement, before any DO', () => {
    expect(cmd.trimStart()).toMatch(/^SET\s+statement_timeout\s*=\s*'\d+s'\s*;/i);
    const setAt = cmd.search(/SET\s+statement_timeout/i);
    const doAt = cmd.search(/\bDO\s+\$/i);
    expect(doAt).toBeGreaterThan(setAt);
  });

  it('never raises statement_timeout from inside the DO block', () => {
    const doBlock = cmd.slice(cmd.search(/\bDO\s+\$/i));
    expect(doBlock).not.toMatch(/set_config\s*\(\s*'statement_timeout'/i);
    expect(doBlock).not.toMatch(/\bSET\s+(?:LOCAL\s+)?statement_timeout/i);
  });

  it('keeps the schedule that is the product, and still calls the catch-up', () => {
    expect(cmd).toMatch(/fn_union_rake_rollup_catchup_all\(\s*\d+\s*\)/);
  });
});

describe('fn_union_rake_rollup_refresh_day reads one day, not every rake record', () => {
  const { sql } = latest(/FUNCTION\s+(?:public\.)?fn_union_rake_rollup_refresh_day\s*\(/i);
  const fn = functionBody(sql, 'fn_union_rake_rollup_refresh_day').replace(/\/\*[\s\S]*?\*\//g, '');

  it('has no window partitioned by the rake record id', () => {
    expect(fn).not.toMatch(/OVER\s*\(\s*PARTITION\s+BY\s+r\.id/i);
  });

  it('takes each hand total from a LATERAL SUM over the same contributions', () => {
    expect(fn).toMatch(
      /LATERAL\s*\(\s*SELECT\s+SUM\(\s*\(x\.value\)::numeric\s*\)[\s\S]*jsonb_each_text\(r\.player_contributions\)/i
    );
  });

  it('never filters horses out of the rollup (CLAUDE.md 10.5)', () => {
    expect(fn).not.toMatch(/is_horse/i);
  });
});

describe('fn_union_rake_rollup_catchup bounds each pass and commits what it rolled', () => {
  const { sql } = latest(/FUNCTION\s+(?:public\.)?fn_union_rake_rollup_catchup\s*\(/i);
  const fn = functionBody(sql, 'fn_union_rake_rollup_catchup');

  it('stops starting new days on a budget measured from statement start', () => {
    expect(fn).toMatch(
      /clock_timestamp\(\)\s*-\s*statement_timestamp\(\)\s*>\s*interval\s*'\d+ seconds'/i
    );
  });
});
