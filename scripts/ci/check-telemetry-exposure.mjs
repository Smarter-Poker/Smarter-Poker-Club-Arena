#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE OPERATOR CONSOLE MUST NOT BE OPEN TO THE BROWSER
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * WHY THIS EXISTS (2026-08-31)
 *
 * fn_chip_integrity_report() is the platform's money posture in seven rows. It
 * is SECURITY DEFINER, so RLS does not apply, and `authenticated` could execute
 * it. Any account that could log in could read the total chip supply, the
 * ledger's throughput, and - the part that matters - which invariant is
 * currently failing.
 *
 * Thirty-eight routines were in that shape. Two migrations closed them:
 *   20260831...  the_operator_console_was_open_to_every_player   (35)
 *   20260831...  three_handles_a_player_could_pull                (3)
 *
 * A sweep is not a guard. This is the reader that keeps the closure true, and
 * it is deliberately thin: all of the judgement lives in
 * fn_ca_browser_reachable_telemetry() in the database, next to the grants it
 * reads, because a rule that lives in a CI script cannot see a grant made by
 * somebody else's migration at 3am.
 *
 * WHAT COUNTS: a routine that is SECURITY DEFINER, executable by anon or
 * authenticated, never consults auth.uid()/auth.role()/auth.jwt()/the request,
 * takes no identity argument, is not a trigger function, is not PostGIS, and is
 * not on ca_browser_definer_allowlist with a written reason.
 *
 * Zero rows is the healthy state. Anything else is a routine that answers about
 * the whole platform to whoever asks.
 *
 * Usage:
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
 *     node scripts/ci/check-telemetry-exposure.mjs [--json]
 *
 * Exit: 0 clean · 1 something is open · 2 script error
 */
import { supabaseServerHeaders } from './supabase-auth-headers.mjs';

const args = process.argv.slice(2);
const AS_JSON = args.includes('--json');

const URL_BASE = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!URL_BASE || !KEY) {
  console.error('check-telemetry-exposure: set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.');
  process.exit(2);
}

async function rpc(name, body = {}) {
  const res = await fetch(`${URL_BASE}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: supabaseServerHeaders(KEY, { 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(
      `${name} returned ${res.status}. If it is missing, apply ` +
        `a_guard_where_the_definer_sweep_was. ${text.slice(0, 300)}`
    );
  }
  return res.json();
}

async function main() {
  const open = await rpc('fn_ca_browser_reachable_telemetry');

  if (AS_JSON) {
    console.log(JSON.stringify({ unaccounted: open.length, routines: open }, null, 1));
    process.exit(open.length === 0 ? 0 : 1);
  }

  if (open.length === 0) {
    console.log(
      '\n[telemetry-exposure] no unscoped operator routine is reachable from a browser.\n'
    );
    process.exit(0);
  }

  console.error('\n[telemetry-exposure] FAILED: the operator console is open to the browser.\n');
  console.error(
    '  These are SECURITY DEFINER, take no identity argument, never look at who is'
  );
  console.error('  calling, and a logged-in account can execute them:\n');
  for (const r of open) {
    console.error(
      `  ${String(r.proname).padEnd(40)} ${String(r.volatility).padEnd(9)} ${r.reached_by}`
    );
    if (r.args) console.error(`  ${''.padEnd(40)} (${r.args})`);
  }
  console.error('\n  Close it:');
  console.error('    REVOKE ALL ON FUNCTION public.<name>(<args>) FROM public, anon, authenticated;');
  console.error('    GRANT EXECUTE ON FUNCTION public.<name>(<args>) TO service_role;');
  console.error('\n  Or, if a browser genuinely needs it, record the decision WITH ITS REASON:');
  console.error(
    "    INSERT INTO public.ca_browser_definer_allowlist(proname, reason) VALUES ('<name>', '<why>');"
  );
  console.error('');
  process.exit(1);
}

main().catch((err) => {
  console.error(`check-telemetry-exposure: ${err.message}`);
  process.exit(2);
});
