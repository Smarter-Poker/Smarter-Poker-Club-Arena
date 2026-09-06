/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  THE PAYOUT FREEZE IS OPENED BY A HUMAN, NEVER BY A DETECTOR (2026-09-02)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * fn_settle_tournament_obligation refuses every tournament payout with
 * refused_reason = 'payout_frozen' while public.ca_payout_freeze holds a row
 * with scope = 'tournament_payouts' and cleared_at IS NULL. That is the kill
 * switch from docs/CHIP-ACCOUNTING-STANDARD.md section 3.4 layer 6.
 *
 * Dan's rule for the controls lane, binding: nothing may refuse or block a
 * legitimate payout. A switch a person throws after reading the trial balance
 * is a control. A switch a detector throws on a threshold is exactly the
 * false-alarm mechanism that pays nobody for an hour because a snapshot was
 * re-based (which happened, to the stored total, at 23:45 UTC on 2026-09-01).
 * The threshold itself is Dan's decision (standard section 6 item 2) and has
 * not been made.
 *
 * So this law pins the SHAPE of every migration in the repo:
 *
 *   - the only INSERT INTO ca_payout_freeze anywhere is inside the body of
 *     fn_ca_open_payout_freeze, the function a person calls;
 *   - no cron job body and no watch function references the opener or the
 *     table as a writer;
 *   - the table is created empty and the migration asserts that.
 *
 * If you are here because you want the trial balance to open the freeze
 * automatically: that is a decision for Dan, not a test to weaken. Put the
 * threshold and the false-positive cost in front of him first.
 *
 * ─── ONE SUPERSEDED FILE, AND WHAT IT COST (2026-09-05) ─────────────────────
 *
 * This law did its job on 2026-09-05. Phase 6.2 (20260905203905) built the
 * roadmap's "kill switch automation at Dan's threshold" as a detector that
 * opened the freeze itself at 1,000 chips, and the full suite caught it at the
 * phase gate (the pre-push hook runs the tests covering the diff; this law
 * reads every migration instead). It was corrected forward the same hour by
 * 20260905224524, which rewrites fn_ca_kill_switch_trip to ESCALATE - a
 * critical incident, a senior page, an alert - and never to freeze; production
 * was disarmed before the correction was written.
 *
 * The law was right on the evidence: at 03:05 UTC that day the supply meter
 * read -3,305.68 unexplained in one hour, and nothing had leaked - the meter
 * had changed DEFINITION at 02:56. An armed automatic switch would have frozen
 * every tournament payout on the platform, which is the false alarm the law
 * describes. Whether an automatic opener is ever armed remains Dan's decision.
 *
 * An applied migration is never edited (it is mirrored byte-exact against
 * production and a replay must reproduce what ran), so the offending body
 * stays in the tree as history. It is listed below, and the exemption is
 * SPENT ON EVIDENCE: the correcting migration must exist, its
 * fn_ca_kill_switch_trip must contain no insert, and it must assert the same
 * at apply time. Every other migration, and any new one, is caught as before.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const MIGRATIONS = join(process.cwd(), 'supabase', 'migrations');
const CONTROLS = '20260902203000_chip_std_controls.sql';

const read = (name: string) => readFileSync(join(MIGRATIONS, name), 'utf8');

/** Every migration file, name -> text. */
function allMigrations(): Array<[string, string]> {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .map((f) => [f, read(f)] as [string, string]);
}

/**
 * Character ranges of every function body in a migration, keyed by function
 * name. A body runs from its "AS $$" (or $tag$) to the matching closing tag.
 */
function functionBodies(sql: string): Array<{ name: string; start: number; end: number }> {
  const out: Array<{ name: string; start: number; end: number }> = [];
  const head = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:public\.)?(\w+)\s*\(/gi;
  let m: RegExpExecArray | null;
  while ((m = head.exec(sql))) {
    const asIdx = sql.indexOf('AS $', m.index);
    if (asIdx < 0) continue;
    const tagEnd = sql.indexOf('$', asIdx + 4);
    const tag = sql.slice(asIdx + 3, tagEnd + 1); // "$$" or "$tag$"
    const bodyStart = tagEnd + 1;
    const bodyEnd = sql.indexOf(tag, bodyStart);
    if (bodyEnd < 0) continue;
    out.push({ name: m[1], start: bodyStart, end: bodyEnd });
  }
  return out;
}

/**
 * The same text with every single-quoted SQL string blanked (same length, so
 * every offset still lines up). An INSERT written INSIDE a quoted string is
 * not a statement: it is an assertion about one, and the correcting migration
 * of 2026-09-05 asserts exactly that ("the kill switch still writes the payout
 * freeze" refuses to apply if the switch ever writes it again). Scanning the
 * raw text called that assertion an opener. The negative controls below
 * smuggle REAL statements, unquoted, and still fail as they must.
 */
function withoutStringLiterals(sql: string): string {
  let out = '';
  let inStr = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (!inStr && ch === "'") {
      inStr = true;
      out += ' ';
      continue;
    }
    if (inStr) {
      if (ch === "'" && sql[i + 1] === "'") {
        out += '  ';
        i++;
        continue;
      }
      if (ch === "'") {
        inStr = false;
        out += ' ';
        continue;
      }
      out += ch === '\n' ? '\n' : ' ';
      continue;
    }
    out += ch;
  }
  return out;
}

/** Offsets of every INSERT INTO ca_payout_freeze in the text. */
function freezeInserts(sql: string): number[] {
  const re = /INSERT\s+INTO\s+(?:public\.)?ca_payout_freeze\b/gi;
  const scan = withoutStringLiterals(sql);
  const out: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(scan))) out.push(m.index);
  return out;
}

/**
 * The checker under test: returns the list of offending inserts, i.e. every
 * INSERT INTO ca_payout_freeze that is NOT inside fn_ca_open_payout_freeze.
 */
function insertsOutsideTheHumanOpener(sql: string): number[] {
  const bodies = functionBodies(sql).filter((b) => b.name === 'fn_ca_open_payout_freeze');
  return freezeInserts(sql).filter((at) => !bodies.some((b) => at >= b.start && at < b.end));
}

describe('the payout freeze is human-only', () => {
  const controls = read(CONTROLS);

  it('the controls migration creates the table and the human opener', () => {
    expect(controls).toMatch(/CREATE TABLE public\.ca_payout_freeze/);
    expect(controls).toMatch(/CREATE OR REPLACE FUNCTION public\.fn_ca_open_payout_freeze\(/);
    expect(controls).toMatch(/CREATE OR REPLACE FUNCTION public\.fn_ca_clear_payout_freeze\(/);
    // exactly one insert, and it is the opener's
    expect(freezeInserts(controls)).toHaveLength(1);
    expect(insertsOutsideTheHumanOpener(controls)).toEqual([]);
  });

  it('the table is created empty and the migration asserts it', () => {
    expect(controls).toMatch(/ca_payout_freeze must be created EMPTY/);
  });

  /**
   * file that broke it -> migration that corrected it forward. An entry buys
   * nothing on its own: the correction is verified in the test below.
   */
  const SUPERSEDED: Record<string, string> = {
    '20260905203905_phase_6_2_the_kill_switch_trips_itself_at_a_thousand_chips.sql':
      '20260905224524_the_kill_switch_escalates_and_only_a_human_freezes_a_payout.sql',
  };

  it('every superseded opener was actually corrected forward, and the correction says so', () => {
    for (const [broke, fixedBy] of Object.entries(SUPERSEDED)) {
      const files = allMigrations().map(([n]) => n);
      expect(files, `${broke} is listed as superseded but is not in the tree`).toContain(broke);
      expect(
        files,
        `${broke} names ${fixedBy} as its correction, which is not in the tree`
      ).toContain(fixedBy);
      const fix = read(fixedBy);
      // the corrected body opens nothing
      expect(insertsOutsideTheHumanOpener(fix)).toEqual([]);
      const bodies = functionBodies(fix).filter((b) => b.name === 'fn_ca_kill_switch_trip');
      expect(bodies.length, `${fixedBy} does not re-create fn_ca_kill_switch_trip`).toBeGreaterThan(
        0
      );
      for (const b of bodies) {
        expect(fix.slice(b.start, b.end)).not.toMatch(
          /INSERT\s+INTO\s+(?:public\.)?ca_payout_freeze\b/i
        );
      }
      // and it refuses to apply if the switch ever writes the freeze again
      expect(fix).toMatch(/the kill switch still writes the payout freeze/);
      expect(fix).toMatch(/PayoutFreezeIsHumanOnly/);
    }
  });

  it('no migration in the repo inserts into ca_payout_freeze outside fn_ca_open_payout_freeze', () => {
    const offenders = allMigrations()
      .filter(([name]) => !(name in SUPERSEDED))
      .map(([name, sql]) => [name, insertsOutsideTheHumanOpener(sql)] as const)
      .filter(([, hits]) => hits.length > 0)
      .map(([name]) => name);
    expect(
      offenders,
      `These migrations open the payout freeze from somewhere other than the human ` +
        `opener: ${offenders.join(', ')}. An automatic opener can refuse a legitimate ` +
        `payout on a false alarm; the threshold is Dan's decision, not a detector's.`
    ).toEqual([]);
  });

  it('no cron job and no watch function calls the opener', () => {
    for (const [name, sql] of allMigrations().filter(([n]) => !(n in SUPERSEDED))) {
      const crons = sql.match(/cron\.schedule\([\s\S]*?\);/g) ?? [];
      for (const job of crons) {
        expect(job, `${name}: a cron job references the payout freeze opener`).not.toMatch(
          /fn_ca_open_payout_freeze|INSERT\s+INTO\s+(?:public\.)?ca_payout_freeze/i
        );
      }
      for (const body of functionBodies(sql)) {
        if (body.name === 'fn_ca_open_payout_freeze') continue;
        const text = sql.slice(body.start, body.end);
        expect(
          text,
          `${name}: ${body.name} calls fn_ca_open_payout_freeze; only a person may`
        ).not.toMatch(/fn_ca_open_payout_freeze\s*\(/i);
      }
    }
  });

  it('the controls migration asserts the settle function still consults the table', () => {
    // The consult itself lives in fn_settle_tournament_obligation (Lane A),
    // whose live body is ahead of its repo mirror as this is written. The
    // controls migration checks pg_proc.prosrc for it at apply time; pin that
    // the check is there so it cannot be quietly dropped.
    expect(controls).toMatch(
      /proname = 'fn_settle_tournament_obligation'[\s\S]*?prosrc LIKE '%ca_payout_freeze%'/
    );
  });

  it('NEGATIVE CONTROL: an automatic opener anywhere in the file is caught', () => {
    // (a) an insert appended after the functions, as a cron body or a DO block
    const auto =
      controls +
      `\nDO $$ BEGIN INSERT INTO public.ca_payout_freeze (scope, reason) ` +
      `VALUES ('tournament_payouts', 'trial balance broke'); END $$;\n`;
    expect(insertsOutsideTheHumanOpener(auto)).toHaveLength(1);

    // (b) an insert smuggled into the watch function's body
    const watchAt = controls.indexOf(
      'CREATE OR REPLACE FUNCTION public.fn_ca_trial_balance_watch('
    );
    const loopAt = controls.indexOf('LOOP', watchAt);
    const smuggled =
      controls.slice(0, loopAt + 4) +
      `\n    INSERT INTO public.ca_payout_freeze (scope, reason) VALUES ('tournament_payouts', r.account);` +
      controls.slice(loopAt + 4);
    expect(insertsOutsideTheHumanOpener(smuggled)).toHaveLength(1);

    // (c) the checker still passes the genuine file, so (a) and (b) are the diff
    expect(insertsOutsideTheHumanOpener(controls)).toEqual([]);
  });
});
