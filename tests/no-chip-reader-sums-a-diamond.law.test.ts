/**
 * NO CHIP READER SUMS A DIAMOND INTO A CHIP FIGURE.
 *
 * Dan's ruling 16 is that the Diamond Arena has no chip wallets and no chip
 * ledgers. The quiet way to break it is not to write a chip row for a Diamond:
 * it is to ADD a Diamond to a chip total in a reader, where no row is written
 * and nothing refuses, and the number that comes out is of nothing at all. A
 * prior lane proved that in the per-hand facts, where 250 chips and 7 diamonds
 * summed to 257.00 (`tests/sql/run-diamond-stats-asset-dimension.py`).
 *
 * Step 0 of the destinations design fixed the hourly chip supply METER,
 * `fn_ca_supply_snapshot`, for exactly that reason, in migration
 * `20260929160000_the_chip_legs_refuse_a_diamond_row`. Three readers that
 * measure the same two pools were not fixed, and one of them decides whether
 * the platform freeze conserved:
 *
 *   fn_ca_circulation_total    member wallets + every live seat's stack. Two
 *                              active crons write it into
 *                              ca_freeze_circulation_marks at :55 and :00, and
 *                              fn_ca_record_break_scorecard subtracts the pre
 *                              total from the post total and decides
 *                              v_conserved against a CHIP tolerance.
 *   fn_snapshot_chip_supply    the same pools into chip_supply_snapshots, and
 *                              on into unexplained_delta.
 *   fn_club_chip_circulation   a diamonds club's Diamond felt under a chip
 *                              total.
 *
 * All three exclude a KNOWN diamonds pool now. Only what is known Diamond is
 * excluded, so an orphan seat or membership is counted exactly as before, and
 * the Diamond is not lost by leaving the chip books: its custody row is inside
 * `fn_ca_arena_diamonds()`, which the Diamond identity closes on.
 *
 * Proof that executes:
 * `tests/sql/run-diamond-cross-format-conservation.py` loads the six readers in
 * production's own text, md5-pinned, reproduces each defect, applies the
 * migration file verbatim and proves the figures afterwards, then walks one
 * Diamond through every format the arena deals.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..');
const MIGRATIONS = join(ROOT, 'supabase', 'migrations');
const files = readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith('.sql'))
  .sort();
const migration = (needle: string) => {
  const f = files.find((x) => x.includes(needle));
  if (!f) throw new Error(`no migration matching ${needle}`);
  return readFileSync(join(MIGRATIONS, f), 'utf8');
};
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const code = (sql: string) => sql.replace(/--[^\n]*/g, '');

const SQL = migration('the_chip_circulation_marks_count_no_diamond');
const BODY = code(SQL);

describe('no chip reader sums a Diamond into a chip figure', () => {
  it('changes exactly the three readers that measure the two mixed pools', () => {
    for (const sig of [
      "to_regprocedure('public.fn_ca_circulation_total()')",
      "to_regprocedure('public.fn_snapshot_chip_supply()')",
      "to_regprocedure('public.fn_club_chip_circulation(uuid)')",
    ]) {
      expect(BODY, `${sig} is not redefined`).toContain(sig);
    }
  });

  it('pins the live text of each one and proves the reverse substitution', () => {
    for (const md5 of [
      'f4a6ddceec4e02cffd220c0db26d1019',
      '450da5111403dde7283f46499ad8ef8a',
      'f71a1a5f26ffc70cc639777b232635cd',
    ]) {
      /* Once to refuse a drifted function, once to prove the edit is only the
         edit. A single occurrence means one half of that is missing. */
      expect(BODY.split(md5).length - 1, `${md5} is not pinned twice`).toBe(2);
    }
    expect(BODY).toContain('the reverse substitution does not reproduce the pinned text');
  });

  it('excludes only what is KNOWN to be a diamonds pool, never an unknown one', () => {
    /* A join would drop a seat whose table row is missing, or a membership
       whose club row is missing, and those are chips today. NOT EXISTS keeps
       them. clubs.asset is NOT NULL and CHECKed, so there is no third value. */
    expect(BODY).toContain("dc.id = cm.club_id AND dc.asset = ''diamonds''");
    expect(BODY).toContain("dt.id = table_seats.table_id AND dc.asset = ''diamonds''");
    expect(BODY).toContain("dc.id = t.club_id AND dc.asset = ''diamonds''");
  });

  it('refuses to apply over a Diamond seat that is already live', () => {
    /* Applied after the first Diamond seat, the change would itself show as a
       step in table_stacks and a one-off unexplained_delta, and the chip
       figures already published would already be wrong. That is a leak to
       report, not to hide inside a definition change. */
    expect(BODY).toContain('a live Diamond seat already exists');
  });

  it('asserts that no chip figure moves, rather than asserting it in prose', () => {
    expect(BODY).toContain('the chip member wallet total moved');
    expect(BODY).toContain('the chip felt total moved');
    expect(BODY).toContain('the chip supply measurement moved');
    expect(BODY).toContain('the chip circulation report lost or gained a chip club');
  });

  it('never weakens the arena switches or the Diamond identity', () => {
    expect(BODY).toContain('this migration must not open an arena door');
    expect(BODY).toContain('the Diamond identity is not whole');
    expect(BODY).toContain('watched guards off their baseline');
    /* And it never reaches for the switches themselves. */
    expect(BODY).not.toMatch(/UPDATE\s+public\.ca_arena_settings/i);
    expect(BODY).not.toMatch(/(cash_games_enabled|tournaments_enabled)\s*=\s*true/i);
  });

  it('keeps the three readers off anon and authenticated', () => {
    expect(BODY).toContain("has_function_privilege('anon', r.oid, 'EXECUTE')");
    expect(BODY).toContain("has_function_privilege('authenticated', r.oid, 'EXECUTE')");
    expect(BODY).not.toMatch(/GRANT\s+EXECUTE[\s\S]{0,120}(anon|authenticated)/i);
  });

  it('is a definition change and not a sweep, a backfill or a cron', () => {
    /* CLAUDE.md 10.11 and 10.12: the lines that produced the wrong figure are
       what change. Nothing repairs a row after the fact. */
    expect(BODY).not.toMatch(/cron\.(schedule|job)/i);
    expect(BODY).not.toMatch(/fn_[a-z_]*(repair|backpay|sweep|redrive|catchup|heal)[a-z_]*/i);
    expect(BODY).not.toMatch(/UPDATE\s+public\.(chip_supply_snapshots|ca_freeze_circulation_marks)/i);
    expect(BODY).not.toMatch(/DELETE\s+FROM\s+public\.(chip_supply_snapshots|ca_freeze_circulation_marks)/i);
  });

  it('has a runner that reproduces the defect before it proves the fix', () => {
    const runner = read('tests/sql/run-diamond-cross-format-conservation.py');
    /* A regression that only ever passes proves nothing about the bug it
       claims to fix, so the BEFORE cases have to be there and have to pass on
       the installed text. */
    for (const needle of [
      'reproduced - 900 chips and 7 diamonds on the felt summed to 907.00 in the freeze mark',
      'makes the break verdict say chips did not conserve',
      'UNEXPLAINED CHIP supply',
      'the chip circulation report gives the Diamond Arena a chip total of 7.00',
    ]) {
      expect(runner, `the runner does not reproduce: ${needle}`).toContain(needle);
    }
    /* And the runner applies THIS FILE, not a copy of its intent. */
    expect(runner).toContain('20261004124546_the_chip_circulation_marks_count_no_diamond.sql');
    expect(runner).toContain('psql_file(MIGRATION');
  });

  it('loads the readers from production text and pins every one of them', () => {
    const manifest = JSON.parse(
      read('tests/sql/diamond-cross-format-conservation-doors.manifest.json')
    );
    const doors = read('tests/sql/poker-diamond-cross-format-conservation-doors.sql');
    expect(Object.keys(manifest.pins)).toHaveLength(6);
    for (const [sig, md5] of Object.entries(manifest.pins)) {
      const name = sig.replace(/^public\./, '').replace(/\(.*$/, '');
      expect(doors, `${sig} is not in the doors fixture`).toContain(
        `CREATE OR REPLACE FUNCTION public.${name}(`
      );
      expect(String(md5)).toMatch(/^[0-9a-f]{32}$/);
    }
    /* The three the migration changes are pinned at the same md5 in both
       places, so the fixture and the migration can never disagree about what
       production runs. */
    for (const sig of manifest.changed_by_the_migration) {
      expect(BODY).toContain(String(manifest.pins[sig]));
    }
  });

  it('never opens a switch from the fixture, and says both are closed at the end', () => {
    const runner = read('tests/sql/run-diamond-cross-format-conservation.py');
    const schema = read('tests/sql/poker-diamond-cross-format-conservation-schema.sql');
    for (const text of [runner, schema]) {
      expect(text).not.toMatch(/(cash_games_enabled|tournaments_enabled)\s*=\s*true/i);
    }
    expect(runner).toContain('both arena switches are still closed');
  });
});
