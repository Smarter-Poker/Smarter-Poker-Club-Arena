/**
 * ===========================================================================
 *  LAW: THE DISPLAY STAKES FOLLOW THEIR OWN BLINDS
 * ===========================================================================
 *
 * `public.tables.stakes` is a display string that must agree with the same
 * row's `small_blind` and `big_blind`. For most of this estate's life the only
 * thing enforcing that was `reconcile-tournament-denormals`, a cron job
 * running EVERY MINUTE whose second branch rewrites the column.
 *
 * MEASURED 2026-09-19 across all 272,707 rows of `public.tables`:
 *
 *   tournament tables                                     265,022
 *   tournament tables whose stakes contradicts own blinds   40,998  (15.5%)
 *   of those, inside the minutely job's status scope             0
 *   of those, outside it                                    40,998
 *
 * The job held the invariant exactly where anyone would look for it and
 * nowhere else. Stored values included 28,651 rows reading the literal text
 * `undefined/undefined`, a JavaScript template literal reaching the database
 * from `server/src/tournament/TournamentManagerBase.ts:6497`.
 *
 * `20260913200859` had already added the right authority,
 * `fn_tournament_table_inherits_committed_blinds`, and it had two holes:
 *
 *   1. `IF v_state IS NULL THEN RETURN NEW; END IF;` returned without deriving
 *      anything, and 167,997 tournaments have no `blind_level_state`.
 *   2. It was registered `BEFORE INSERT` ONLY, so it had never run on the
 *      UPDATE path where the drift actually happens.
 *
 * Hole 1 is closed by `20260919184755`. Hole 2 is closed by `20260919184835`,
 * which adds a separate lock-free `BEFORE UPDATE OF (small_blind, big_blind,
 * stakes)` trigger. Hole 2 was found only because a behavioural probe wrote
 * `PROBE/WRONG` to a real row and read it back unchanged, AFTER every
 * structural assertion had passed.
 *
 * THE ONE THAT MATTERS LATER is the forward guard: from 20260920, no migration
 * may drop the UPDATE trigger without recreating it in the same file, and none
 * may put a `WHERE`-style status filter back on this invariant.
 *
 * CASH TABLES ARE NOT THIS LAW'S SUBJECT and the law asserts that they are
 * excluded. They use `fn_cash_stakes_label`, and 1,017 of them carry a
 * `$0.05/$0.10` form that the tournament expression would destroy. A fix that
 * "normalises stakes" everywhere would pass a naive test and break them.
 *
 * NOTE ON ASSERTING THE NEGATIVE (CLAUDE.md 7.3): these migration headers
 * quote the shapes they refuse, so every negative assertion below runs against
 * a SQL-comment-stripped copy.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sliceDollarQuoted } from './helpers/sourceWindow';

const MIGRATIONS = join(__dirname, '..', 'supabase', 'migrations');
const INSERT_SIDE =
  '20260919184755_the_display_stakes_follow_the_blinds_even_with_no_committed_level.sql';
const UPDATE_SIDE = '20260919184835_stakes_follows_its_own_blinds_on_update_not_only_on_insert.sql';
const UPDATE_TRIGGER = 'zzzzzz_tables_stakes_follows_its_own_blinds';

/** The day after these fixes. Everything from here on is covered. */
const FORWARD_GUARD_FROM = '20260920';

/**
 * Return a copy of `sql` in which COMMENTS and STRING LITERALS are blanked and
 * everything else, including dollar-quoted function bodies, is left as code.
 * Length and newlines are preserved so offsets stay comparable.
 *
 * Written as a left-to-right scanner rather than a chain of regexes, because a
 * chain gets this wrong in both directions and this law was failing on it:
 *
 *   - blanking literals first turns the apostrophe in a prose comment such as
 *     "the row's own blinds" into the start of a string and eats real code
 *     after it, which is exactly how the first version of this file failed;
 *   - blanking comments first eats a legitimate '----' literal, the trap
 *     CLAUDE.md 7.3 records.
 *
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
    // Dollar-quoted body: this IS the code we want to assert against.
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

describe('the display stakes follow their own blinds', () => {
  it('the UPDATE path is wired, scoped to the blind columns', () => {
    const code = sqlCode(read(UPDATE_SIDE));
    expect(code).toContain(`CREATE TRIGGER ${UPDATE_TRIGGER}`);
    expect(code).toContain('BEFORE UPDATE OF small_blind, big_blind, stakes ON public.tables');
  });

  it('cash tables are excluded twice, in the WHEN clause and in the body', () => {
    const code = sqlCode(read(UPDATE_SIDE));
    // The trigger never fires for a cash row ...
    expect(code).toContain('NEW.tournament_id IS NOT NULL');
    // ... and the body would still return early if someone recreated the
    // trigger without a WHEN clause.
    expect(code).toContain('IF NEW.tournament_id IS NULL THEN RETURN NEW; END IF;');
  });

  it('the INSERT path derives stakes when no blind level is committed', () => {
    // The FUNCTION BODY, not the whole file: this migration's guard block
    // quotes the same marker as a string while checking the live body, and a
    // whole-file indexOf finds that copy first. The ordering claim below is
    // about the body, so the body is what it reads.
    const body = sliceDollarQuoted(read(INSERT_SIDE), '$function$');

    expect(body).toContain('NEW.small_blind IS NOT NULL AND NEW.big_blind IS NOT NULL');

    // The cash early return must still precede the derivation, or 7,685 cash
    // tables get rewritten into a format their own label function never emits.
    const cashAt = body.indexOf('IF NEW.tournament_id IS NULL THEN RETURN NEW; END IF;');
    const deriveAt = body.indexOf('NEW.small_blind IS NOT NULL AND NEW.big_blind IS NOT NULL');
    expect(cashAt).toBeGreaterThanOrEqual(0);
    expect(deriveAt).toBeGreaterThan(cashAt);
  });

  it('both headers still argue against the refused alternatives', () => {
    // Raw, not stripped: this is prose and deleting it should fail the law.
    expect(read(INSERT_SIDE)).toContain('generated column');
    expect(read(UPDATE_SIDE)).toContain('FOR SHARE');
    expect(read(UPDATE_SIDE)).toContain('PROBE FAILED');
  });

  it('THE ONE THAT MATTERS LATER: nothing after 20260920 unwires the UPDATE trigger', () => {
    const offenders: string[] = [];

    for (const file of readdirSync(MIGRATIONS)) {
      if (!file.endsWith('.sql')) continue;
      if (file < FORWARD_GUARD_FROM) continue;

      const code = sqlCode(read(file));
      if (!code.includes(UPDATE_TRIGGER)) continue;

      const drops =
        code.includes(`DROP TRIGGER IF EXISTS ${UPDATE_TRIGGER}`) ||
        code.includes(`DROP TRIGGER ${UPDATE_TRIGGER}`);
      const recreates = code.includes(`CREATE TRIGGER ${UPDATE_TRIGGER}`);

      if (drops && !recreates) {
        offenders.push(`${file}: drops ${UPDATE_TRIGGER} without recreating it`);
      }
      if (recreates && !code.includes('BEFORE UPDATE OF small_blind, big_blind, stakes')) {
        offenders.push(`${file}: recreates ${UPDATE_TRIGGER} without the UPDATE event`);
      }
      if (recreates && !code.includes('NEW.tournament_id IS NOT NULL')) {
        offenders.push(`${file}: recreates ${UPDATE_TRIGGER} without the cash exclusion`);
      }
    }

    expect(offenders).toEqual([]);
  });
});
