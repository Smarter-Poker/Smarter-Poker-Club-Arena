#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE COPY RULES HAVE TO REACH THE DATABASE TOO
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * WHY THIS EXISTS (2026-08-31)
 *
 * Dan banned em dashes on 2026-08-20 and repeated it on 2026-08-31: "remove
 * any and all m bars as they are banned from use." Two gates enforce it, and
 * both of them read SOURCE:
 *
 *   scripts/ci/check-ui-text.mjs                walks src/, public/, server/src
 *   tests/unit/houseCopyRulesReachEveryPage.test.ts   runs it against fixtures
 *
 * Neither can see a single character of the copy this product's DATABASE
 * serves. A Postgres function that RAISEs a message, or builds a jsonb
 * {'message': ...}, hands that text straight to the client, which toasts it
 * verbatim. So both gates reported OK on 2026-08-31 while production was
 * telling players:
 *
 *   check_username_with_suggestions   "Username must be 3-20 characters ..."  (en dash)
 *   claim_social_profile              "Your profile row is missing - refresh and try again."
 *   process_tournament_rebuy          "No live seat for this % - refusing to charge ..."
 *   fn_cancel_cashout                 "Cashout cancelled - chips returned"
 *   redeem_referral_code              "Referral reward - new player joined with your code"
 *   fn_notify_home_rsvp               a push notification title
 *
 * 120 functions in all. Migration 20260831202752 rewrote every one of them and
 * left behind fn_ca_banned_copy_characters(), which this script reads. Same
 * lesson as the Phase 3 insurance finding, in a different costume: a gate
 * pointed at the source proves nothing about what production serves.
 *
 * Usage:
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/ci/check-db-copy.mjs [--json]
 *
 * Exit: 0 clean - 1 banned characters are live in the database - 2 script error
 */
import { supabaseServerHeaders } from './supabase-auth-headers.mjs';

const AS_JSON = process.argv.includes('--json');
const URL_BASE = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!URL_BASE || !KEY) {
  console.error('check-db-copy: set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.');
  process.exit(2);
}

async function bannedCharacters() {
  const res = await fetch(`${URL_BASE}/rest/v1/rpc/fn_ca_banned_copy_characters`, {
    method: 'POST',
    headers: supabaseServerHeaders(KEY, { 'Content-Type': 'application/json' }),
    body: '{}',
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(
      `fn_ca_banned_copy_characters returned ${res.status}. If it is missing, apply ` +
        `20260831202752_the_em_dash_ban_reaches_the_database. ${body.slice(0, 300)}`
    );
  }
  return res.json();
}

async function main() {
  const rows = await bannedCharacters();

  if (AS_JSON) {
    console.log(JSON.stringify({ offenders: rows }, null, 1));
  }

  if (!Array.isArray(rows) || rows.length === 0) {
    if (!AS_JSON) console.log('check-db-copy: OK - no banned characters in database copy.');
    process.exit(0);
  }

  if (!AS_JSON) {
    console.error('');
    console.error('check-db-copy FAILED: banned dash characters are live in the database.');
    console.error('');
    console.error('Dan 2026-08-20: em dashes are forbidden in Club Arena copy, and a');
    console.error('Postgres function hands its message straight to the player.');
    console.error('');
    for (const r of rows.slice(0, 60)) {
      console.error(`  ${r.object_name}`);
      console.error(`      ${r.detail}`);
    }
    if (rows.length > 60) console.error(`  ... and ${rows.length - 60} more`);
    console.error('');
    console.error('Fix: rewrite the function, or re-run the translate in');
    console.error('20260831202752_the_em_dash_ban_reaches_the_database as a new migration.');
    console.error('');
  }
  process.exit(1);
}

main().catch((err) => {
  console.error('check-db-copy: ' + (err?.message || String(err)));
  process.exit(2);
});
