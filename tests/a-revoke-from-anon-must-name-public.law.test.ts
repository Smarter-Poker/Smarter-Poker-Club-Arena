/**
 * ===========================================================================
 *  LAW: A REVOKE THAT MEANS TO SHUT ANON OUT MUST NAME PUBLIC
 * ===========================================================================
 *
 * A function is created with EXECUTE granted to PUBLIC. `anon` is a member of
 * PUBLIC like every other role, so `REVOKE EXECUTE ... FROM anon` removes
 * anon's OWN entry and changes nothing about what anon can execute:
 * has_function_privilege('anon', ...) still answers true through PUBLIC.
 *
 * WHAT THAT COST, measured 2026-09-19. PR #4872, "anon executes only what it
 * needs", merged to main on 2026-09-18 as
 * supabase/migrations/20260918121836_anon_executes_only_what_it_needs.sql. It
 * was a careful piece of work - it settled by experiment that a trigger checks
 * EXECUTE when it is created rather than when it fires, and it deliberately
 * left six grants alone because an RLS policy expression is evaluated as the
 * QUERYING role. It revoked thirteen inert grants FROM anon.
 *
 * It was never applied, and applying it a day later failed on its own
 * assertion: `anon still executes 9 of the thirteen`. Those nine carried
 * `=X/postgres` in pg_proc.proacl - EXECUTE to PUBLIC - and the revoke had not
 * touched it. The other four had no PUBLIC entry and would have been revoked
 * correctly, which is exactly why this is worth a law: the same statement
 * works on some functions and silently does nothing on others, and the
 * difference is invisible in the diff.
 *
 * Meanwhile docs/security/anon-executable-definers.json had already been
 * written for the post-revoke world - 22 allowed against 35 live - so the
 * repository documented a state the database could not reach, and
 * scripts/ci/check-anon-definer-grants.mjs had been failing on exactly those
 * thirteen inside a workflow that was switched off.
 *
 * THE RULE. A REVOKE on a function that names `anon` must also name `PUBLIC`.
 * Naming PUBLIC when there is no PUBLIC grant is a no-op, so the rule costs
 * nothing where it is not needed and is the whole fix where it is. The repo
 * already writes it that way almost everywhere: of every REVOKE line in
 * supabase/migrations on the day this law landed, 16 mentioned anon without
 * PUBLIC and all but #4872's were prose in comments.
 *
 * A statement that genuinely must not touch PUBLIC ends with
 *     -- public-ok: <why>
 * the same escape hatch tests/unit/noFixedSizeSourceWindows.test.ts uses.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');

const FIX =
  'supabase/migrations/20260919071318_anon_grant_from_public_is_the_one_that_mattered.sql';
/** The revoke that could not work: the negative control. */
const BROKEN = 'supabase/migrations/20260918121836_anon_executes_only_what_it_needs.sql';

/** This law lands here; anything newer is bound by the forward guard. */
const THIS_VERSION = '20260919071318';

const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const SQL = read(FIX);
const BROKEN_SQL = read(BROKEN);

/** The thirteen inert grants #4872 set out to remove. */
const THIRTEEN = [
  'trgfn_award_daily_trivia',
  'trgfn_award_first_training_session',
  'trgfn_award_follow',
  'trgfn_award_reaction_interaction',
  'trgfn_award_reaction_like',
  'trgfn_award_share_content',
  'trgfn_award_social_post',
  'trgfn_award_strategy_comment',
  'is_admin',
  'fn_my_club_ids',
  'fn_notification_has_personal_destination',
  'fn_club_chat_is_silenced',
  'fn_table_chat_is_silenced',
];

/** Blank out `--` comments so prose about a REVOKE is not read as one. */
function code(sql: string): string {
  return sql.replace(/--[^\n]*/g, (m) => ' '.repeat(m.length));
}

interface Revoke {
  statement: string;
  grantees: string;
  exempt: boolean;
}

/**
 * Every `REVOKE ... ON FUNCTION ... FROM <grantees>;` in a migration, taken
 * from the statement text rather than from a fixed window, so a statement that
 * grows a grantee is still read whole.
 */
function functionRevokes(sql: string): Revoke[] {
  const stripped = code(sql);
  const out: Revoke[] = [];
  for (const m of stripped.matchAll(/\bREVOKE\b[\s\S]*?;/gi)) {
    const statement = m[0];
    if (!/\bON\s+FUNCTION\b/i.test(statement)) continue;
    const from = statement.toUpperCase().lastIndexOf(' FROM ');
    if (from < 0) continue;
    // The escape hatch is written in the ORIGINAL text, on the statement's
    // last line, so look for it around this statement's end in the real source.
    const endInSource = m.index! + statement.length;
    const lineEnd = sql.indexOf('\n', endInSource);
    const tail = sql.slice(endInSource, lineEnd < 0 ? sql.length : lineEnd);
    out.push({
      statement,
      grantees: statement.slice(from + ' FROM '.length),
      exempt: /--\s*public-ok:/i.test(tail),
    });
  }
  return out;
}

function namesRole(grantees: string, role: string): boolean {
  return new RegExp(`(^|[\\s,(])${role}([\\s,;)]|$)`, 'i').test(grantees);
}

describe('a revoke that means to shut anon out names PUBLIC', () => {
  const REVOKES = functionRevokes(SQL);

  it('revokes all thirteen, and from PUBLIC as well as anon every time', () => {
    expect(REVOKES).toHaveLength(THIRTEEN.length);
    for (const r of REVOKES) {
      expect(namesRole(r.grantees, 'PUBLIC'), `names PUBLIC: ${r.statement.trim()}`).toBe(true);
      expect(namesRole(r.grantees, 'anon'), `names anon: ${r.statement.trim()}`).toBe(true);
    }
    for (const fn of THIRTEEN) {
      expect(
        REVOKES.some((r) => r.statement.includes(`public.${fn}`)),
        `${fn} is revoked in ${FIX}`
      ).toBe(true);
    }
  });

  it('leaves authenticated and service_role alone, and proves it before committing', () => {
    // Revoking PUBLIC is the wider cut, so the two roles that must survive it
    // are asserted, not assumed.
    expect(SQL).toMatch(/authenticated lost EXECUTE on % of the thirteen/);
    expect(SQL).toMatch(/service_role lost EXECUTE on % of the thirteen/);
    expect(SQL).toMatch(/anon still executes % of the thirteen/);
    expect(SQL).toContain("has_function_privilege('authenticated', p.oid, 'EXECUTE')");
    expect(SQL).toContain("has_function_privilege('service_role', p.oid, 'EXECUTE')");
    // And the whole anonymous definer surface is counted out loud, against the
    // number docs/security/anon-executable-definers.json allows.
    expect(SQL).toContain('p.prosecdef');
    expect(SQL).toMatch(/the repository allows 22/);
  });

  it('the negative control: #4872 named anon and not PUBLIC, which is why it did nothing', () => {
    const broken = functionRevokes(BROKEN_SQL);
    expect(broken, `${BROKEN} still carries the revokes this law is about`).toHaveLength(
      THIRTEEN.length
    );
    for (const r of broken) {
      expect(namesRole(r.grantees, 'anon'), `#4872 names anon: ${r.statement.trim()}`).toBe(true);
      expect(
        namesRole(r.grantees, 'PUBLIC'),
        `#4872 must still show the bug this law exists for - if it names PUBLIC, the ` +
          `pins above are measuring nothing: ${r.statement.trim()}`
      ).toBe(false);
    }
  });

  /**
   * THE ONE THAT MATTERS LATER. The next agent tightening an anon grant will
   * write the statement that reads correctly and does nothing, exactly as
   * #4872 did, and nothing will go red for a day.
   */
  it('no migration after this one revokes from anon without naming PUBLIC', () => {
    const offenders: string[] = [];
    for (const file of fs.readdirSync(MIGRATIONS).sort()) {
      if (!file.endsWith('.sql')) continue;
      const version = file.slice(0, file.indexOf('_'));
      if (version <= THIS_VERSION) continue;
      for (const r of functionRevokes(fs.readFileSync(path.join(MIGRATIONS, file), 'utf8'))) {
        if (r.exempt) continue;
        if (!namesRole(r.grantees, 'anon')) continue;
        if (namesRole(r.grantees, 'PUBLIC')) continue;
        offenders.push(`${file}: ${r.statement.trim().replace(/\s+/g, ' ')}`);
      }
    }
    expect(
      offenders,
      'a migration revokes EXECUTE from anon without revoking it from PUBLIC. A function ' +
        'is created with EXECUTE granted to PUBLIC and anon is a member of PUBLIC, so that ' +
        'statement reads correctly and changes nothing. Add PUBLIC to the grantee list - it ' +
        'is a no-op where there is no PUBLIC grant - or end the statement with ' +
        '"-- public-ok: <why>".'
    ).toEqual([]);
  });
});
