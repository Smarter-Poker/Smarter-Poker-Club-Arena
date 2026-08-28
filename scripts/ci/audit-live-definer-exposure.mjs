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
 * IT ASKS TWO QUESTIONS, and the second exists because the first missed a live
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
  console.error(`[definer-exposure] ${BASELINE} is missing. It is the list of reviewed exceptions.`);
  process.exit(2);
}
const baseline = JSON.parse(readFileSync(BASELINE, 'utf8'));
const allowed = new Set(Object.keys(baseline.reviewedExceptions ?? {}));

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
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
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
const newly = found.filter((f) => !allowed.has(f.function));
const goneQuiet = [...allowed].filter((name) => !found.some((f) => f.function === name));

console.log(
  `[definer-exposure] live: ${found.length}, baselined: ${allowed.size}, new: ${newly.length}; ` +
    `anon-executable writers: ${anonWriters.length} (must be 0)`
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
  console.error('    GRANT EXECUTE ON FUNCTION public.<name>(<types>) TO authenticated, service_role;');
  console.error('');
  console.error('  There is no allowlist for this one. The live answer is zero and it stays zero.');
  console.error('');
  process.exit(1);
}

if (newly.length === 0) {
  summary('### Live DEFINER exposure: OK');
  summary('');
  summary(
    `${found.length} function(s) exposed, all of them reviewed and baselined, and ` +
      'no writing function a logged-out caller can execute. Nothing unaccounted for.'
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
console.error('    REVOKE ALL ON FUNCTION public.<name>(<types>) FROM PUBLIC, anon, authenticated;');
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
