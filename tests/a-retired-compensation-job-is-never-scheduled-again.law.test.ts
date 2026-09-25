/**
 * ===========================================================================
 *  LAW: A RETIRED COMPENSATION JOB IS NEVER SCHEDULED AGAIN
 * ===========================================================================
 *
 * Owner policy v2.9: never add or rely on a cron, watcher, reconciler or
 * repair loop to compensate for a defect. CLAUDE.md 10.12: such a job is
 * DEBT, and deleting it is part of the fix.
 *
 * Three migrations have retired fifteen of them, each because the writer it
 * compensated for is correct at its source, its candidate set was empty, and
 * it had done no work for days:
 *
 *   20260920070402_three_watchers_whose_defects_were_fixed_stop_running
 *     union-seat-provenance-heal, ca-bbj-repair-unbanked-15m,
 *     reconcile-club-table-counts-nightly
 *   20260922155223_eleven_compensation_jobs_whose_writers_are_correct_stop_running
 *     ca-redrive-unbanked-rake-15m, rake-repair-unbanked-hourly,
 *     ca-union-rake-attribution-hourly, ca-bounty-backpay-hourly,
 *     ca-payout-sweep-hourly, spin_repair_missing_multiplier,
 *     spin_sweep_unbooked, ca-spin-return-unawarded-draws-15m,
 *     ca-promo-accrual-retry-10m, ca-post-commit-orphan-drain-10m,
 *     ca-pgrst-reload-if-stale
 *
 * WHY A LAW. Every function those jobs ran is still defined, and several are
 * still reached some other way (each migration's header says which, and by
 * what). So bringing a job back is one scheduling call in one migration, and
 * nothing else in this repository would object at review time:
 *
 *   - the band-aid gate judges a job by the words in its name, and seven of
 *     these names carry none of them (a sweep, a drain, a return, a reload);
 *   - its periodic-work rule is satisfied by one comment line;
 *   - the roster law reads a file, not the migrations, so it sees a returned
 *     job only after production runs it and Cron Health's next pass rewrites
 *     the roster.
 *
 * WHAT THIS PINS
 *
 *   1. Each retiring migration unschedules the names it retires, in code, and
 *      schedules nothing itself.
 *   2. THE ONE THAT MATTERS LATER: no migration after a retirement schedules
 *      a retired name again (cron.schedule or cron.schedule_in_database, by
 *      position or by job_name =>, or a row inserted into cron.job), and none
 *      schedules a command that calls a function the retired jobs ran - the
 *      same compensation under a new name. fn_tournament_payout_sweep is the
 *      one exception, and only in detect mode: tourney_payout_sweep_detect_daily
 *      is an observer that is kept, and it runs the sweep with p_apply false.
 *   3. The scheduled-work roster lists none of the retired names.
 *   4. The detector is live against the shapes it refuses and allows.
 *
 * NOTE ON ASSERTING THE NEGATIVE (CLAUDE.md 7.3): every retiring migration
 * quotes the names it retires, and so will whatever explains why one must not
 * come back. Calls are therefore located in a copy of the SQL with comments
 * and literals blanked, and their arguments are read, at the same offsets,
 * from a copy with only comments blanked.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MIGRATIONS_DIR, migrationNames } from './helpers/migrationCorpus';

const ROOT = join(__dirname, '..');
const ROSTER = join(ROOT, 'docs', 'attestation', 'cron-roster.tsv');

interface Retirement {
  /** The migration that unscheduled them. Everything sorted after it is bound. */
  migration: string;
  /** The job names it retired. */
  jobs: readonly string[];
  /** What those jobs ran. A schedule that calls one of these is the same job back. */
  functions: readonly string[];
}

const RETIREMENTS: readonly Retirement[] = [
  {
    migration: '20260920070402_three_watchers_whose_defects_were_fixed_stop_running.sql',
    jobs: [
      'union-seat-provenance-heal',
      'ca-bbj-repair-unbanked-15m',
      'reconcile-club-table-counts-nightly',
    ],
    // fn_bbj_repair_unbanked is still called by fn_ca_auto_reconcile_tick when
    // a drift incident is open. That is a call from inside a function, which
    // this law does not refuse; a schedule of its own is the retired job.
    functions: [
      'fn_heal_seat_provenance',
      'fn_bbj_repair_unbanked',
      'fn_reconcile_club_table_counts',
    ],
  },
  {
    migration: '20260922155223_eleven_compensation_jobs_whose_writers_are_correct_stop_running.sql',
    jobs: [
      'ca-redrive-unbanked-rake-15m',
      'rake-repair-unbanked-hourly',
      'ca-union-rake-attribution-hourly',
      'ca-bounty-backpay-hourly',
      'ca-payout-sweep-hourly',
      'spin_repair_missing_multiplier',
      'spin_sweep_unbooked',
      'ca-spin-return-unawarded-draws-15m',
      'ca-promo-accrual-retry-10m',
      'ca-post-commit-orphan-drain-10m',
      'ca-pgrst-reload-if-stale',
    ],
    // fn_redrive_unbanked_rake was reached by fn_ca_auto_reconcile_tick until
    // the migration below retired that job too, so no timer reaches it now;
    // fn_spin_sweep_unbooked (and through it fn_spin_repair_missing_multiplier)
    // by a World Hub route. Neither is a schedule in this database.
    functions: [
      'fn_redrive_unbanked_rake',
      'fn_rake_repair_unbanked',
      'fn_ca_attribute_union_rake',
      'fn_backpay_unfinalised_bounty_pools',
      'fn_spin_repair_missing_multiplier',
      'fn_spin_sweep_unbooked',
      'fn_ca_return_unawarded_spin_draws',
      'fn_ca_retry_promo_accruals',
      'fn_ca_drain_orphaned_post_commit_envelopes',
      'fn_ca_pgrst_reload_if_stale',
    ],
  },
  {
    migration: '20260924025037_the_incident_tick_that_repairs_nothing_stops_running.sql',
    jobs: ['ca-auto-reconcile-tick'],
    // fn_ca_auto_reconcile_tick stays defined, and so do the two repair paths
    // it reached, fn_redrive_unbanked_rake and fn_bbj_repair_unbanked. After
    // this retirement nothing on a timer reaches any of them; that migration
    // asserts it rather than assuming it.
    functions: ['fn_ca_auto_reconcile_tick', 'fn_bbj_repair_unbanked'],
  },
];

/** ca-payout-sweep-hourly ran this with p_apply = true; the kept observer runs it with false. */
const APPLYING_PAYOUT_SWEEP =
  /\bfn_tournament_payout_sweep\s*\(\s*[^,()]*,\s*true\b|\bfn_tournament_payout_sweep\s*\([^)]*\bp_apply\s*=>\s*true\b/i;

const ALL_RETIRED_JOBS = RETIREMENTS.flatMap((r) => r.jobs);

const read = (file: string): string => readFileSync(join(MIGRATIONS_DIR, file), 'utf8');

/** A dollar-quote tag at the cursor, such as $$ or $job$. Never a parameter like $1. */
const DOLLAR_TAG = /\$[A-Za-z_]*\$/y;

/**
 * Blank SQL comments (line and nested block) always, and single-quoted
 * literals when `literals` is true. Offsets and newlines are preserved, so an
 * index found in one copy is valid in the other.
 *
 * A dollar-quoted body is scanned as code, recursively and only up to its own
 * closing tag: a DO body and a scheduled command are both code here, and a
 * line comment inside one ends at the tag, never past it.
 */
const blankSql = (sql: string, literals: boolean): string => {
  const out = sql.split('');
  const n = sql.length;
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to && k < n; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  let i = 0;
  while (i < n) {
    if (sql[i] === '$' && !/[A-Za-z0-9_]/.test(sql[i - 1] ?? '')) {
      DOLLAR_TAG.lastIndex = i;
      const tag = DOLLAR_TAG.exec(sql)?.[0];
      if (tag) {
        const bodyStart = i + tag.length;
        const close = sql.indexOf(tag, bodyStart);
        const bodyEnd = close < 0 ? n : close;
        const inner = blankSql(sql.substring(bodyStart, bodyEnd), literals);
        for (let k = 0; k < inner.length; k++) out[bodyStart + k] = inner[k];
        i = close < 0 ? n : close + tag.length;
        continue;
      }
    }
    if (sql.startsWith('--', i)) {
      const nl = sql.indexOf('\n', i);
      const to = nl < 0 ? n : nl;
      blank(i, to);
      i = to;
      continue;
    }
    if (sql.startsWith('/*', i)) {
      let depth = 0;
      let j = i;
      while (j < n) {
        if (sql.startsWith('/*', j)) {
          depth++;
          j += 2;
        } else if (sql.startsWith('*/', j)) {
          depth--;
          j += 2;
          if (depth === 0) break;
        } else j++;
      }
      blank(i, j);
      i = j;
      continue;
    }
    if (sql[i] === "'") {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === "'" && sql[j + 1] === "'") {
          j += 2;
          continue;
        }
        if (sql[j] === "'") {
          j++;
          break;
        }
        j++;
      }
      if (literals) blank(i, j);
      i = j;
      continue;
    }
    i++;
  }
  return out.join('');
};

/** The first single-quoted literal at the start of `text`, unescaped, or null. */
const leadingLiteral = (text: string): string | null => {
  const m = /^\s*'((?:[^']|'')*)'/.exec(text);
  return m ? m[1].replace(/''/g, "'") : null;
};

/** One place a migration asks pg_cron for a job, and the name it asks for. */
interface Scheduling {
  name: string | null;
  text: string;
}

const schedulingsIn = (sql: string): Scheduling[] => {
  const code = blankSql(sql, true);
  const values = blankSql(sql, false);
  const found: Scheduling[] = [];

  for (const m of code.matchAll(/\bcron\s*\.\s*schedule(?:_in_database)?\s*\(/gi)) {
    const at = m.index ?? 0;
    const open = at + m[0].length - 1;
    let depth = 0;
    let close = code.length;
    for (let k = open; k < code.length; k++) {
      if (code[k] === '(') depth++;
      else if (code[k] === ')') {
        depth--;
        if (depth === 0) {
          close = k;
          break;
        }
      }
    }
    const args = values.substring(open + 1, close);
    const named = /\bjob_name\s*=>\s*'((?:[^']|'')*)'/i.exec(args);
    found.push({
      name: named ? named[1].replace(/''/g, "'") : leadingLiteral(args),
      text: values.substring(at, close + 1),
    });
  }

  for (const m of code.matchAll(/\binsert\s+into\s+cron\s*\.\s*job\b/gi)) {
    const at = m.index ?? 0;
    const end = code.indexOf(';', at);
    found.push({ name: null, text: values.substring(at, end < 0 ? values.length : end + 1) });
  }
  return found;
};

/** Everything in `sql` that brings back a job `retirement` retired. */
const returnsIn = (sql: string, retirement: Retirement): string[] => {
  const problems: string[] = [];
  const jobs = new Set(retirement.jobs.map((j) => j.toLowerCase()));
  for (const s of schedulingsIn(sql)) {
    const flat = s.text.replace(/\s+/g, ' ').trim();
    if (s.name !== null && jobs.has(s.name.toLowerCase())) {
      problems.push(`schedules the retired job ${s.name}: ${flat}`);
      continue;
    }
    const inserted =
      s.name === null ? retirement.jobs.find((j) => s.text.includes(`'${j}'`)) : undefined;
    if (inserted) {
      problems.push(`writes the retired job ${inserted} into cron.job: ${flat}`);
      continue;
    }
    const fn = retirement.functions.find((f) => new RegExp(`\\b${f}\\b`, 'i').test(s.text));
    if (fn) {
      problems.push(`schedules ${fn}, which only a retired job ran: ${flat}`);
      continue;
    }
    if (APPLYING_PAYOUT_SWEEP.test(s.text)) {
      problems.push(`schedules fn_tournament_payout_sweep in apply mode: ${flat}`);
    }
  }
  return problems;
};

describe('a retired compensation job is never scheduled again', () => {
  describe('each retirement is real', () => {
    it.each(RETIREMENTS.map((r) => [r.migration, r] as const))(
      '%s unschedules what it retires, and schedules nothing',
      (_name, retirement) => {
        expect(migrationNames()).toContain(retirement.migration);
        const sql = read(retirement.migration);
        const code = blankSql(sql, false);
        expect(code).toMatch(/\bcron\s*\.\s*unschedule\s*\(/i);
        for (const job of retirement.jobs) {
          expect(code, `${job} is not in the code of ${retirement.migration}`).toContain(
            `'${job}'`
          );
        }
        expect(schedulingsIn(sql)).toEqual([]);
      }
    );

    it('the twelfth is retired on its own evidence, once its window closed', () => {
      const sql = read(RETIREMENTS[2].migration);
      const code = blankSql(sql, false);
      expect(code.trim().startsWith('BEGIN;')).toBe(true);
      expect(code.trim().endsWith('COMMIT;')).toBe(true);
      // It refuses the roster the eleven did not leave, rather than guessing.
      expect(code).toContain('v_active IS DISTINCT FROM 122 OR v_total IS DISTINCT FROM 124');
      expect(code).toContain('v_active IS DISTINCT FROM 121 OR v_total IS DISTINCT FROM 123');
      // The root cause, not the symptom: the column default it existed to rewrite.
      expect(code).toContain('manual_needed');
      // And it proves no timer is left reaching the paths it stops calling.
      expect(code).toMatch(/fn_redrive_unbanked_rake/);
      expect(code).toMatch(/fn_bbj_repair_unbanked/);
      expect(code).not.toMatch(/\bDROP\s+FUNCTION\b/i);
    });

    it('the eleven are retired together, and the migration proves it at apply time', () => {
      const sql = read(RETIREMENTS[1].migration);
      const code = blankSql(sql, false);
      expect(code.trim().startsWith('BEGIN;')).toBe(true);
      expect(code.trim().endsWith('COMMIT;')).toBe(true);
      expect(sql).toMatch(
        /^-- @live-proof: \(SELECT count\(\*\) FROM cron\.job WHERE jobname IN \(/m
      );
      // It refuses a roster another writer moved, rather than guessing.
      expect(code).toContain('v_active IS DISTINCT FROM 133 OR v_total IS DISTINCT FROM 135');
      expect(code).toContain('v_active IS DISTINCT FROM 122 OR v_total IS DISTINCT FROM 124');
      // And it drops nothing: the functions its header keeps on purpose stay.
      expect(code).not.toMatch(/\bDROP\s+FUNCTION\b/i);
    });
  });

  it('THE ONE THAT MATTERS LATER: no migration after a retirement brings a retired job back', () => {
    const offenders: string[] = [];
    const names = migrationNames();
    for (const retirement of RETIREMENTS) {
      for (const file of names.filter((f) => f > retirement.migration)) {
        for (const problem of returnsIn(read(file), retirement)) {
          offenders.push(`${file}: ${problem}`);
        }
      }
    }
    expect(
      offenders,
      'a migration schedules a compensation job that was retired because its writer ' +
        'is correct at the source. If the writer regressed, fix the writer (CLAUDE.md ' +
        '10.12); a schedule that catches up afterwards is the thing the retirement removed.'
    ).toEqual([]);
  });

  it('the scheduled-work roster lists none of the retired jobs', () => {
    const listed = readFileSync(ROSTER, 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== '' && !l.startsWith('#'))
      .map((l) => l.split('\t')[0]);
    expect(listed.filter((name) => ALL_RETIRED_JOBS.includes(name))).toEqual([]);
  });

  describe('the detector is live', () => {
    const eleven = RETIREMENTS[1];
    const three = RETIREMENTS[0];

    it('refuses a retired name, by position, by job_name and in another database', () => {
      expect(
        returnsIn(
          "SELECT cron.schedule('spin_sweep_unbooked', '*/5 * * * *', $$SELECT 1$$);",
          eleven
        )
      ).toHaveLength(1);
      expect(
        returnsIn(
          "DO $d$ BEGIN PERFORM cron.schedule(job_name => 'ca-pgrst-reload-if-stale', schedule => '*/5 * * * *', command => 'SELECT 1'); END $d$;",
          eleven
        )
      ).toHaveLength(1);
      expect(
        returnsIn(
          "SELECT cron.schedule_in_database('union-seat-provenance-heal', '*/5 * * * *', 'SELECT 1', 'postgres');",
          three
        )
      ).toHaveLength(1);
      expect(
        returnsIn(
          "INSERT INTO cron.job (schedule, command, jobname) VALUES ('*/5 * * * *', 'SELECT 1', 'ca-post-commit-orphan-drain-10m');",
          eleven
        )
      ).toHaveLength(1);
    });

    it('refuses the same compensation under a new name', () => {
      expect(
        returnsIn(
          "SELECT cron.schedule('rake-catch-up-v2', '0 * * * *', $job$SELECT public.fn_rake_repair_unbanked(6, 200)$job$);",
          eleven
        )
      ).toHaveLength(1);
      expect(
        returnsIn(
          "SELECT cron.schedule('bbj-bank-late', '*/15 * * * *', $$SELECT public.fn_bbj_repair_unbanked(3, 200)$$);",
          three
        )
      ).toHaveLength(1);
      expect(
        returnsIn(
          "SELECT cron.schedule('payouts-hourly', '52 * * * *', $$SELECT public.fn_tournament_payout_sweep(7, true, 150000)$$);",
          eleven
        )
      ).toHaveLength(1);
    });

    it('allows the observer that is kept, and work that is not a retired job', () => {
      expect(
        returnsIn(
          "SELECT cron.schedule('tourney_payout_sweep_detect_daily', '40 2 * * *', $$SELECT public.fn_tournament_payout_sweep(30, false, 150000)$$);",
          eleven
        )
      ).toEqual([]);
      expect(
        returnsIn(
          "SELECT cron.schedule('ca-auto-reconcile-tick', '* * * * *', $$SELECT public.fn_ca_auto_reconcile_tick()$$);",
          eleven
        )
      ).toEqual([]);
    });

    it('never fires on a comment, a quoted sentence, or an unschedule', () => {
      const prose = [
        "-- SELECT cron.schedule('spin_sweep_unbooked', '*/5 * * * *', $$SELECT 1$$);",
        "/* cron.schedule('ca-payout-sweep-hourly', '52 * * * *', 'SELECT 1') */",
        "DO $d$ BEGIN RAISE NOTICE 'never cron.schedule(''rake-repair-unbanked-hourly'') again'; END $d$;",
        "SELECT cron.unschedule('ca-redrive-unbanked-rake-15m');",
        "DO $d$ BEGIN\n  -- PERFORM cron.schedule('spin_sweep_unbooked', '*/5 * * * *', 'SELECT 1');\n  NULL;\nEND $d$;",
      ].join('\n');
      expect(returnsIn(prose, eleven)).toEqual([]);
    });

    it('reads a scheduled command only up to its own closing dollar quote', () => {
      // A comment inside the command must not swallow the closing tag and let
      // the call run on into the next statement, which is not part of it.
      const after =
        "SELECT cron.schedule('some-other-job', '* * * * *', $$SELECT 1 -- a note$$);\n" +
        'SELECT public.fn_spin_sweep_unbooked(60);';
      expect(returnsIn(after, eleven)).toEqual([]);
      const inside =
        "SELECT cron.schedule('some-other-job', '* * * * *', $$SELECT public.fn_spin_sweep_unbooked(60) -- a note$$);";
      expect(returnsIn(inside, eleven)).toHaveLength(1);
    });
  });
});
