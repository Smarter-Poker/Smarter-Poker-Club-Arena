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
 * or modifies:
 *
 *     SECURITY DEFINER  and  it writes  and  a browser role can execute it
 *     and  the body never consults auth.uid() / auth.role() / auth.jwt()
 *         -> FAIL
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
 * ESCAPE HATCH. scripts/ci/definer-authorization.allowlist.json, which carries
 * a written reason per entry. Two functions are in it and both were read line
 * by line. Adding a third is a decision, not a formality: say in the reason why
 * a caller cannot point the function at anything that matters.
 *
 * Usage:  node scripts/ci/check-definer-authorization.mjs [baseRef] [--all]
 * Exit:   0 clean · 1 an unauthorised writer · 2 script error
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
    .filter((l) => l.startsWith(DIR) && l.endsWith('.sql'));
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
function browserReachable(sql, name) {
  const held = { public: true, anon: false, authenticated: false };
  const re = new RegExp(
    String.raw`\b(GRANT|REVOKE)\b([\s\S]*?)\bON\s+FUNCTION\s+(?:public\.)?(\w+)\s*\(([^)]*)\)([\s\S]*?);`,
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
  return held.public || held.anon || held.authenticated;
}

function loadAllowlist() {
  if (!existsSync(ALLOWLIST)) return new Map();
  const raw = JSON.parse(readFileSync(ALLOWLIST, 'utf8'));
  const entries = raw.reviewedExceptions ?? {};
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

export function unauthorisedWriters(sql, allowlist = new Set()) {
  const clean = stripComments(sql);
  const out = [];
  for (const fn of declaredFunctions(clean)) {
    if (!/SECURITY\s+DEFINER/i.test(fn.header)) continue;
    if (/RETURNS\s+trigger\b/i.test(fn.header)) continue;
    if (!/(?:^|[^a-z_])(?:insert\s+into|update\s+[a-z_"]|delete\s+from)/i.test(fn.body)) continue;
    if (!browserReachable(clean, fn.name)) continue;
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

export { stripComments, declaredFunctions, browserReachable };

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
  const offenders = [];
  let inspected = 0;

  for (const file of files) {
    const path = join(REPO, file);
    if (!existsSync(path)) continue;
    const sql = readFileSync(path, 'utf8');
    inspected += declaredFunctions(stripComments(sql)).filter((f) =>
      /SECURITY\s+DEFINER/i.test(f.header)
    ).length;
    for (const name of unauthorisedWriters(sql, allowlist)) {
      offenders.push({ name, file });
    }
  }

  if (offenders.length > 0) {
    console.error('');
    console.error('[check-definer-authorization] BLOCKED.');
    console.error('');
    for (const o of offenders) {
      console.error(`  ${o.name}`);
      console.error(`    declared in ${o.file}`);
      console.error(
        '    SECURITY DEFINER, it writes, a browser role can execute it, and it never'
      );
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
    console.error(
      '       GRANT EXECUTE ON FUNCTION public.<name>(<types>) TO service_role;'
    );
    console.error('');
    console.error('     Name PUBLIC as well as the roles. Revoking one role while PUBLIC still');
    console.error('     holds it reads as a fix and does nothing.');
    console.error('');
    console.error('  2. A PLAYER SHOULD CALL IT, FOR THEMSELVES. Derive the actor from');
    console.error(
      '     auth.uid() inside the function. Never from a parameter: a caller-supplied'
    );
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

  console.log(
    `[check-definer-authorization] OK — ${inspected} SECURITY DEFINER function(s) declared across ` +
      `${files.length} migration(s); every writer a browser can reach consults the request.`
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
