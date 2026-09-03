#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  THE SWEEP THAT FOUND NINETEEN, REPEATED EVERY DAY
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * WHY THIS EXISTS (2026-08-28)
 *
 * A hand-written query on 2026-08-27 found NINETEEN SECURITY DEFINER functions
 * that write, that a browser role could execute, and that never referenced
 * auth.uid(), auth.role() or auth.jwt() - so they could not know who was
 * calling. One let an ordinary member rewrite a club's member_count from 592 to
 * 10,591. Another pays chips.
 *
 * check-definer-authorization.mjs stops a new one arriving through a MIGRATION
 * IN THIS REPOSITORY. It cannot see the live database, and this estate applies
 * schema straight to production through the Supabase MCP. That is not an edge
 * case, it is the normal path, and it is how every one of the last three
 * arrived:
 *
 *   fn_pay_backed_payout_shortfalls   hours after the sweep (#1547)
 *   fn_backpay_spin_unpaid_winners    found by THIS script's first run
 *   fn_requeue_unbanked_fees          found by THIS script's first run
 *
 * A gate on the repository and no eye on production leaves the door open that
 * all three came through. So the sweep itself becomes a daily job, run by the
 * Schema Manifest Refresh workflow, which already holds the service-role key
 * and already runs at 05:20 UTC.
 *
 * HOW IT DECIDES. fn_definer_exposure_audit() returns the live answer using the
 * same predicate the CI gate uses, in the same words, so the two cannot drift
 * into disagreeing about what is dangerous. This compares that answer to
 * scripts/ci/definer-exposure-baseline.json, which holds the functions that were
 * read line by line and deliberately kept.
 *
 *   something NEW appears        -> fail, and say exactly what and how to close it
 *   something baselined is gone  -> succeed, and say the baseline can shrink
 *
 * IT ASKS FOUR QUESTIONS, and each one after the first exists because the ones
 * before it missed something real.
 *
 * The second exists because the first missed a live
 * exploit. `unauthenticated_writers` finds functions that never reference
 * auth.uid(), auth.role() or auth.jwt(). process_tournament_rebuy DOES
 * reference auth.uid() - just uselessly:
 *
 *     IF auth.uid() IS NOT NULL AND auth.uid() <> p_user_id THEN ... refuse
 *
 * which skips the check for a caller who has no auth.uid() at all. `anon` had
 * EXECUTE, so an unauthenticated call bought a rebuy for a real seated player
 * and took the chips out of their balance. Mentioning the request is not the
 * same as being bound by it, and no predicate about guard TEXT can tell those
 * apart. So `anon_writers` asks a blunter question that needs no reasoning at
 * all: can a logged-out caller execute a SECURITY DEFINER function that writes?
 * The live answer is zero, and it should stay zero.
 *
 * The third, `rls_disabled_writable`, is a table in `public` with RLS off that
 * a browser role can write: no policy in the way and no function either, so
 * the grant is the whole story.
 *
 * THE FOURTH, `anon_readers`, was added 2026-08-31 because the first three are
 * ALL ABOUT WRITES. Three SECURITY DEFINER functions were found anon-executable
 * that every one of them cleared, because not one of them writes a row:
 *
 *   fn_tournament_metrics    operator dashboard numbers
 *   fn_truly_unused_indexes  table names, index names, sizes, scan counts
 *   fn_nit_evictions         who was evicted from which table, and when
 *
 * The middle one hands an unauthenticated caller a partial column map of the
 * schema, because index names here encode their columns. Reading is not
 * writing and this question is not the same severity as `anon_writers` - but
 * three arrived in one afternoon while this script reported all clear.
 *
 * Unlike questions 1 and 2, question 4 needs a baseline (`reviewedAnonReaders`):
 * a leaderboard and a name-availability check genuinely must answer somebody
 * with no account. The finding is anything NEW.
 *
 * IT NEVER FAILS ON AN UNREADABLE DATABASE. A network problem is not a security
 * finding, and a script that cries wolf when Supabase hiccups is one whose red
 * runs get waved through - which is precisely how the alarm this replaces would
 * stop working.
 *
 * Usage:  SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/ci/audit-live-definer-exposure.mjs
 * Exit:   0 clean or unreachable · 1 new live exposure · 2 misconfigured
 */
import { readFileSync, existsSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { supabaseServerHeaders } from './supabase-auth-headers.mjs';

const REPO = process.cwd();
const BASELINE = join(REPO, 'scripts/ci/definer-exposure-baseline.json');
const URL_ = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

/**
 * `require` does not exist in an ES module. A first draft called it here inside
 * a try/catch, so every summary line would have thrown ReferenceError and been
 * swallowed - the step would have reported success and written nothing, which is
 * the exact silent-no-op shape this whole body of work is about.
 */
const summary = (line) => {
  if (!process.env.GITHUB_STEP_SUMMARY) return;
  try {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, line + '\n');
  } catch {
    /* a summary is a convenience, never a reason to fail the audit */
  }
};

if (!existsSync(BASELINE)) {
  console.error(
    `[definer-exposure] ${BASELINE} is missing. It is the list of reviewed exceptions.`
  );
  process.exit(2);
}
const baseline = JSON.parse(readFileSync(BASELINE, 'utf8'));
const allowed = new Set(Object.keys(baseline.reviewedExceptions ?? {}));
// Tables in `public` with RLS off that a browser role can write. Separate list
// because the remedy is different: there is no guard to fix, only a grant.
const allowedTables = new Set(Object.keys(baseline.reviewedTables ?? {}));
/* Question 4's baseline: SECURITY DEFINER functions a LOGGED-OUT caller may
   execute that only READ. Unlike anon_writers this one needs a list, because a
   leaderboard, a name-availability check and a public profile genuinely must
   answer somebody with no account. The finding is anything NEW. */
const allowedReaders = new Set(Object.keys(baseline.reviewedAnonReaders ?? {}));

if (!URL_ || !KEY) {
  console.error(
    '[definer-exposure] SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required. ' +
      'This audit asks PRODUCTION a question the repository cannot answer.'
  );
  process.exit(2);
}

let live;
try {
  const res = await fetch(`${URL_}/rest/v1/rpc/fn_definer_exposure_audit`, {
    method: 'POST',
    headers: supabaseServerHeaders(KEY, { 'Content-Type': 'application/json' }),
    body: '{}',
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  live = await res.json();
} catch (err) {
  // Unreachable is not a finding. Say so loudly and pass.
  console.log(`::warning title=DEFINER AUDIT DID NOT RUN::${String(err)}`);
  summary('### Live DEFINER exposure: not checked');
  summary('');
  summary('The database could not be reached, so this run proves nothing either way.');
  process.exit(0);
}

// The RPC returned a bare array before it learned its second question. Accept
// both shapes so a manifest-refresh run against an older database reports
// honestly instead of throwing.
const found = Array.isArray(live) ? live : (live?.unauthenticated_writers ?? []);
const anonWriters = Array.isArray(live) ? [] : (live?.anon_writers ?? []);
const rlsOffWritable = Array.isArray(live) ? [] : (live?.rls_disabled_writable ?? []);
// Question 4, added 2026-08-31. Absent on an older database, which reads as an
// empty list rather than a throw — same tolerance as the other three.
const anonReaders = Array.isArray(live) ? [] : (live?.anon_readers ?? []);
const newReaders = anonReaders.filter((f) => !allowedReaders.has(f.function));
const newTables = rlsOffWritable.filter((t) => !allowedTables.has(t.table));
const newly = found.filter((f) => !allowed.has(f.function));
const goneQuiet = [...allowed].filter((name) => !found.some((f) => f.function === name));

console.log(
  `[definer-exposure] live: ${found.length}, baselined: ${allowed.size}, new: ${newly.length}; ` +
    `anon-executable writers: ${anonWriters.length} (must be 0); ` +
    `RLS-off writable tables: ${rlsOffWritable.length} (${newTables.length} new); ` +
    `anon-readable functions: ${anonReaders.length} (${newReaders.length} new)`
);

if (goneQuiet.length > 0) {
  console.log(
    `[definer-exposure] no longer exposed, so the baseline can shrink: ${goneQuiet.join(', ')}`
  );
}

// A logged-out caller executing a writing function is never acceptable, so this
// one has no baseline and no exception. It is separate from the list above
// because it needs no judgement: the grant IS the finding.
if (anonWriters.length > 0) {
  console.error('');
  console.error('[definer-exposure] A LOGGED-OUT CALLER CAN EXECUTE A WRITING FUNCTION.');
  console.error('');
  summary('### Live DEFINER exposure: ANON CAN WRITE');
  summary('');
  for (const f of anonWriters) {
    console.error(`  ${f.function}(${f.args})  executable by anon`);
    summary(`- \`${f.function}(${f.args})\` executable by **anon**`);
  }
  console.error('');
  console.error('  Whatever its internal checks say, revoke it. The rebuy hole of');
  console.error('  2026-08-28 was a guard that read auth.uid() and skipped itself when');
  console.error('  there was none, and the only thing between that and a live exploit');
  console.error('  was this grant:');
  console.error('');
  console.error('    REVOKE ALL ON FUNCTION public.<name>(<types>) FROM PUBLIC, anon;');
  console.error(
    '    GRANT EXECUTE ON FUNCTION public.<name>(<types>) TO authenticated, service_role;'
  );
  console.error('');
  console.error('  There is no allowlist for this one. The live answer is zero and it stays zero.');
  console.error('');
  process.exit(1);
}

// A table with RLS off that a browser can write has no guard in front of it at
// all: the grant is the whole story. A new one is the most expensive single
// mistake available in this schema, and it is completely silent.
if (newTables.length > 0) {
  console.error('');
  console.error('[definer-exposure] A TABLE WITH RLS OFF IS WRITABLE FROM A BROWSER.');
  console.error('');
  summary('### Live exposure: RLS OFF AND WRITABLE');
  summary('');
  for (const t of newTables) {
    const roles = [t.anon_write ? 'anon' : null, t.authenticated_write ? 'authenticated' : null]
      .filter(Boolean)
      .join(', ');
    console.error(`  ${t.table}  writable by: ${roles}  (owner ${t.owner})`);
    summary(`- \`${t.table}\` writable by ${roles}, owner \`${t.owner}\``);
  }
  console.error('');
  console.error('  Enable RLS and give it a policy, or revoke the writes:');
  console.error('');
  console.error('    ALTER TABLE public.<name> ENABLE ROW LEVEL SECURITY;');
  console.error(
    '    REVOKE INSERT, UPDATE, DELETE ON TABLE public.<name> FROM PUBLIC, anon, authenticated;'
  );
  console.error('');
  console.error('  Check the OWNER first. A REVOKE only removes grants YOU made: postgres');
  console.error('  cannot revoke what supabase_admin granted, and the attempt fails silently.');
  console.error('  That is why spatial_ref_sys is baselined rather than fixed.');
  console.error('');
  process.exit(1);
}

/* A NEW FUNCTION THAT ANSWERS A CALLER WITH NO ACCOUNT. Reported after the
   three write findings above because it is genuinely less severe than any of
   them — and reported at all because on 2026-08-31 three of these arrived in a
   single afternoon while this script said all clear. Every question it asked
   was about writes, and not one of the three wrote a row:

     fn_tournament_metrics    operator dashboard numbers
     fn_truly_unused_indexes  table names, index names, sizes, scan counts
     fn_nit_evictions         who was evicted from which table, and when

   The middle one returns the schema's table and index names to anybody who
   asks, and index names here encode their columns. That is the reconnaissance
   step, free. */
if (newReaders.length > 0) {
  console.error('');
  console.error('[definer-exposure] A NEW FUNCTION ANSWERS A CALLER WITH NO ACCOUNT.');
  console.error('');
  summary('### Live DEFINER exposure: ANON CAN READ SOMETHING NEW');
  summary('');
  for (const f of newReaders) {
    console.error(`  ${f.function}(${f.args})  executable by anon, and never asks who is asking`);
    summary(`- \`${f.function}(${f.args})\` readable by **anon**`);
  }
  console.error('');
  console.error('  It runs as the owner, past RLS, for somebody with no account.');
  console.error('');
  console.error('  1. OPERATOR OR ENGINE TELEMETRY — metrics, audits, diagnostics:');
  console.error('');
  console.error(
    '       REVOKE ALL ON FUNCTION public.<name>(<types>) FROM PUBLIC, anon, authenticated;'
  );
  console.error('       GRANT EXECUTE ON FUNCTION public.<name>(<types>) TO service_role;');
  console.error('');
  console.error('     Name PUBLIC too: anon inherits whatever PUBLIC holds, so revoking anon');
  console.error('     alone reads as a fix and does nothing.');
  console.error('');
  console.error('  2. A LOGGED-IN PLAYER SHOULD READ IT — revoke PUBLIC and anon, keep');
  console.error('     authenticated. This question only ever asks about the pre-login roles.');
  console.error('');
  console.error('  3. DELIBERATE PUBLIC SURFACE — add it to reviewedAnonReaders in');
  console.error('     scripts/ci/definer-exposure-baseline.json, saying what an');
  console.error('     unauthenticated caller is allowed to learn from it.');
  console.error('');
  console.error('  CHECK IT IS NOT AN RLS POLICY HELPER BEFORE YOU REVOKE:');
  console.error('');
  console.error('       SELECT polrelid::regclass, polname FROM pg_policy');
  console.error("        WHERE pg_get_expr(polqual, polrelid) ~ '<name>';");
  console.error('');
  console.error('     A policy runs as the QUERYING role, so revoking a helper denies every');
  console.error('     SELECT on the tables whose policies call it. fn_home_is_group_staff');
  console.error('     backs 15 policies across 8 tables; it was fixed by binding it to');
  console.error('     auth.uid() instead, which is option 4 and often the right one:');
  console.error('');
  console.error('  4. MAKE IT ASK. A function that derives the caller from auth.uid() leaves');
  console.error('     this list on its own merits, and keeps working inside a policy.');
  console.error('');
  process.exit(1);
}

const readersGoneQuiet = [...allowedReaders].filter(
  (name) => !anonReaders.some((f) => f.function === name)
);
if (readersGoneQuiet.length > 0) {
  console.log(
    `[definer-exposure] no longer anon-readable, so that baseline can shrink: ${readersGoneQuiet.join(', ')}`
  );
}

if (newly.length === 0) {
  summary('### Live DEFINER exposure: OK');
  summary('');
  summary(
    `${found.length} function(s) exposed, all reviewed and baselined; no writing function a ` +
      `logged-out caller can execute; ${rlsOffWritable.length} RLS-off writable table(s), all ` +
      `baselined; ${anonReaders.length} anon-readable function(s), all baselined. ` +
      'Nothing unaccounted for.'
  );
  process.exit(0);
}

console.error('');
console.error('[definer-exposure] NEW LIVE EXPOSURE.');
console.error('');
summary('### Live DEFINER exposure: NEW');
summary('');
for (const f of newly) {
  const roles = [f.anon ? 'anon' : null, f.authenticated ? 'authenticated' : null]
    .filter(Boolean)
    .join(', ');
  console.error(`  ${f.function}(${f.args})`);
  console.error(`    executable by: ${roles}`);
  console.error('    It writes, and it never consults auth.uid(), auth.role() or auth.jwt(),');
  console.error('    so it cannot know who is calling. SECURITY DEFINER runs it as an owner');
  console.error('    with BYPASSRLS, so the table policies are not behind it either.');
  console.error('');
  summary(`- \`${f.function}(${f.args})\` executable by ${roles}`);
}
console.error('  Almost always the answer is that no browser should call it at all:');
console.error('');
console.error(
  '    REVOKE ALL ON FUNCTION public.<name>(<types>) FROM PUBLIC, anon, authenticated;'
);
console.error('    GRANT EXECUTE ON FUNCTION public.<name>(<types>) TO service_role;');
console.error('');
console.error('  Name PUBLIC as well as the roles: a grant to PUBLIC lets authenticated');
console.error('  straight back in, and revoking one role reads as a fix and does nothing.');
console.error('');
console.error('  If a player really should call it for themselves, derive the actor from');
console.error('  auth.uid() inside the function - never from a parameter, which is a');
console.error('  caller-supplied answer - and gate the engine path on');
console.error("  COALESCE(auth.role(), 'service_role') = 'service_role', never on current_user,");
console.error('  which SECURITY DEFINER rewrites to the owner.');
console.error('');
console.error('  If it genuinely cannot be pointed at anything, add it to');
console.error('  scripts/ci/definer-exposure-baseline.json with a reason that says why.');
console.error('');
process.exit(1);
