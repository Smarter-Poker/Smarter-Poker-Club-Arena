/**
 * A CLUB STAYS DELETABLE, SO A FIXTURE CAN NEVER BE STRANDED WITH ITS CHIPS.
 *
 * 2026-09-03, Dan: "WE SHOULDN'T NEED THOSE DETECTORS OR WATCH DOGS IF YOU FIX
 * THIS ALL AND MAKE IT SO ITS IMPOSSIBLE TO EVER LOSE A CHIP, OR NOT HAVE EVERY
 * SINGLE CHIP ACCOUNTED FOR AND ACCOUNTABLE. THATS THE GOAL!"
 *
 * Migration 20260903230339 built fn_ca_retire_certification_club and taught the
 * certification to fail loudly if a fixture survived. At 23:33 UTC the
 * certification ran on that exact build and reported:
 *
 *   PASS Custom And Placeholder Club Creation Certified For 89e03439..., 7abc31e6...
 *   Fixture Cleanup Failed For 89e03439...: canceling statement due to statement timeout
 *   Fixture Cleanup Failed For 7abc31e6...: canceling statement due to statement timeout
 *   Error: Certification leaked 2 fixture club(s) into Club Arena
 *
 * The guard was right and the cleanup was impossible. public.clubs has seventy
 * foreign keys; a DELETE checks every one, and a check with no usable index is a
 * sequential scan. EXPLAIN (ANALYZE) named the bill: rake_records 1,287ms,
 * table_seats 74ms, and game_management_events with no club_id index at all
 * across 867,780 rows. Two of the seven gaps LOOKED indexed -
 * idx_rake_records_club_created and idx_table_seats_club_active both lead on
 * club_id - but both are PARTIAL, and a partial index cannot answer a foreign key
 * check because the check must find the rows the predicate hides.
 *
 * Also proved and discarded here, so nobody spends the hour again: giving the
 * function `SET statement_timeout` does not work. PostgreSQL arms the timeout
 * when the statement starts and a SET inside the function does not re-arm it. A
 * probe declared '30s', sleeping 6s, under a 3s session timeout, was cancelled at
 * 3s. The work has to fit the budget.
 *
 * After the thirteen indexes, through the same PostgREST door as the same
 * service_role the certification uses: 2.43s and 2.58s, both 200 OK, 100,000.00
 * retired each, clubs back to the four estates Dan named.
 *
 * The rules this pins:
 *
 *   - every single-column foreign key into clubs has an index that can answer it,
 *     and trusted default-branch code asks production after every successful
 *     publish rather than handing production credentials to pull-request code;
 *   - "has an index" means valid, non-partial, and leading on the referencing
 *     column, because the other definition is the one that was already wrong;
 *   - the question is a read-only RPC, service_role only, that nothing schedules;
 *   - the migration that closed the gaps says IF NOT EXISTS, because the two large
 *     indexes were built CONCURRENTLY against production and a plain build of
 *     game_management_events blocks writes for 25 seconds.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { resolve } from 'path';

const DIR = resolve(__dirname, '..', 'supabase/migrations');
function read(fragment: string): string {
  const f = readdirSync(DIR)
    .filter((x) => x.includes(fragment))
    .sort()
    .pop();
  expect(f, `the migration containing "${fragment}" is missing`).toBeTruthy();
  return readFileSync(resolve(DIR, f as string), 'utf8');
}
const INDEXES = read('a_club_cannot_be_deleted_in_time');
const GAPS = read('the_repo_can_ask_production_whether_a_club_is_still_deletable');
const GATE = readFileSync(resolve(__dirname, '..', 'scripts/ci/check-club-fk-indexes.mjs'), 'utf8');
const POST_DEPLOY = readFileSync(
  resolve(__dirname, '..', '.github/workflows/post-deploy-e2e.yml'),
  'utf8'
);

const CLOSED: Array<[string, string]> = [
  ['idx_game_management_events_club_id', 'public.game_management_events'],
  ['idx_club_join_idempotency_club_id', 'public.club_join_idempotency'],
  ['idx_ad_placement_club_id', 'public.ad_placement'],
  ['idx_ca_supply_snapshot_classifications_club_id', 'public.ca_supply_snapshot_classifications'],
  ['idx_club_opening_setup_funding_club_id', 'public.club_opening_setup_funding'],
  ['idx_club_message_dismissals_club_id', 'public.club_message_dismissals'],
  ['idx_rake_records_club_id_fk', 'public.rake_records'],
  ['idx_table_seats_club_id_fk', 'public.table_seats'],
  ['idx_settlement_locks_club_id_fk', 'public.settlement_locks'],
  ['idx_blacklists_club_id_fk', 'public.blacklists'],
  ['idx_commission_rate_audit_club_id_fk', 'public.commission_rate_audit'],
  ['idx_ad_advertiser_club_id_fk', 'public.ad_advertiser'],
  ['idx_game_ticker_settings_club_id_fk', 'public.game_ticker_settings'],
];

describe('a club stays deletable', () => {
  it('keeps the Diamond bonus club foreign key fully indexed within bounded DDL', () => {
    const sql = read('diamond_bonus_club_foreign_key_is_indexed');
    const statements = sql.replace(/--[^\n]*/g, '').trim();
    expect(statements).toMatch(/^BEGIN;[\s\S]*COMMIT;$/);
    expect(statements).toContain("SET LOCAL lock_timeout = '1s';");
    expect(statements).toContain("SET LOCAL statement_timeout = '5s';");
    expect(statements.match(/CREATE INDEX[^;]*;/g)).toEqual([
      expect.stringMatching(
        /^CREATE INDEX IF NOT EXISTS idx_diamond_bonus_entries_club_id_fk\s+ON public\.diamond_bonus_entries \(club_id\);$/
      ),
    ]);
    expect(statements).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP)\b/);
  });

  it('closes every foreign key gap that made the delete slow', () => {
    for (const [name, table] of CLOSED) {
      expect(INDEXES, `${name} is missing`).toContain(name);
      expect(INDEXES).toContain(`ON ${table} (club_id)`);
    }
    expect(CLOSED.length).toBe(13);
  });

  it('creates them idempotently, because the big two were built concurrently on production', () => {
    const creates = INDEXES.match(/CREATE INDEX[^;]*;/g) || [];
    expect(creates.length).toBe(13);
    for (const c of creates) expect(c).toContain('IF NOT EXISTS');
    // A plain CREATE INDEX inside a migration transaction takes a SHARE lock.
    // game_management_events took 25 seconds to build; that is 25 seconds the
    // engine cannot write an event. Never reintroduce a bare build here.
    expect(INDEXES).not.toMatch(/CREATE INDEX(?! IF NOT EXISTS)/);
  });

  it('records why an index that leads on club_id can still be useless', () => {
    expect(INDEXES).toContain('partial');
    expect(INDEXES).toContain('idx_rake_records_club_created');
    expect(INDEXES).toContain('idx_table_seats_club_active');
  });

  it('refuses the migration if any single-column key into clubs is unanswerable', () => {
    expect(INDEXES).toContain('CLUB_FK_INDEXES:');
    expect(INDEXES).toMatch(/RAISE EXCEPTION\s*\n?\s*'CLUB_FK_INDEXES:/);
    // The three conditions that make an index able to answer a key.
    expect(INDEXES).toContain('i.indisvalid');
    expect(INDEXES).toContain('i.indpred IS NULL');
    expect(INDEXES).toContain('i.indkey[0] = f.attnum');
  });

  it('asks the same three conditions from the RPC the repo calls', () => {
    expect(GAPS).toContain('CREATE OR REPLACE FUNCTION public.fn_ca_fk_index_gaps');
    expect(GAPS).toContain('i.indisvalid');
    expect(GAPS).toContain('i.indpred IS NULL');
    expect(GAPS).toContain('i.indkey[0] = f.attnum');
  });

  it('keeps the question read-only, unscheduled, and out of the browser', () => {
    expect(GAPS).toMatch(/LANGUAGE sql\s+STABLE\s+SECURITY DEFINER/);
    expect(GAPS).toMatch(
      /REVOKE ALL ON FUNCTION public\.fn_ca_fk_index_gaps\(text\) FROM PUBLIC, anon, authenticated;/
    );
    expect(GAPS).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.fn_ca_fk_index_gaps\(text\)\s*TO service_role;/
    );
    // Dan: "NOT TO HAVE WATCH DOGS AND CRONS RUNNING ALL OVER THE PLACE."
    expect(GAPS).not.toContain('cron.schedule');
    expect(GAPS).not.toContain('fn_ca_raise_drift_incident');
  });

  it('is asked read-only after every successful publish from trusted default-branch code', () => {
    expect(GATE).toContain('fn_ca_fk_index_gaps');
    expect(GATE).toContain("const PARENTS = ['public.clubs']");
    expect(GATE).toContain('process.exit(1)');
    expect(GATE).toContain('SUPABASE_SERVICE_ROLE_KEY');
    expect(POST_DEPLOY).toContain("workflows: ['Publish Club Arena']");
    expect(POST_DEPLOY).toContain('node scripts/ci/check-club-fk-indexes.mjs');
    const liveSchemaStep = POST_DEPLOY.slice(
      POST_DEPLOY.indexOf('- name: Prove every club foreign key remains deletable'),
      POST_DEPLOY.indexOf('- name: Audit the remaining live schema from trusted code')
    );
    expect(liveSchemaStep).not.toMatch(/^\s*if:/m);
    expect(liveSchemaStep).toContain('node scripts/ci/check-club-fk-indexes.mjs');
    expect(POST_DEPLOY.indexOf('node scripts/ci/check-club-fk-indexes.mjs')).toBeLessThan(
      POST_DEPLOY.indexOf('node scripts/ci/check-phantom-tables.mjs')
    );
  });

  it('refuses malformed RPC data instead of translating it to zero gaps', () => {
    expect(GATE).toContain("keys.join(',') === 'checked_at,gaps,parent'");
    expect(GATE).toContain('answer.parent === parent');
    expect(GATE).toContain('Array.isArray(answer.gaps)');
    expect(GATE).not.toContain('answer.gaps || []');
  });
});
