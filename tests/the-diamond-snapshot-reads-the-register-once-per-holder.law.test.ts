/**
 * THE DIAMOND SNAPSHOT READS THE REGISTER ONCE PER HOLDER (2026-10-04).
 *
 * Pinned on migration 20261004231413. Three critical "Trial balance is
 * incomplete ... unknown" incidents (2026-10-01 16:35 and 17:35 UTC,
 * 2026-10-03 19:35 UTC) had one cause: the hourly Diamond snapshot the trial
 * balance measures from was never stored. On 2026-10-01 17:10 the snapshot's
 * first statement was cancelled at the 120 s statement timeout inside
 * fn_ca_is_fixture_account, which that statement called once per ledger ROW
 * (209,249 calls, 93% of its buffer reads) to keep 23 rows.
 *
 * The cause is pinned here, not the symptom:
 *   1. neither Diamond book may put the fixture question to a ledger row;
 *      the register is netted per holder in one pass and each holder is asked
 *      once, inside the same statement as the balances;
 *   2. the trial balance measures from the newest earlier snapshot when none
 *      is inside its window, for every caller, and still reads unknown when
 *      there is no snapshot at all;
 *   3. the fix is not a schedule, a retry, a backfill or a quieter alarm.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const sql = readFileSync(
  resolve(
    process.cwd(),
    'supabase/migrations/20261004231413_the_diamond_snapshot_reads_the_register_once_per_holder.sql'
  ),
  'utf8'
);

/** Everything the migration executes: the file without its `--` comment lines. */
const executed = sql
  .split('\n')
  .filter((line) => !/^--/.test(line))
  .join('\n');

/** The dollar-quoted members of the nth `ARRAY[$tag$...$tag$, ...]` for a tag. */
function quoted(tag: 'o' | 'n'): string[] {
  const re = new RegExp(`\\$${tag}\\$([\\s\\S]*?)\\$${tag}\\$`, 'g');
  return [...executed.matchAll(re)].map((m) => m[1]);
}

const anchors = quoted('o');
const replacements = quoted('n');
const PER_ROW = 'public.fn_ca_is_fixture_account(m.holder_id)';
const PER_HOLDER = 'public.fn_ca_is_fixture_account(g.holder_id)';

describe('the diamond snapshot reads the register once per holder', () => {
  it('is one transaction that edits only the two pinned function texts', () => {
    expect(sql).toMatch(/^BEGIN;$/m);
    expect(sql.trim().endsWith('COMMIT;')).toBe(true);
    expect(sql).toMatch(/^SET LOCAL lock_timeout = '3s';$/m);
    expect(sql).toMatch(/^-- @live-proof: /m);
    expect(sql).toContain(
      "'public.fn_ca_diamond_snapshot()',\n  'd4b4d63f74f302ab55e426f2ffb4556c', '2419d7a9c757d9a0135b8fec75edd2c8',"
    );
    expect(sql).toContain(
      "'public.fn_ca_diamond_trial_balance(timestamp with time zone)',\n  'f744e044e7575283be20f73cd1f2f7d5', '70f9022bd9944863dd7390f03e869c8b',"
    );
    expect(executed).not.toMatch(/CREATE OR REPLACE FUNCTION public\./);
    expect(anchors).toHaveLength(5);
    expect(replacements).toHaveLength(5);
  });

  it('removes every per-row fixture test from the register reads', () => {
    // Both books carried it: one anchor in the snapshot, one in the trial balance.
    expect(anchors.filter((a) => a.includes(PER_ROW))).toHaveLength(2);
    for (const r of replacements) {
      expect(r).not.toContain(PER_ROW);
      // No replacement may filter the ledger itself by a per-row function call.
      expect(r).not.toMatch(/FROM public\.ca_mint_ledger[^;]*?fn_ca_is_fixture_account\(/);
    }
    expect(executed).toContain("position('fn_ca_is_fixture_account(m.holder_id)' IN v_snap) > 0");
  });

  it('nets the register per holder in the same statement and asks each holder once', () => {
    const ctes = replacements.filter((r) => r.includes('WITH reg AS MATERIALIZED ('));
    expect(ctes).toHaveLength(2);
    for (const c of ctes) {
      expect(c).toMatch(
        /GROUP BY (m\.holder_type, )?m\.holder_id\)\n {2}SELECT \(SELECT COALESCE\(/i
      );
      expect(c).toContain("m.asset = 'diamonds'");
    }
    // The fixture figure is still measured by the one definition of a fixture.
    expect(replacements.filter((r) => r.includes(`FROM reg g WHERE ${PER_HOLDER}`))).toHaveLength(
      1
    );
    expect(
      replacements.filter((r) =>
        r.includes(`FROM reg g WHERE g.holder_type = 'player' AND ${PER_HOLDER}`)
      )
    ).toHaveLength(1);
    // fn_ca_mint_supply stays the one definition of the register total.
    expect(anchors.join('')).not.toContain('fn_ca_mint_supply');
  });

  it('refuses to replace anything unless the new reads equal the old on the live register', () => {
    const same = executed.match(/DO \$same\$([\s\S]*?)\$same\$;/);
    expect(same).not.toBeNull();
    const body = (same as RegExpMatchArray)[1];
    expect(body).toContain(PER_ROW);
    expect(body).toContain(PER_HOLDER);
    expect(body).toMatch(/r\.old_players IS DISTINCT FROM r\.new_players/);
    expect(body).toMatch(/r\.old_fixtures IS DISTINCT FROM r\.new_fixtures/);
    expect(body).toMatch(/r\.old_house IS DISTINCT FROM r\.new_house/);
    expect(body).toContain('RAISE EXCEPTION');
    expect(executed.indexOf('DO $same$')).toBeLessThan(
      executed.indexOf('SELECT pg_temp.ca_audit_subst(')
    );
  });

  it('measures from the newest earlier snapshot when none is inside the window', () => {
    const reach = replacements.find((r) => r.includes('IF s0.id IS NULL THEN'));
    expect(reach).toBeDefined();
    expect(reach).toMatch(
      /WHERE taken_at >= v_since ORDER BY taken_at ASC LIMIT 1;[\s\S]*IF s0\.id IS NULL THEN\n\s+SELECT \* INTO s0 FROM public\.ca_diamond_snapshots WHERE taken_at < v_since ORDER BY taken_at DESC LIMIT 1;\n\s+END IF;\n\s+w0 := COALESCE\(s0\.taken_at, v_since\);/
    );
    // "No snapshot at all" keeps its own name: the NULL branch is not touched.
    expect(anchors.join('')).not.toContain('no diamond snapshot at or after the window start');
    expect(replacements.join('')).not.toContain('COALESCE(v_diff, 0)');
  });

  it('is a fix to the statement, not a schedule, a retry, a repair or a quieter alarm', () => {
    expect(executed).not.toMatch(/cron\.(schedule|alter_job|unschedule)/);
    expect(executed).not.toMatch(/CREATE (UNIQUE )?INDEX/i);
    expect(executed).not.toMatch(/INSERT INTO public\.ca_diamond_snapshots/);
    expect(executed).not.toMatch(/UPDATE public\.ca_diamond_incidents/);
    expect(executed).not.toMatch(/statement_timeout\s*(=|TO)\s*'?0/i);
    expect(executed).not.toMatch(/fn_ca_diamond_health_watch|'warning'/);
    expect(executed).toContain(
      "PERFORM public.fn_ca_declare_guard_redefinition('fn_ca_diamond_snapshot',"
    );
  });
});
