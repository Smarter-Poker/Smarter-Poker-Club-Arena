#!/usr/bin/env node
/**
 * CI GATE - a club must stay deletable.
 *
 * On 2026-09-03 at 23:33 UTC the club-create certification created two fixture
 * clubs, funded each with 100,000 chips from the Mint, and then could not remove
 * them:
 *
 *   Fixture Cleanup Failed For 89e03439...: canceling statement due to statement timeout
 *   Fixture Cleanup Failed For 7abc31e6...: canceling statement due to statement timeout
 *   Error: Certification leaked 2 fixture club(s) into Club Arena
 *
 * public.clubs has seventy foreign keys pointing at it. Deleting a club makes
 * PostgreSQL check every one of them, and a check with no usable index is a
 * sequential scan of the child table. Seven had none: rake_records cost 1.29
 * seconds of a request budget under nine, and game_management_events had no
 * index on club_id at all across 867,780 rows.
 *
 * Two of those seven LOOKED indexed. idx_rake_records_club_created leads on
 * club_id but carries `WHERE rake_amount > 0`; idx_table_seats_club_active leads
 * on club_id but carries `WHERE left_at IS NULL`. A partial index cannot answer a
 * foreign key check, because the check must find exactly the rows the predicate
 * hides. Any audit that asks "is there an index on this column" gives the wrong
 * answer here. The question this gate asks is the right one:
 *
 *   is there a VALID, NON-PARTIAL index whose LEADING column is the
 *   referencing column?
 *
 * Migration 20260904001605 closed all thirteen gaps and 20260904001715 gave the
 * database fn_ca_fk_index_gaps() so the question can be asked from outside.
 *
 * Protected-main publication runs this strict live-catalogue check before
 * either engine or client publication can mutate its production target. PR
 * code never receives these credentials. The post-deploy fixture gate asks
 * again because the database may change between publication and cleanup.
 *
 * Usage:
 *   node scripts/ci/check-club-fk-indexes.mjs           # strict (exit 1 on a gap)
 *   node scripts/ci/check-club-fk-indexes.mjs --warn    # report, exit 0
 *
 * Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
 */

import process from 'node:process';
import { supabaseServerHeaders } from './supabase-auth-headers.mjs';

const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const WARN_ONLY = process.argv.includes('--warn');

/**
 * The parents a stranded row actually costs chips on. clubs is the only estate
 * this platform deletes - a certification fixture, and one day a closed club -
 * and it is the one that has already failed. Add a parent here only when
 * something really deletes it; an unindexed foreign key into a table nobody
 * deletes is a performance note, not a chip risk, and a gate that reports notes
 * gets ignored.
 */
const PARENTS = ['public.clubs'];

if (!URL || !KEY) {
  console.error('ERROR: set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.');
  process.exit(2);
}

async function gapsFor(parent) {
  const res = await fetch(`${URL}/rest/v1/rpc/fn_ca_fk_index_gaps`, {
    method: 'POST',
    headers: supabaseServerHeaders(KEY, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ p_parent: parent }),
  });
  if (!res.ok) {
    const body = await res.text();
    console.error(`ERROR: fn_ca_fk_index_gaps('${parent}') failed (${res.status}): ${body}`);
    console.error('');
    console.error('That RPC arrives with migration');
    console.error(
      '  supabase/migrations/20260904001715_the_repo_can_ask_production_whether_a_club_is_still_deletable.sql'
    );
    console.error('If this branch predates it, rebase on main. If it is applied and this');
    console.error('still fails, the grant is wrong: it is service_role only, on purpose.');
    process.exit(2);
  }
  const answer = await res.json();
  const keys =
    answer && typeof answer === 'object' && !Array.isArray(answer)
      ? Object.keys(answer).sort()
      : [];
  const validShape =
    keys.join(',') === 'checked_at,gaps,parent' &&
    answer.parent === parent &&
    typeof answer.checked_at === 'string' &&
    !Number.isNaN(Date.parse(answer.checked_at)) &&
    Array.isArray(answer.gaps) &&
    answer.gaps.every(
      (gap) =>
        gap !== null &&
        typeof gap === 'object' &&
        !Array.isArray(gap) &&
        typeof gap.child_table === 'string' &&
        typeof gap.child_column === 'string' &&
        typeof gap.constraint === 'string' &&
        (gap.est_rows === null ||
          (typeof gap.est_rows === 'number' && Number.isFinite(gap.est_rows)))
    );

  if (!validShape) {
    console.error(
      `ERROR: fn_ca_fk_index_gaps('${parent}') returned an invalid response; refusing to treat an unreadable catalogue answer as healthy.`
    );
    process.exit(2);
  }

  return answer;
}

let failed = false;

for (const parent of PARENTS) {
  const answer = await gapsFor(parent);
  const gaps = answer.gaps;

  if (gaps.length === 0) {
    console.log(
      `OK - every single-column foreign key into ${parent} has an index that can answer it.`
    );
    continue;
  }

  failed = true;
  console.log('');
  console.log(
    `A CLUB CANNOT BE DELETED: ${gaps.length} foreign key(s) into ${parent} would force a sequential scan.`
  );
  console.log('');
  for (const g of gaps) {
    const rows =
      typeof g.est_rows === 'number' && g.est_rows >= 0
        ? `${g.est_rows.toLocaleString()} rows`
        : 'size unknown';
    console.log(`  ${g.child_table}.${g.child_column}   (${g.constraint}, ${rows})`);
  }
  console.log('');
  console.log('Each of these makes DELETE FROM clubs slower, and the retirement RPC');
  console.log('runs inside a PostgREST request that is cancelled after a few seconds.');
  console.log('When it is cancelled, a certification fixture and its 100,000 chips stay');
  console.log('in Club Arena. That has already happened once.');
  console.log('');
  console.log('Fix: add the index in a migration, then regenerate the manifests.');
  console.log('');
  for (const g of gaps) {
    const bare = String(g.child_table).replace(/^public\./, '');
    console.log(`  CREATE INDEX IF NOT EXISTS idx_${bare}_${g.child_column}_fk`);
    console.log(`    ON ${g.child_table} (${g.child_column});`);
  }
  console.log('');
  console.log('Build it CONCURRENTLY against production first if the child table is large');
  console.log('- a plain build takes a SHARE lock, and 867,780 rows took 25 seconds -');
  console.log('then let the IF NOT EXISTS statement above be the no-op that records it.');
  console.log('');
  console.log('An index that already leads on the column but is PARTIAL does not count');
  console.log('and cannot be made to count: a foreign key check must find the rows the');
  console.log('predicate hides. Add a plain one beside it.');
}

if (failed && !WARN_ONLY) process.exit(1);
if (failed) console.log('[--warn] exiting 0 despite the gaps above.');
process.exit(0);
