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

/** Offsets of every INSERT INTO ca_payout_freeze in the text. */
function freezeInserts(sql: string): number[] {
  const re = /INSERT\s+INTO\s+(?:public\.)?ca_payout_freeze\b/gi;
  const out: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql))) out.push(m.index);
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

  it('no migration in the repo inserts into ca_payout_freeze outside fn_ca_open_payout_freeze', () => {
    const offenders = allMigrations()
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
    for (const [name, sql] of allMigrations()) {
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
