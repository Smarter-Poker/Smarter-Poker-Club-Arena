/**
 * ===========================================================================
 *  LAW: A RUNNING FIELD IS COUNTED BY THE BUST THAT SHRINKS IT
 * ===========================================================================
 *
 * `public.tournaments.current_players` is a cached count of the field. Before
 * 20260922141704 nothing counted a RUNNING field: the roster trigger was
 * pre-start only (20260823120000), a bust left the count one too high, and
 * the pg_cron job `reconcile-tournament-denormals` rewrote it every minute.
 * The registration door refuses a late entrant while the count and the roster
 * disagree ("Tournament roster cache diverged before registration"), so every
 * bust opened a window in which late registration failed.
 *
 * The job also decided "seat-first" with its own heuristic,
 * `lower(variant) IN ('spin','sng') OR COALESCE(max_players, 0) <= 2`, and
 * every mtt-v2 event has max_players NULL by contract. Measured 2026-09-22:
 * 38 of 56 RUNNING mtt-v2 events carried the live seats of ONE table as their
 * field (595 players undercounted), and the job's duplicate-table branch had
 * closed the launch tables of two events that are still stranded in
 * REGISTERING.
 *
 * THE FIX. The roster trigger recounts a RUNNING field whenever a player
 * moves into or out of it (an UPDATE of status that changes membership), in
 * the transaction that moves them, and skips seat-first formats with the
 * SAME predicate their own owner uses (`fn_ca_tournament_recorded_seat_first`).
 * An admission into a RUNNING field stays with the door that performs it: the
 * registration and horse doors publish `v_players_before + 1` themselves and
 * require the trigger to leave a RUNNING count alone. Both branches of the job
 * that wrote this column and closed tables are removed.
 *
 * WHAT THIS LAW HOLDS (the forward guard binds every migration after
 * 20260922141704):
 *
 *   1. The owner keeps the RUNNING membership branch and the seat-first skip.
 *   2. The owner's pre-start statement stays pre-start: adding RUNNING to it
 *      would count a late admission twice and make every late registration
 *      fail its own guard.
 *   3. The owner stays wired to every roster event it reads.
 *   4. `fn_reconcile_tournament_denormals` never again writes
 *      `public.tournaments` or `public.tables`, whether by a new definition or
 *      by a `ca_patch` replacement text.
 *
 * NOTE ON ASSERTING THE NEGATIVE (CLAUDE.md 7.3): these migrations quote the
 * shapes they refuse, in their headers and in the removed-text argument of a
 * patch, so every negative below runs against comment-stripped code, and a
 * removed text (the first argument of ca_patch) is never read as installed.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sliceBetween } from './helpers/sourceWindow';

const MIGRATIONS = join(__dirname, '..', 'supabase', 'migrations');
const FIX = '20260922141704_a_running_field_is_counted_by_the_bust_that_shrinks_it.sql';
const OWNER = 'fn_sync_tournament_current_players';
const OWNER_TRIGGER = 'trg_sync_tournament_current_players';
const JOB_FUNCTION = 'fn_reconcile_tournament_denormals';

const read = (file: string): string => readFileSync(join(MIGRATIONS, file), 'utf8');

type Quoted = { at: number; body: string };

/**
 * One left-to-right pass: comments are blanked (length preserved), literals
 * and dollar-quoted bodies are kept as they are, and every dollar-quoted body
 * is recorded with the offset of its opening tag. A scanner rather than a
 * chain of regexes, for the reason the stakes law records: an apostrophe in a
 * prose comment must not start a literal, and a '--' inside a literal must not
 * start a comment.
 */
const scan = (sql: string): { code: string; quoted: Quoted[] } => {
  const out = sql.split('');
  const quoted: Quoted[] = [];
  const n = sql.length;
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to && k < n; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  let i = 0;
  while (i < n) {
    if (sql[i] === '$') {
      let j = i + 1;
      while (j < n && /[A-Za-z_]/.test(sql[j])) j++;
      if (j < n && sql[j] === '$') {
        const tag = sql.substring(i, j + 1);
        const end = sql.indexOf(tag, j + 1);
        quoted.push({ at: i, body: sql.substring(j + 1, end < 0 ? n : end) });
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
    if (sql.startsWith('/*', i)) {
      const close = sql.indexOf('*/', i + 2);
      const to = close < 0 ? n : close + 2;
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
      i = j;
      continue;
    }
    i++;
  }
  return { code: out.join(''), quoted };
};

/** Comments out of a function body or a replacement text. */
const stripComments = (sql: string): string =>
  sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');

/** The body of every CREATE [OR REPLACE] FUNCTION public.<name>( in code. */
const functionBodies = (sql: string, name: string): string[] => {
  const { code, quoted } = scan(sql);
  const decl = new RegExp(
    `CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+public\\.${name}\\s*\\(`,
    'gi'
  );
  const bodies: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = decl.exec(code)) !== null) {
    const at = m.index;
    const body = quoted.find((q) => q.at > at);
    if (body) bodies.push(body.body);
  }
  return bodies;
};

/** The replacement text of every ca_patch('<name>', <from>, <to>) in code. */
const patchReplacements = (sql: string, name: string): string[] => {
  const { code, quoted } = scan(sql);
  const call = new RegExp(`ca_patch\\(\\s*'${name}'\\s*,`, 'g');
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = call.exec(code)) !== null) {
    const at = m.index;
    const args = quoted.filter((q) => q.at > at);
    if (args.length >= 2) out.push(args[1].body);
  }
  return out;
};

const WRITES_COUNT_OR_TABLES = /\bUPDATE\s+(?:public\.)?(?:tournaments|tables)\b/i;

/** Everything the owner must still be, as a list of what it no longer is. */
const ownerProblems = (body: string): string[] => {
  const code = stripComments(body);
  const problems: string[] = [];
  const guard = code.indexOf("IF TG_OP = 'UPDATE'");
  const running = code.indexOf("AND t.status = 'RUNNING'");
  if (guard < 0) problems.push('the RUNNING branch lost its TG_OP guard');
  if (running < 0) problems.push('the RUNNING field is no longer counted');
  if (guard >= 0 && running >= 0 && running < guard) {
    problems.push('the RUNNING write is outside the membership guard');
  }
  const branch =
    guard >= 0 && running > guard ? sliceBetween(code, "IF TG_OP = 'UPDATE'", 'END IF;') : '';
  if (
    !branch.includes("IS DISTINCT FROM (COALESCE(NEW.status, '') IN ('registered', 'playing'))")
  ) {
    problems.push('the RUNNING branch no longer fires on a membership change only');
  }
  if (!branch.includes('NOT public.fn_ca_tournament_recorded_seat_first(t.id, true)')) {
    problems.push('the RUNNING branch no longer leaves seat-first formats to their own owner');
  }
  if (!code.includes("AND status IN ('ANNOUNCED', 'REGISTERING')")) {
    problems.push('the pre-start statement changed');
  }
  if (/status\s+IN\s*\([^)]*'RUNNING'[^)]*\)/i.test(code)) {
    problems.push('RUNNING was added to a status list: a late admission would be counted twice');
  }
  return problems;
};

describe('a RUNNING field is counted by the bust that shrinks it', () => {
  it('the owner counts a RUNNING membership change, skips seat-first, and is pre-start otherwise', () => {
    const bodies = functionBodies(read(FIX), OWNER);
    expect(bodies).toHaveLength(1);
    expect(ownerProblems(bodies[0])).toEqual([]);
  });

  it('the fix removes both writing branches of the minutely job and adds none back', () => {
    const sql = read(FIX);
    const replacements = patchReplacements(sql, JOB_FUNCTION);
    // The duplicate-table branch, the count branch, and the returned shape.
    expect(replacements).toHaveLength(3);
    for (const text of replacements) {
      expect(stripComments(text)).not.toMatch(WRITES_COUNT_OR_TABLES);
    }
    // Never a wholesale redefinition here: a textual patch of the live body,
    // each marker asserted to match exactly once or the migration refuses.
    expect(functionBodies(sql, JOB_FUNCTION)).toEqual([]);
    expect(sql).toContain("RAISE EXCEPTION 'ca_patch: marker in % found % times, expected %: %'");
  });

  it('the fix proves itself inside its own transaction, both ways', () => {
    const verify = sliceBetween(read(FIX), 'DO $verify$', '$verify$;');
    expect(verify).toContain("position('UPDATE public.tables' in v_code) > 0");
    expect(verify).toContain("position('UPDATE public.tournaments ' in v_code) > 0");
    expect(verify).toContain("g.tgname = 'trg_sync_tournament_current_players'");
    expect(verify).toContain("g.tgname = 'aa_tournament_player_launch_proof_lock'");
    expect(verify).toContain('aligned field count(s) still disagree with their roster');
    expect(verify).toContain('aligned row(s) are seat-first or not RUNNING');
  });

  it('THE ONE THAT MATTERS LATER: no migration after the fix undoes any of it', () => {
    const offenders: string[] = [];
    for (const file of readdirSync(MIGRATIONS).sort()) {
      if (!file.endsWith('.sql') || file <= FIX) continue;
      const sql = read(file);

      for (const body of functionBodies(sql, OWNER)) {
        for (const problem of ownerProblems(body)) offenders.push(`${file}: ${OWNER}: ${problem}`);
      }

      for (const body of functionBodies(sql, JOB_FUNCTION)) {
        if (WRITES_COUNT_OR_TABLES.test(stripComments(body))) {
          offenders.push(`${file}: ${JOB_FUNCTION} writes tournaments or tables again`);
        }
      }
      for (const text of patchReplacements(sql, JOB_FUNCTION)) {
        if (WRITES_COUNT_OR_TABLES.test(stripComments(text))) {
          offenders.push(
            `${file}: a ca_patch of ${JOB_FUNCTION} writes tournaments or tables again`
          );
        }
      }

      const { code } = scan(sql);
      const drops = new RegExp(`DROP\\s+TRIGGER\\s+(?:IF\\s+EXISTS\\s+)?${OWNER_TRIGGER}\\b`, 'i');
      const recreates = new RegExp(
        `CREATE\\s+TRIGGER\\s+${OWNER_TRIGGER}\\s+AFTER\\s+INSERT\\s+OR\\s+DELETE\\s+OR\\s+UPDATE\\s+OF\\s+status,\\s*tournament_id\\s+ON\\s+public\\.tournament_players`,
        'i'
      );
      if (drops.test(code) && !recreates.test(code)) {
        offenders.push(
          `${file}: drops ${OWNER_TRIGGER} without recreating it on every roster event`
        );
      }
      if (new RegExp(`DISABLE\\s+TRIGGER\\s+${OWNER_TRIGGER}\\b`, 'i').test(code)) {
        offenders.push(`${file}: disables ${OWNER_TRIGGER}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
