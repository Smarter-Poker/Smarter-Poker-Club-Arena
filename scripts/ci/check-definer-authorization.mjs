#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  A SECURITY DEFINER FUNCTION THAT WRITES, AND THAT A BROWSER CAN CALL, MUST
 *  ASK WHO IS CALLING
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * WHY THIS EXISTS (2026-08-27)
 *
 * Two RPCs were found taking authorization from data the caller supplied.
 * `fn_mystery_bounty_reveal` skipped its "are you the revealer" check whenever
 * the caller passed `p_auto => true`, which is a PARAMETER, so any member could
 * read the amount and tier of any mystery bounty and steal the reveal.
 * `commander_clock_write` had no check at all and let any logged-in user pause,
 * level-jump or end any Commander tournament by id, straight through the RLS
 * policy its own table already carried.
 *
 * Fixing those two was not the finding. Sweeping the schema afterwards was:
 * 269 SECURITY DEFINER functions that write hold EXECUTE for `authenticated`,
 * and NINETEEN of them never referenced auth.uid(), auth.role() or auth.jwt()
 * anywhere. A function that never asks who is calling is not authorising
 * anything, and SECURITY DEFINER runs it as an owner with BYPASSRLS, so the
 * table policies are not standing behind it either. Proven, in a transaction
 * that rolled itself back, as an ordinary member:
 *
 *     PROBE3 club "SHARK CLUB" member_count 592->10591
 *            | fn_table_lifecycle_pass ALSO RAN
 *
 * Eighteen were revoked. Then, the same afternoon, a nineteenth arrived:
 * `fn_pay_backed_payout_shortfalls`, which PAYS CHIPS, shipped on main in #1537
 * hours after the sweep. Its author had no way to know the rule existed. That
 * is the whole argument for this file. A rule nothing enforces decays at the
 * speed people write code.
 *
 * WHAT IT CHECKS. For every function DECLARED by a migration this branch adds
 * or modifies, TWO rules:
 *
 *   RULE 1, the writer rule (2026-08-27):
 *     SECURITY DEFINER  and  it writes  and  a browser role can execute it
 *     and  the body never consults auth.uid() / auth.role() / auth.jwt()
 *         -> FAIL
 *
 *   RULE 2, the anon rule (2026-08-31, see anonReadableDefiners below):
 *     SECURITY DEFINER  and  ANON can execute it
 *     and  the body never consults auth.uid() / auth.role() / auth.jwt()
 *         -> FAIL, whether or not it writes
 *
 * Rule 2 exists because rule 1 only ever looked at WRITERS, and in one
 * afternoon three read-only SECURITY DEFINER functions arrived anon-executable
 * and it cleared every one of them. One returned the schema's table and index
 * names to anybody who asked.
 *
 * DEFAULT GRANTS ARE THE COMMON CASE, not an edge case. A migration that
 * writes no GRANT at all still leaves EXECUTE with PUBLIC, which every browser
 * role inherits. Most of the nineteen got there exactly that way. So silence
 * is treated as "open", and only an explicit revoke closes it.
 *
 * REVOKE IS MODELLED PER ROLE, because `REVOKE ... FROM PUBLIC` on its own does
 * NOT close a function that also has an explicit grant to `authenticated`. A
 * revoke that names the wrong role reads as a fix and is a no-op, which is the
 * exact mistake that made an earlier column-level REVOKE on club_members do
 * nothing at all.
 *
 * WHY ONLY CHANGED MIGRATIONS. supabase/migrations/ is intentionally stale.
 * Schema is applied straight to production through the Supabase MCP and the
 * older files are history, not truth, so a function's newest definition in the
 * repo may have been superseded in the database years ago. Judging those would
 * produce failures no commit could ever fix. This asks the one question a gate
 * can answer honestly: does what you are adding today carry the rule. Run it
 * over everything with --all when you want the archaeology.
 *
 * TRIGGER FUNCTIONS ARE OUT OF SCOPE. `RETURNS trigger` cannot be invoked as an
 * RPC; Postgres refuses it outside a trigger context, so the grant is inert.
 *
 * SO IS `RETURNS event_trigger`, for exactly the same reason, and until
 * 2026-09-06 this file did not say so: the test was `/RETURNS\s+trigger\b/`,
 * which does not match `event_trigger`, so every event-trigger function that
 * writes a log row was reported as a SECURITY DEFINER writer a browser could
 * reach. `ca_log_ddl_event` and `ca_log_ddl_drop` blocked a push that way.
 * Postgres refuses `SELECT ca_log_ddl_event()` with "can only be called in a
 * sql_drop event trigger function" whatever the grant says, so the finding was
 * never actionable - and an unactionable BLOCKED is how a gate teaches people
 * to reach for --no-verify.
 *
 * Both of that finding's premises were false, and the second is worth knowing
 * for its own sake: the live ACL on those two functions is
 * `{postgres=X, service_role=X}` - no browser role holds EXECUTE. "Silence
 * means open" is right for CREATE FUNCTION and WRONG for CREATE OR REPLACE of
 * a function that already exists, because a replace PRESERVES the existing
 * grants rather than resetting them to the default. This check reads migration
 * text, not the catalogue, so it cannot see that; the conservative reading is
 * still the right default, but it is the reason a migration that only replaces
 * a body can be reported as opening something it never touched.
 *
 * ESCAPE HATCH. scripts/ci/definer-authorization.allowlist.json, which carries
 * a written reason per entry, under two separate keys: `reviewedExceptions`
 * for rule 1 and `anonPublicSurface` for rule 2. Two functions are in the
 * first and both were read line by line; the second starts empty. Adding to
 * either is a decision, not a formality: say in the reason why a caller cannot
 * point the function at anything that matters, or what an unauthenticated
 * caller is allowed to learn from it.
 *
 * IT CANNOT SEE THE LIVE DATABASE, and on this estate schema is applied
 * straight to production through the Supabase MCP, so a function can arrive
 * without ever passing through a migration in this repo. That gap is covered
 * by scripts/ci/audit-live-definer-exposure.mjs, which asks production the
 * same four questions daily. Neither one replaces the other.
 *
 * Usage:  node scripts/ci/check-definer-authorization.mjs [baseRef] [--all]
 * Exit:   0 clean · 1 an unauthorised writer or a new anon-readable definer
 *         · 2 script error
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const REPO = process.cwd();
const DIR = 'supabase/migrations/';
const ALLOWLIST = join(REPO, 'scripts/ci/definer-authorization.allowlist.json');
const ALL = process.argv.includes('--all');

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function baseRef() {
  const explicit = process.argv.slice(2).find((a) => !a.startsWith('--'));
  if (explicit) return explicit;
  const b = process.env.GITHUB_BASE_REF;
  if (b) {
    for (const ref of [`origin/${b}`, b]) {
      try {
        git(['rev-parse', '--verify', ref]);
        return ref;
      } catch {
        /* try the next form */
      }
    }
  }
  return 'HEAD~1';
}

function changedMigrations(base) {
  let out;
  try {
    out = git(['diff', '--name-only', '--diff-filter=AM', `${base}...HEAD`]);
  } catch {
    try {
      out = git(['diff', '--name-only', '--diff-filter=AM', base, 'HEAD']);
    } catch {
      // A gate that silently skips reports success for a check it never ran.
      console.error(
        `[check-definer-authorization] cannot diff against "${base}" — the checkout is ` +
          'probably shallow. Give the job fetch-depth: 0, or pass an explicit base ref.'
      );
      process.exit(2);
    }
  }
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith(DIR) && l.endsWith('.sql'))
    // BACKFILL EXEMPTION (2026-09-01). A file whose first line marks it as a
    // recovered record of an ALREADY-APPLIED migration is history, not new
    // work. It cannot introduce a new definer: the function is already live in
    // whatever state later migrations left it, and THAT live grant - not this
    // file's historical creation-time GRANT - is what a browser can actually
    // reach. Judging a backfill on its own creation-time grants produces false
    // positives against production truth (verified 2026-09-01). New
    // declarations are unaffected, and live grants stay covered by
    // audit-live-definer-exposure.mjs (which asks production directly) and by
    // this gate on every genuinely new migration. Marker is machine-written by
    // scripts/ci/backfill-unrecorded-migrations.mjs.
    .filter((f) => {
      try {
        return !/^--\s*(BACKFILLED|UNRECOVERABLE STUB)\b/.test(readFileSync(join(REPO, f), 'utf8'));
      } catch {
        return true; // unreadable: check it rather than skip it
      }
    });
}

/** Comments carry no behaviour, and a comment that merely NAMES auth.uid()
 *  must not be mistaken for a call to it. Strip both forms before reading. */
function stripComments(sql) {
  return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
}

/** Every function a migration declares, with its header and its body kept
 *  apart: SECURITY DEFINER and RETURNS live in the header, the writes and the
 *  auth calls live in the body. */
function declaredFunctions(sql) {
  const found = [];
  const start = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:public\.)?([A-Za-z_]\w*)\s*\(/gi;
  let m;
  while ((m = start.exec(sql))) {
    const rest = sql.slice(m.index);
    const open = /\bAS\s+(\$\w*\$)/i.exec(rest);
    if (!open) continue;
    const tag = open[1];
    const bodyStart = m.index + open.index + open[0].length;
    const bodyEnd = sql.indexOf(tag, bodyStart);
    if (bodyEnd < 0) continue;
    found.push({
      name: m[1],
      header: sql.slice(m.index, m.index + open.index),
      body: sql.slice(bodyStart, bodyEnd),
    });
    start.lastIndex = bodyEnd + tag.length;
  }
  return found;
}

const BROWSER_ROLES = ['public', 'anon', 'authenticated'];

/**
 * Can a browser role execute this function after everything the migration says?
 *
 * Starts from the Postgres default, which is EXECUTE granted to PUBLIC, and
 * applies each GRANT and REVOKE in file order to the roles it actually names.
 * Effective browser access is public OR anon OR authenticated, which is why a
 * lone `REVOKE ... FROM PUBLIC` does not close a function that was also granted
 * to `authenticated` explicitly.
 */
function effectiveGrants(sql, name) {
  const held = { public: true, anon: false, authenticated: false };
  /* THE GAP CANNOT CROSS A STATEMENT BOUNDARY (2026-09-01). This used to be
     `[\s\S]*?`, which let the word "grant" ANYWHERE - inside a RAISE EXCEPTION
     string, a column name, a comment that survived stripping - reach forward to
     the next `ON FUNCTION` in the file and label somebody else's statement with
     its own verb. It really happened: 20260901090000 ends with

       RAISE EXCEPTION 'Deep Stack Society still has a duplicate opening
                        owner-wallet grant';

     and that lone word turned the next REVOKE into a GRANT. Here it read as
     stricter than the truth, which is the harmless direction; reversed - a
     stray "revoke" ahead of a real GRANT - it clears a function that is wide
     open, which is the whole failure this file exists to prevent. `[^;]*?`
     keeps a verb inside its own statement. */
  const re = new RegExp(
    String.raw`\b(GRANT|REVOKE)\b([^;]*?)\bON\s+FUNCTION\s+(?:public\.)?(\w+)\s*\(([^)]*)\)([^;]*?);`,
    'gi'
  );
  let m;
  while ((m = re.exec(sql))) {
    if (m[3].toLowerCase() !== name.toLowerCase()) continue;
    const verb = m[1].toUpperCase();
    const named = `${m[2]} ${m[5]}`.toLowerCase();
    for (const role of BROWSER_ROLES) {
      if (new RegExp(String.raw`\b${role}\b`).test(named)) {
        held[role] = verb === 'GRANT';
      }
    }
  }
  return held;
}

function browserReachable(sql, name) {
  const held = effectiveGrants(sql, name);
  return held.public || held.anon || held.authenticated;
}

/**
 * Can a caller with NO ACCOUNT execute it?
 *
 * `anon` inherits everything PUBLIC holds, so a function that was never granted
 * anything is anon-reachable by default — the same silence-means-open rule the
 * writer check uses. Revoking from `authenticated` alone does not close it.
 */
function anonReachable(sql, name) {
  const held = effectiveGrants(sql, name);
  return held.public || held.anon;
}

function loadAllowlist(key = 'reviewedExceptions') {
  if (!existsSync(ALLOWLIST)) return new Map();
  const raw = JSON.parse(readFileSync(ALLOWLIST, 'utf8'));
  const entries = raw[key] ?? {};
  return new Map(Object.entries(entries));
}

/**
 * The whole rule, in one place, so the test can exercise it directly rather
 * than assert on a message. A gate nobody has watched fail is a gate nobody
 * knows works: tests/definer-authorization-gate.test.ts feeds this the exact
 * shapes that shipped, including the revoke-from-PUBLIC-only trap.
 *
 * Returns the names this SQL declares that break the rule.
 */
/**
 * True when the body derives identity from auth.uid() but FALLS BACK to
 * something the caller controls.
 *
 * `COALESCE(auth.uid(), p_actor_user_id)` is the shape that shipped in
 * fn_club_set_member_role. A LITERAL fallback is deliberately allowed:
 * `COALESCE(auth.role(), 'service_role')` is the documented way to recognise a
 * trusted backend and cannot be steered from a browser.
 */
export function spoofableIdentityFallback(body) {
  const re = /coalesce\s*\(\s*auth\.(?:uid|role|jwt)\s*\(\s*\)\s*,\s*([^),]+)/gi;
  let m;
  while ((m = re.exec(body)) !== null) {
    const fallback = m[1].trim();
    if (/^'([^']*)'$/.test(fallback) || /^[0-9.]+$/.test(fallback)) continue;
    return true;
  }
  return false;
}

export function unauthorisedWriters(sql, allowlist = new Set(), grantSql = sql) {
  const clean = stripComments(sql);
  /* GRANTS ARE READ ACROSS THE WHOLE BRANCH (2026-08-31). A branch's migrations
     are applied as a unit, so a REVOKE landing in a sibling migration in the
     same pull request really does close the function. Reading one file alone
     reports a hole that will never exist — which is exactly what happened to
     fn_definer_exposure_audit, whose body contains the literal string
     '(insert into|update |delete from)' as its own detection regex and so reads
     as a writer. Its REVOKE is in the next migration along.

     The write-detection regex is deliberately NOT taught to ignore string
     literals: `EXECUTE 'insert into ...'` is a real write, and a blind spot
     there would be worse than an occasional false positive here.

     `grantSql` defaults to `sql`, so every test that passes a single migration
     behaves exactly as before. */
  const grants = grantSql === sql ? clean : stripComments(grantSql);
  const out = [];
  for (const fn of declaredFunctions(clean)) {
    if (!/SECURITY\s+DEFINER/i.test(fn.header)) continue;
    if (/RETURNS\s+(?:event_)?trigger\b/i.test(fn.header)) continue;
    if (!/(?:^|[^a-z_])(?:insert\s+into|update\s+[a-z_"]|delete\s+from)/i.test(fn.body)) continue;
    if (!browserReachable(grants, fn.name)) continue;
    /* ASKING, THEN ACCEPTING THE CALLER'S ANSWER, IS NOT ASKING (2026-08-31).
       The test below used to be the whole rule: mention auth.uid() anywhere and
       you were cleared. `fn_club_set_member_role` mentioned it - inside
       `COALESCE(auth.uid(), p_actor_user_id)` - and held EXECUTE for PUBLIC and
       anon. auth.uid() is NULL for anon BY DEFINITION, so that COALESCE fell
       through to a value the CALLER supplied, and fn_club_grantable_roles then
       authorised against the spoofed actor: an unauthenticated caller could
       name any club owner and set any member's role, co_owner included.

       The guidance this script prints already said "Never from a parameter: a
       caller-supplied ...". It did not enforce its own sentence. It does now. */
    if (spoofableIdentityFallback(fn.body) && !allowlist.has(fn.name)) {
      out.push(fn.name);
      continue;
    }
    if (/auth\.(?:uid|role|jwt)\s*\(/i.test(fn.body)) continue;
    if (allowlist.has(fn.name)) continue;
    out.push(fn.name);
  }
  return out;
}

/**
 * ─── THE SECOND RULE: READ-ONLY IS NOT THE SAME AS HARMLESS (2026-08-31) ─────
 *
 * `unauthorisedWriters` above only ever looks at functions that WRITE. That was
 * the whole rule for four days, and in one afternoon THREE new SECURITY DEFINER
 * functions arrived anon-executable and walked straight past it, because every
 * one of them was read-only:
 *
 *   fn_tournament_metrics    operator dashboard numbers
 *   fn_truly_unused_indexes  table names, index names, sizes, scan counts
 *   fn_nit_evictions         who was evicted from which table, and when
 *
 * None writes a row, so none was a "writer". All three ran as the owner with
 * BYPASSRLS and answered a caller with no account. The third one hands over a
 * partial column map of the schema for free.
 *
 * THE RULE. A function this branch declares fails when it is
 *
 *     SECURITY DEFINER  and  anon can execute it
 *     and  the body never consults auth.uid() / auth.role() / auth.jwt()
 *     and  it is not on the anonPublicSurface allowlist
 *
 * — whether or not it writes. Consulting auth is the exemption because a
 * function that asks who is calling is at least AWARE there is a caller; one
 * that never asks cannot be authorising anything.
 *
 * ANON, NOT "BROWSER". The writer rule fails on public OR anon OR
 * authenticated, because a logged-in player must not be able to move money
 * unchecked. This rule fails only on public OR anon, because a great many
 * read-only functions are legitimately open to a logged-in player and failing
 * those would train everybody to stuff the allowlist. The line worth defending
 * is the one before login.
 *
 * TRIGGERS are out of scope for the same reason as above: `RETURNS trigger`
 * cannot be reached as an RPC, so the grant is inert.
 *
 * THE ALLOWLIST IS THE POINT, not a loophole. Leaderboards, name-availability
 * checks and public profiles genuinely must answer a caller with no account.
 * Each one goes in scripts/ci/definer-authorization.allowlist.json under
 * `anonPublicSurface` with a written reason — so that "an unauthenticated
 * caller may run this" becomes a sentence a human typed, instead of a default
 * nobody chose.
 */
/**
 * GRANTS ARE READ ACROSS THE WHOLE BRANCH, not just the declaring file
 * (2026-08-31). A branch's migrations are applied as a unit, so a REVOKE that
 * lands in a sibling migration in the same pull request really does close the
 * function — reading one file in isolation would report a hole that will never
 * exist. `grantSql` defaults to `sql`, so a caller passing a single migration
 * (every test below) behaves exactly as before.
 */
export function anonReadableDefiners(sql, allowlist = new Set(), grantSql = sql) {
  const clean = stripComments(sql);
  const grants = grantSql === sql ? clean : stripComments(grantSql);
  const out = [];
  for (const fn of declaredFunctions(clean)) {
    if (!/SECURITY\s+DEFINER/i.test(fn.header)) continue;
    if (/RETURNS\s+(?:event_)?trigger\b/i.test(fn.header)) continue;
    if (!anonReachable(grants, fn.name)) continue;
    if (/auth\.(?:uid|role|jwt)\s*\(/i.test(fn.body)) continue;
    if (allowlist.has(fn.name)) continue;
    out.push(fn.name);
  }
  return out;
}

/**
 * --- THE FOURTH RULE: A ROSTER NOBODY CAN BE SCOPED OUT OF (2026-09-06) -----
 *
 * WHY, and why it is not simply "extend rule 2 to authenticated".
 *
 * `fn_bbj_unclaimed_shares()` shipped on 2026-09-06 returning EVERY unpaid
 * bad-beat-jackpot share on the platform - player id, arena name, amount,
 * table, hand, reason - as SECURITY DEFINER, with no REVOKE and no GRANT, so
 * Postgres's default handed EXECUTE to PUBLIC and every logged-in account
 * inherited it. It is a READ, so rule 1 (writers) did not judge it; it is
 * reachable by `authenticated` rather than `anon`, so rule 2 did not either.
 * It fell exactly between them. The live check
 * `check-telemetry-exposure.mjs` caught it fourteen minutes after it landed -
 * the net working, but after the fact.
 *
 * Rule 2's header explains, correctly, why it stops at `anon`: "a great many
 * read-only functions are legitimately open to a logged-in player and failing
 * those would train everybody to stuff the allowlist." Widening rule 2 would
 * do precisely the harm it warns about. So this rule does not widen it. It
 * names the NARROW shape that is never a legitimate player read:
 *
 *     SECURITY DEFINER  and  a browser role can execute it
 *     and  it takes NO ARGUMENTS          -> it cannot be scoped to a caller
 *     and  it RETURNS SETOF / TABLE       -> it enumerates rows, it does not
 *                                            answer one question
 *     and  the body never consults auth.uid() / auth.role() / auth.jwt()
 *     and  it is not on the anonPublicSurface allowlist
 *
 * All four conditions together mean: a definer that bypasses RLS, hands back a
 * list, and has no way of knowing or limiting who asked. That is an operator
 * console, and it is the same judgement
 * `fn_ca_browser_reachable_telemetry()` makes against the live database -
 * moved to the branch, so it is refused before it is applied instead of
 * reported after.
 *
 * A parameterless definer returning a SCALAR is untouched (a count, a flag, a
 * name-availability check), and so is any function that takes an argument -
 * both are the ordinary shapes of a legitimate logged-in read.
 */
export function unscopedRosterDefiners(sql, allowlist = new Set(), grantSql = sql) {
  const clean = stripComments(sql);
  const grants = grantSql === sql ? clean : stripComments(grantSql);
  const out = [];
  for (const fn of declaredFunctions(clean)) {
    if (!/SECURITY\s+DEFINER/i.test(fn.header)) continue;
    if (/RETURNS\s+(?:event_)?trigger\b/i.test(fn.header)) continue;
    if (!browserReachable(grants, fn.name)) continue;
    if (/auth\.(?:uid|role|jwt)\s*\(/i.test(fn.body)) continue;
    if (allowlist.has(fn.name)) continue;

    // No arguments: `name(` immediately followed by `)`, allowing whitespace.
    // An argument list is the caller's chance to be scoped, so its presence
    // takes the function out of this rule entirely.
    const takesNoArgs = new RegExp(
      `FUNCTION\\s+(?:public\\.)?${fn.name}\\s*\\(\\s*\\)`,
      'i'
    ).test(fn.header);
    if (!takesNoArgs) continue;

    // Returns a set: SETOF ..., or TABLE(...). A scalar return answers one
    // question and is not a roster.
    if (!/RETURNS\s+(?:SETOF\b|TABLE\s*\()/i.test(fn.header)) continue;

    out.push(fn.name);
  }
  return out;
}

/**
 * --- THE THIRD RULE: A CLONE IS A DECLARATION (2026-09-01) ------------------
 *
 * Everything above reads `CREATE FUNCTION`. On 2026-09-01 a function arrived
 * that never wrote those two words.
 *
 * 20260901090000_club_card_human_realtime_stats.sql needed three functions
 * duplicated under new names, so it did what the database makes easy: read the
 * old definition with pg_get_functiondef, rewrite the name in the text, and
 * EXECUTE it.
 *
 *   IF to_regprocedure('public.fn_join_club_membership_impl(uuid)') IS NULL THEN
 *     SELECT pg_get_functiondef('public.fn_join_club(uuid)'::regprocedure) INTO v_def;
 *     v_def := regexp_replace(v_def, 'FUNCTION public\.fn_join_club\(',
 *       'FUNCTION public.fn_join_club_membership_impl(', 1, 1);
 *     EXECUTE v_def;
 *   END IF;
 *
 * Two of the three clones were revoked from PUBLIC, anon and authenticated in
 * that same file. The third, fn_seat_club_for_user_membership_unchecked, was
 * not, and CREATE FUNCTION grants EXECUTE to PUBLIC by default. It went live
 * SECURITY DEFINER, owned by postgres, answering any caller with no account at
 * all: hand it a user id and a table id and it returns which club that player
 * is seated under and which clubs they belong to.
 *
 * The author knew the rule -- they applied it twice in the same block, and
 * revoked the wrapper four lines earlier. This gate simply had nothing to
 * judge, because a clone is not spelled `CREATE FUNCTION`. The daily live
 * audit found it hours after it shipped, which is the right backstop and the
 * wrong moment.
 *
 * THE RULE. A name this migration clones into must have its grants stated. A
 * clone starts PUBLIC-executable like any other new function, so silence is
 * open here too, and unlike a declaration the file cannot tell us whether the
 * body consults auth.uid() -- the body lives in the database. There is
 * therefore no "it asks who is calling" exemption to earn: either the
 * migration says who may execute the clone, or it does not ship.
 *
 * READING A CLONE. Two signals, both from the file:
 *   * a `'FUNCTION public.<name>('` string literal -- how the new name is
 *     spliced into the definition text;
 *   * MINUS every name handed to pg_get_functiondef, which is the SOURCE being
 *     copied and already exists with grants of its own.
 * The source half of the regexp_replace is a regular expression, so its dot
 * and paren are escaped, but subtracting the pg_get_functiondef argument is
 * what actually tells source from target -- and it keeps working if somebody
 * writes the pattern unescaped.
 */
export function clonedFunctions(sql) {
  const clean = stripComments(sql);
  const spliced = new Set();
  const nameInLiteral = /'FUNCTION\s+public\\?\.([A-Za-z_]\w*)\\?\s*\(/g;
  let m;
  while ((m = nameInLiteral.exec(clean))) spliced.add(m[1]);

  const sources = new Set();
  const fromDefinition = /pg_get_functiondef\s*\(\s*'\s*(?:public\.)?([A-Za-z_]\w*)\s*\(/gi;
  while ((m = fromDefinition.exec(clean))) sources.add(m[1]);

  return [...spliced].filter((n) => !sources.has(n));
}

/**
 * The clone rule, in the same shape as the two above so the test can drive it
 * directly. Returns the cloned names a caller with no account could execute.
 */
export function unrevokedClones(sql, allowlist = new Set(), grantSql = sql) {
  const clean = stripComments(sql);
  const grants = grantSql === sql ? clean : stripComments(grantSql);
  return clonedFunctions(clean).filter((name) => anonReachable(grants, name) && !allowlist.has(name));
}

export {
  stripComments,
  declaredFunctions,
  browserReachable,
  anonReachable,
  effectiveGrants,
};

function main() {
  const base = ALL ? null : baseRef();
  const files = ALL
    ? readdirSync(join(REPO, DIR))
        .filter((f) => f.endsWith('.sql'))
        .sort()
        .map((f) => DIR + f)
    : changedMigrations(base);

  if (files.length === 0) {
    console.log(
      `[check-definer-authorization] no new migrations against ${base} — nothing to check.`
    );
    return;
  }

  const allowlist = new Set(loadAllowlist().keys());
  const anonAllowlist = new Set(loadAllowlist('anonPublicSurface').keys());
  const offenders = [];
  const anonOffenders = [];
  const cloneOffenders = [];
  const rosterOffenders = [];
  let inspected = 0;

  // Every migration this branch touches, concatenated, so a REVOKE in one file
  // is seen by a declaration in another. They ship together; they are read
  // together. See anonReadableDefiners for why.
  const branchSql = files
    .map((f) => join(REPO, f))
    .filter((p) => existsSync(p))
    .map((p) => readFileSync(p, 'utf8'))
    .join('\n');

  for (const file of files) {
    const path = join(REPO, file);
    if (!existsSync(path)) continue;
    const sql = readFileSync(path, 'utf8');
    inspected += declaredFunctions(stripComments(sql)).filter((f) =>
      /SECURITY\s+DEFINER/i.test(f.header)
    ).length;
    for (const name of unauthorisedWriters(sql, allowlist, branchSql)) {
      offenders.push({ name, file });
    }
    // A writer already reported above is not reported twice: the writer verdict
    // is the more specific one and its guidance is the one worth reading.
    const alreadyNamed = new Set(offenders.map((o) => o.name));
    for (const name of anonReadableDefiners(sql, anonAllowlist, branchSql)) {
      if (!alreadyNamed.has(name)) anonOffenders.push({ name, file });
    }
    // A clone is judged on its grants alone: its body is in the database, not
    // in this file, so there is no auth.uid() exemption to read.
    for (const name of unrevokedClones(sql, anonAllowlist, branchSql)) {
      cloneOffenders.push({ name, file });
    }
    // Rule 4: a no-argument, set-returning definer a browser can reach.
    // Reported only when nothing above already named it, for the same reason
    // the anon rule defers to the writer rule: one verdict per function, and
    // the more specific guidance wins.
    const named = new Set([
      ...offenders.map((o) => o.name),
      ...anonOffenders.map((o) => o.name),
      ...cloneOffenders.map((o) => o.name),
    ]);
    for (const name of unscopedRosterDefiners(sql, anonAllowlist, branchSql)) {
      if (!named.has(name)) rosterOffenders.push({ name, file });
    }
  }

  if (rosterOffenders.length > 0) {
    console.error('');
    console.error(
      '[check-definer-authorization] BLOCKED -- a roster nobody can be scoped out of.'
    );
    console.error('');
    for (const o of rosterOffenders) {
      console.error(`  ${o.name}`);
      console.error(`    declared in ${o.file}`);
      console.error('    SECURITY DEFINER, so RLS does not apply. It takes NO ARGUMENTS, so it');
      console.error('    cannot be scoped to a caller. It RETURNS A SET, so it hands back a list');
      console.error('    rather than answering one question. And it never consults auth.uid(),');
      console.error('    auth.role() or auth.jwt(), so it cannot tell who is asking. A browser');
      console.error('    role can execute it.');
      console.error('');
    }
    console.error('  On 2026-09-06 fn_bbj_unclaimed_shares() shipped in exactly this shape and');
    console.error('  returned EVERY unpaid bad-beat-jackpot share on the platform - player name,');
    console.error('  amount, table, hand - to any account that could log in. It was a read, so');
    console.error('  the writer rule did not judge it; it was reachable by `authenticated` and');
    console.error('  not `anon`, so the anon rule did not either. It fell between them.');
    console.error('');
    console.error('  Postgres grants EXECUTE to PUBLIC on every new function. Silence is not');
    console.error('  "closed" - silence is "open to everyone".');
    console.error('');
    console.error('  Pick one:');
    console.error('');
    console.error('  1. NOBODY IN A BROWSER SHOULD CALL IT (usually true for an operator read):');
    console.error(
      '       REVOKE ALL ON FUNCTION public.<name>() FROM PUBLIC, anon, authenticated;'
    );
    console.error('       GRANT EXECUTE ON FUNCTION public.<name>() TO service_role;');
    console.error('');
    console.error('  2. A PLAYER SHOULD SEE THEIR OWN ROWS. Filter on auth.uid() inside the');
    console.error('     function. That both scopes it and satisfies this rule.');
    console.error('');
    console.error('  3. IT IS GENUINELY A PUBLIC LIST (a leaderboard, a lobby). Add it to the');
    console.error('     anonPublicSurface block of scripts/ci/definer-authorization.allowlist.json');
    console.error('     with a reason saying why every row in it is safe for anyone to read.');
    console.error('');
    process.exit(1);
  }

  if (cloneOffenders.length > 0) {
    console.error('');
    console.error('[check-definer-authorization] BLOCKED -- a clone with nobody named on it.');
    console.error('');
    for (const o of cloneOffenders) {
      console.error(`  ${o.name}`);
      console.error(`    cloned in ${o.file}`);
      console.error('    A function copied into a new name is a NEW function, and a new function');
      console.error('    holds EXECUTE for PUBLIC until something revokes it. This migration never');
      console.error('    says who may execute this one.');
      console.error('');
    }
    console.error('  On 2026-09-01 three functions were cloned in one migration. Two were');
    console.error('  revoked in the same file and the third was not, and it went live answering');
    console.error('  a caller with no account: give it a user id and a table id and it returned');
    console.error('  which club that player was seated under and which clubs they belonged to.');
    console.error('');
    console.error('  There is no "the body checks auth.uid()" exemption here. The body lives in');
    console.error('  the database, not in this file, so the grants have to be said out loud:');
    console.error('');
    console.error(
      '       REVOKE ALL ON FUNCTION public.<name>(<types>) FROM PUBLIC, anon, authenticated;'
    );
    console.error('       GRANT EXECUTE ON FUNCTION public.<name>(<types>) TO service_role;');
    console.error('');
    console.error('  Keep `authenticated` instead if a logged-in player calls it directly. If it');
    console.error('  is genuinely open to callers with no account, add it to the');
    console.error('  anonPublicSurface block of scripts/ci/definer-authorization.allowlist.json');
    console.error('  with a reason.');
    console.error('');
    process.exit(1);
  }

  if (anonOffenders.length > 0) {
    console.error('');
    console.error('[check-definer-authorization] BLOCKED — reachable without an account.');
    console.error('');
    for (const o of anonOffenders) {
      console.error(`  ${o.name}`);
      console.error(`    declared in ${o.file}`);
      console.error('    SECURITY DEFINER, anon can execute it, and it never calls auth.uid(),');
      console.error('    auth.role() or auth.jwt(). It runs as the owner, past RLS, for a caller');
      console.error('    with no account — and it never asks who that caller is.');
      console.error('');
    }
    console.error('  READ-ONLY IS NOT THE SAME AS HARMLESS. On 2026-08-31 three functions');
    console.error('  arrived this way in one afternoon, every one of them read-only, and the');
    console.error('  writer check above cleared all three. One of them returned every table');
    console.error('  name, index name and index size in the schema to anybody who asked.');
    console.error('');
    console.error('  Pick one, in this order of preference:');
    console.error('');
    console.error('  1. IT IS OPERATOR OR ENGINE TELEMETRY. Almost always true for a metrics,');
    console.error('     audit or diagnostics function. Close it in the same migration:');
    console.error('');
    console.error(
      '       REVOKE ALL ON FUNCTION public.<name>(<types>) FROM PUBLIC, anon, authenticated;'
    );
    console.error('       GRANT EXECUTE ON FUNCTION public.<name>(<types>) TO service_role;');
    console.error('');
    console.error('     Name PUBLIC as well as the roles: anon inherits whatever PUBLIC holds,');
    console.error('     so revoking anon alone reads as a fix and does nothing.');
    console.error('');
    console.error('  2. A LOGGED-IN PLAYER SHOULD READ IT. Revoke PUBLIC and anon, keep');
    console.error('     authenticated. This check only ever fails on the pre-login roles.');
    console.error('');
    console.error('  3. IT IS DELIBERATE PUBLIC SURFACE — a leaderboard, a name-availability');
    console.error('     check, a public profile. Add it to the anonPublicSurface block of');
    console.error('     scripts/ci/definer-authorization.allowlist.json with a reason saying');
    console.error('     what an unauthenticated caller is allowed to learn from it.');
    console.error('');
    console.error('  BEFORE YOU REVOKE, CHECK IT IS NOT AN RLS POLICY HELPER:');
    console.error('');
    console.error('       SELECT polrelid::regclass, polname FROM pg_policy');
    console.error("        WHERE pg_get_expr(polqual, polrelid) ~ '<name>';");
    console.error('');
    console.error('     A policy expression evaluates as the QUERYING role, so revoking a');
    console.error('     helper denies every SELECT on the tables whose policies call it.');
    console.error('     fn_home_is_group_staff backs 15 policies across 8 tables.');
    console.error('');
    process.exit(1);
  }

  if (offenders.length > 0) {
    console.error('');
    console.error('[check-definer-authorization] BLOCKED.');
    console.error('');
    for (const o of offenders) {
      console.error(`  ${o.name}`);
      console.error(`    declared in ${o.file}`);
      console.error('    SECURITY DEFINER, it writes, a browser role can execute it, and it never');
      console.error(
        '    calls auth.uid(), auth.role() or auth.jwt(). It cannot know who is asking.'
      );
      console.error('');
    }
    console.error('  Pick one, in this order of preference:');
    console.error('');
    console.error('  1. NOBODY IN A BROWSER SHOULD CALL IT. Almost always true for a backfill,');
    console.error('     a sweep or a repair pass. Close it in the same migration:');
    console.error('');
    console.error(
      '       REVOKE ALL ON FUNCTION public.<name>(<types>) FROM PUBLIC, anon, authenticated;'
    );
    console.error('       GRANT EXECUTE ON FUNCTION public.<name>(<types>) TO service_role;');
    console.error('');
    console.error('     Name PUBLIC as well as the roles. Revoking one role while PUBLIC still');
    console.error('     holds it reads as a fix and does nothing.');
    console.error('');
    console.error('  2. A PLAYER SHOULD CALL IT, FOR THEMSELVES. Derive the actor from');
    console.error('     auth.uid() inside the function. Never from a parameter: a caller-supplied');
    console.error('     id is a caller-supplied answer. Gate the engine path on');
    console.error(
      "     COALESCE(auth.role(), 'service_role') = 'service_role', not on current_user,"
    );
    console.error('     which SECURITY DEFINER rewrites to the owner and which therefore reports');
    console.error('     the same thing for a browser and for the engine.');
    console.error('');
    console.error('  3. IT GENUINELY CANNOT BE POINTED AT ANYTHING. Add it to');
    console.error('     scripts/ci/definer-authorization.allowlist.json with a reason that says');
    console.error('     why. Two functions qualify today; read them before you add a third.');
    console.error('');
    process.exit(1);
  }

  // The summary names all four rules on purpose. A pass line that describes
  // fewer checks than actually ran teaches the next reader that the ones it
  // omits do not exist - which is how rule 4's shape went unjudged until a
  // live audit found it.
  console.log(
    `[check-definer-authorization] OK — ${inspected} SECURITY DEFINER function(s) declared across ` +
      `${files.length} migration(s); every writer a browser can reach consults the request, ` +
      'nothing new answers a caller with no account, every clone names its grants, ' +
      'and no unscoped set-returning definer is browser-reachable.'
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
