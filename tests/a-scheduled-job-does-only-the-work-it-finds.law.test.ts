/**
 * ===========================================================================
 *  LAW: A SCHEDULED JOB DOES ONLY THE WORK IT FINDS
 * ===========================================================================
 *
 * Two jobs on this estate were not doing what they appeared to do, in opposite
 * directions. One did far more work than it had found, and one found nothing
 * at all while reporting itself as coverage.
 *
 * ---------------------------------------------------------------------------
 * 1. THE RECONCILER THAT REWROTE EVERY ROW (20260919213528)
 *
 * fn_reconcile_club_member_daily_profit matched its UPDATE on identity alone
 * and never asked whether the value was changing. Postgres counts an unchanged
 * row as updated, so every call rewrote every row in scope.
 *
 * MEASURED 2026-09-19: 42,094 rows genuinely in scope for one stat_date,
 * 2,820,298 rows_updated recorded for that same stat_date in one day. That is
 * 67 x 42,094 exactly, because an off-box scheduler
 * (Smarter-Poker-World-Hub/scripts/openclaw-cron-dispatcher.py line 553) calls
 * it every 15 minutes even though pg_cron schedules it once a day. The first
 * run closed a real 19,392.15 chip drift; the other 66 corrected nothing and
 * rewrote everything. Over 30 days: 10,469,974 rows_updated.
 *
 * The cost was not only writes. rows_updated is the only record of how much
 * this reconciler corrects, and at 42,094 every run it reported the size of
 * the table rather than the size of the correction.
 *
 * ---------------------------------------------------------------------------
 * 2. THE DETECTOR THAT TIMED OUT (20260919213616)
 *
 * fn_pay_backed_payout_shortfalls ran fn_tournament_conservation_delta per row
 * over every COMPLETED tournament with no time bound, under a 120s
 * statement_timeout. It failed 21 of its last 24 runs, every one at exactly
 * 120.0s. MEASURED with EXPLAIN ANALYZE: unbounded over 120,000 ms and
 * cancelled; bounded to 30 days, 21,817 ms.
 *
 * A detector that times out is worse than an absent one, because the estate
 * counts it as coverage.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS LAW PINS, AND WHY IT PINS THE SHAPE RATHER THAN THE OUTCOME
 *
 * Both fixes are one predicate each, and in both cases a plausible-looking
 * edit silently undoes them:
 *
 *   - `s.profit <> (...)` instead of IS DISTINCT FROM looks equivalent and is
 *     not: it evaluates to NULL for a NULL profit, so it would skip exactly
 *     the rows that most need the correction.
 *   - moving the time bound AFTER the delta predicate reads the same and
 *     restores the timeout, because the delta is then still computed for every
 *     row before anything can be filtered.
 *
 * So the law asserts ORDER and OPERATOR, not just presence.
 *
 * It also asserts the OTHER DIRECTION for both (CLAUDE.md 7.2): deleting the
 * UPDATE would stop the redundant writes, and deleting the delta predicate
 * would stop the timeout, and both would pass a naive presence check while
 * destroying the thing the job exists for.
 *
 * THE ONE THAT MATTERS LATER binds from 20260920: no later migration may
 * reintroduce either shape.
 *
 * NOTE ON ASSERTING THE NEGATIVE (CLAUDE.md 7.3): both migration headers quote
 * the band-aids they refuse, including the literal `<>` form, so every
 * negative assertion runs against a SQL-comment-stripped copy.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { sliceDollarQuoted } from './helpers/sourceWindow';

const MIGRATIONS = join(__dirname, '..', 'supabase', 'migrations');
const RECONCILER = '20260919213528_a_reconciler_that_changes_nothing_writes_nothing.sql';
const DETECTOR = '20260919213616_a_detector_that_times_out_is_not_watching_anything.sql';

/** The day after these fixes. Everything from here on is covered. */
const FORWARD_GUARD_FROM = '20260920';

/**
 * Return a copy of `sql` in which COMMENTS and STRING LITERALS are blanked and
 * everything else, including dollar-quoted function bodies, is left as code.
 * Length and newlines are preserved so offsets stay comparable.
 *
 * A left-to-right scanner, not a chain of regexes, because a chain gets this
 * wrong in both directions:
 *   - blanking literals first turns the apostrophe in a prose comment such as
 *     "the row's own value" into the start of a string and eats real code
 *     after it;
 *   - blanking comments first eats a legitimate '----' literal, the trap
 *     CLAUDE.md 7.3 records.
 * A scanner has neither problem: a `--` inside a literal is never reached as a
 * comment, and a quote inside a comment is never reached as a literal.
 */
const sqlCode = (sql: string): string => {
  const out = sql.split('');
  const n = sql.length;
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to && k < n; k++) {
      if (out[k] !== '\n') out[k] = ' ';
    }
  };

  let i = 0;
  while (i < n) {
    if (sql[i] === '$') {
      let j = i + 1;
      while (j < n && /[A-Za-z_]/.test(sql[j])) j++;
      if (j < n && sql[j] === '$') {
        const tag = sql.substring(i, j + 1);
        const end = sql.indexOf(tag, j + 1);
        i = end < 0 ? n : end + tag.length;
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
      blank(i, j);
      i = j;
      continue;
    }
    i++;
  }
  return out.join('');
};

const read = (file: string): string => readFileSync(join(MIGRATIONS, file), 'utf8');

describe('a scheduled job does only the work it finds', () => {
  describe('the reconciler writes only rows whose value changes', () => {
    // The $guard$ and $verify$ blocks quote these same markers while checking
    // the live body, so a whole-file read finds those copies first. Every
    // claim below is about the function, so it reads the function.
    const code = sqlCode(sliceDollarQuoted(read(RECONCILER), '$function$'));

    it('guards the UPDATE on the value actually differing', () => {
      expect(code).toContain('s.profit IS DISTINCT FROM (f.share');
    });

    it('uses IS DISTINCT FROM, never a plain inequality', () => {
      // `<>` is NULL for a NULL profit, so it would skip the rows that most
      // need the correction.
      //
      // Scoped to the FUNCTION BODY, and that scope is the point. The header
      // quotes this form while explaining why it is wrong, and the migration's
      // own $verify$ block contains the literal string while asserting the
      // function does not use it. Both are correct and neither is the rule.
      // The rule is about the UPDATE, so it reads the UPDATE.
      expect(code).not.toContain('s.profit <> ');
    });

    it('the guard is in the WHERE clause, after the SET', () => {
      const setAt = code.indexOf('SET profit = f.share');
      const guardAt = code.indexOf('s.profit IS DISTINCT FROM (f.share');
      expect(setAt).toBeGreaterThanOrEqual(0);
      expect(guardAt).toBeGreaterThan(setAt);
    });

    it('THE OTHER DIRECTION: the correction itself is still there', () => {
      // Deleting the UPDATE would also stop the redundant writes.
      expect(code).toContain(
        'SET profit = f.share + CASE WHEN f.rn = f.n_rows THEN f.remainder ELSE 0 END'
      );
      expect(code).toContain('fn_club_profit_conservation');
    });
  });

  describe('the detector bounds its candidate set before the expensive term', () => {
    // Same reason as above: the $guard$ block quotes the delta predicate.
    const code = sqlCode(sliceDollarQuoted(read(DETECTOR), '$function$'));
    // The argument list sits in the CREATE FUNCTION header, outside the body.
    const whole = sqlCode(read(DETECTOR));

    it('declares the window where a reader can argue with it', () => {
      expect(code).toContain('v_window_days');
    });

    it('the time bound precedes the per-row delta', () => {
      // If the bound moves after the delta, the delta is computed for every
      // row again and the 120s timeout returns. Order is the whole fix.
      const boundAt = code.indexOf('t.ended_at > now() - make_interval');
      const deltaAt = code.indexOf('AND public.fn_tournament_conservation_delta(t.id) > 0.01');
      expect(boundAt).toBeGreaterThanOrEqual(0);
      expect(deltaAt).toBeGreaterThan(boundAt);
    });

    it('THE OTHER DIRECTION: it still detects, and still refuses to pay', () => {
      // Deleting the delta predicate would also make it fast.
      expect(code).toContain('fn_tournament_conservation_delta(t.id) > 0.01');
      expect(code).toContain('refused_already_disbursed');
      expect(code).toContain('withheld_unfunded_pool');
      expect(code).toContain('IF p_apply THEN');
    });

    it('keeps its signature, so the cron zero-argument call stays unambiguous', () => {
      // A third parameter would create an overload, not a replacement, and
      // fn_pay_backed_payout_shortfalls() would then match two candidates.
      expect(whole).toContain('p_apply boolean DEFAULT false');
      expect(whole).toContain('p_limit integer DEFAULT 500');
      expect(whole).not.toContain('p_since_days');
    });
  });

  it('both headers still argue against the band-aids they refused', () => {
    // Raw, not stripped: this is prose, and deleting the explanation should
    // fail this law.
    expect(read(RECONCILER)).toContain('2,820,298');
    expect(read(RECONCILER)).toContain('openclaw-cron-dispatcher.py');
    expect(read(DETECTOR)).toContain('statement_timeout');
    expect(read(DETECTOR)).toContain('overload');
  });

  it('THE ONE THAT MATTERS LATER: nothing after 20260920 undoes either shape', () => {
    const offenders: string[] = [];

    for (const file of readdirSync(MIGRATIONS)) {
      if (!file.endsWith('.sql')) continue;
      if (file < FORWARD_GUARD_FROM) continue;
      const code = sqlCode(read(file));

      if (
        code.includes('fn_reconcile_club_member_daily_profit') &&
        code.includes('UPDATE club_member_daily_stats')
      ) {
        if (!code.includes('IS DISTINCT FROM (f.share')) {
          offenders.push(`${file}: rewrites the reconciler without the change guard`);
        }
        if (code.includes('s.profit <> ')) {
          offenders.push(`${file}: uses <> where a NULL profit would be skipped`);
        }
      }

      if (
        code.includes('fn_pay_backed_payout_shortfalls') &&
        code.includes('CREATE OR REPLACE FUNCTION')
      ) {
        const boundAt = code.indexOf('t.ended_at > now() - make_interval');
        const deltaAt = code.indexOf('AND public.fn_tournament_conservation_delta(t.id) > 0.01');
        if (deltaAt >= 0 && (boundAt < 0 || boundAt > deltaAt)) {
          offenders.push(`${file}: the delta is unbounded again, which is the 120s timeout`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
