#!/usr/bin/env node
/**
 * THE BBJ MONEY PATH IN THE REPO MUST BE THE ONE PRODUCTION RUNS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * On 2026-08-27 `bbj_atomic_payout_v2` and `bbj_credit_one_recipient` — the two
 * functions that move the jackpot — existed ONLY in the production database.
 * `grep -rn bbj_atomic_payout_v2 --include=*.sql` returned a single comment.
 * The only payout DDL in supabase/migrations/ was the superseded v1, which
 * writes no recipients and credits nobody, so rebuilding this database from the
 * repository would have produced a jackpot that debits the pool and pays no
 * one — silently, because the functions were tracked only by NAME in
 * scripts/ci/supabase-schema-manifest.json.
 *
 * This prints the normalised fingerprint of each function as the REPO defines
 * it, applying migrations in filename order so the last definition wins, which
 * is what a rebuild would produce. Compare it against production with:
 *
 *   select proname,
 *          md5(regexp_replace(regexp_replace(pg_get_functiondef(oid),
 *              '--[^\n]*','','g'), '\s+','','g'))
 *     from pg_proc ...
 *
 * TWO NORMALISATIONS, both necessary and both narrow:
 *
 *   comments and whitespace are stripped, because they carry no behaviour;
 *
 *   `timestamptz` is canonicalised to `timestamp with time zone` IN THE
 *   SIGNATURE ONLY. pg_get_functiondef rewrites parameter and return types to
 *   their canonical spelling but prints a plpgsql BODY verbatim — so applying
 *   that substitution to the body makes a matching function look different,
 *   which is exactly the false negative this comment exists to stop someone
 *   re-introducing.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const DIR = 'supabase/migrations';
const WATCHED = new Set([
  'bbj_atomic_payout_v2',
  'bbj_credit_one_recipient',
  'fn_bbj_hand_detail',
  'fn_bbj_recent_hits',
  'sp_prune_hand_history',
]);

function normalise(def) {
  const at = def.indexOf('AS $function$');
  const signature = at < 0 ? def : def.slice(0, at);
  const body = at < 0 ? '' : def.slice(at);
  const canonical =
    signature.replace(/\btimestamptz\b/g, 'timestamp with time zone') + body;
  return canonical.replace(/--[^\n]*/g, '').replace(/\s+/g, '');
}

const found = new Map();
for (const file of readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort()) {
  const sql = readFileSync(join(DIR, file), 'utf8');
  const re = /CREATE OR REPLACE FUNCTION public\.(\w+)\([\s\S]*?\$function\$;/g;
  let m;
  while ((m = re.exec(sql))) {
    if (!WATCHED.has(m[1])) continue;
    const n = normalise(m[0].trim().replace(/;$/, ''));
    found.set(m[1], {
      md5: createHash('md5').update(n).digest('hex'),
      len: n.length,
      file,
    });
  }
}

let missing = 0;
for (const name of [...WATCHED].sort()) {
  const f = found.get(name);
  if (!f) {
    missing += 1;
    console.log(`${name.padEnd(26)} NOT IN ANY MIGRATION`);
  } else {
    console.log(`${name.padEnd(26)} ${f.md5}  ${String(f.len).padStart(5)}  ${f.file}`);
  }
}

if (missing > 0) {
  console.error(
    `\n${missing} BBJ money-path function(s) exist in production and in no migration. ` +
      `A rebuild from this repo would not create them.`
  );
  process.exit(1);
}
console.log('\nAll watched BBJ functions are defined in migrations.');
