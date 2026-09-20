#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A SUBSCRIPTION THAT CAN NEVER FIRE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * WHY THIS EXISTS (2026-09-06)
 *
 * `postgres_changes` is silent about the one thing that stops it working. A
 * client subscribes to a table, the channel joins, the status is SUBSCRIBED -
 * and if the table is not in the `supabase_realtime` publication no event is
 * ever decoded for it. No error, no warning, forever.
 *
 * On 2026-08-31 `table_hole_cards` was dropped from the publication and every
 * player at every table lost their hole-card push for four hours. A migration
 * was written the next day to restore it. Measured on 2026-09-06 that
 * migration was RECORDED AS APPLIED and neither of its effects existed: the
 * table was not published and its REPLICA IDENTITY was still DEFAULT. The
 * ledger said fixed; the database said no.
 *
 * The same sweep found 40 tables the client code subscribes to that the
 * publication does not carry, and 17 published tables no client names.
 *
 * WHAT THIS CHECKS
 *
 *   1. Every table named in a client `postgres_changes` subscription is in
 *      the publication - or is on the baseline below with a reason.
 *   2. Nothing NEW joins the "can never fire" set. A table added to a
 *      subscription without being published fails this check.
 *   3. Reports, without failing, the published tables THIS REPO does not
 *      subscribe to. Read that list carefully: the World Hub is a separate
 *      repo against the same database and subscribes to many of them, so a
 *      table here is NOT evidence that nobody wants it. It is a starting
 *      point for a question, never a delete list.
 *
 * WHAT A PUBLISHED TABLE COSTS, since that is the reason to care: every row
 * change is decoded by wal2json and passed through `apply_rls` once per
 * subscriber. Measured 2026-09-06, `table_hole_cards` alone was 716 of 1,643
 * published row changes in a fifteen-second window - 44% of everything
 * Realtime had to decode - and reached ZERO subscribers, because the engine
 * socket had already delivered the cards. Removing it (PR #3032, same day)
 * is the worked example of doing this right: the alternative delivery path
 * shipped FIRST, and the publication was trimmed after.
 *
 * IT NEVER PASSES SILENTLY WHEN IT CANNOT ASK (CLAUDE.md 10.86). No database
 * URL, an unreadable publication, an empty answer: exit 2, not 0.
 *
 * Usage:
 *   SUPABASE_DB_URL=postgres://... node scripts/ci/check-realtime-publication.mjs
 * Exit: 0 clean · 1 drift · 2 could not ask
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Tables a client subscribes to that are deliberately NOT published, each with
 * the reason. Anything here is a decision somebody made; anything NOT here and
 * not published is a subscription that can never fire, and fails.
 *
 * Seeded 2026-09-06 from the live comparison. Every entry is a real open
 * question - the subscription exists in code and receives nothing - and the
 * right resolution is usually to DELETE THE DEAD SUBSCRIPTION rather than to
 * publish the table, because each published table costs WAL decoding and an
 * RLS evaluation on every write of it.
 */
const KNOWN_UNPUBLISHED = new Map([
  ['table_id', 'not a table - a column name caught by the scanner'],

  // ── RE-SEEDED 2026-09-19, AFTER THE SWEEP NOBODY DID ────────────────────
  //
  // This baseline was seeded on 2026-09-06 from the live comparison - BEFORE
  // that day's WAL trim and before the 2026-09-08 SET TABLE replaced the rest
  // of the membership. So the subscriptions that died after it were never
  // recorded here, 34 of them, and this detector has been red ever since:
  // true, unreadable, and therefore unable to catch a NEW one.
  //
  // Twenty-three of the 34 were restored to the publication on 2026-09-19
  // (a_subscription_that_costs_nothing_may_fire_again, plus table_waitlist):
  // 35,618 writes between them, 0.06% of the eleven below, every one with RLS
  // on and a SELECT policy a subscriber can satisfy.
  //
  // These eleven stay out, and each carries the number that decides it -
  // writes since the stats reset, and the column count, because apply_rls runs
  // roughly one dynamic cast plus one column-privilege check per column per
  // change. Publishing any of them re-creates the 22.9-seconds-per-15-seconds
  // stream the trim was built to stop. The page subscribing to each one needs
  // a different delivery path, not a republished table.
  ['tournament_players',
   'NOT PUBLISHED BY MEASUREMENT: 25,280,935 writes, 27 columns - the most written table on the platform. TournamentClock should read standings rather than subscribe.'],
  ['table_seats',
   'NOT PUBLISHED BY MEASUREMENT: 14,582,928 writes, 26 columns. Seat state reaches the felt over the engine socket; TableOperationsPanel should refetch.'],
  ['tournaments',
   'NOT PUBLISHED BY MEASUREMENT: 5,477,895 writes over 117 columns, measured at 39.40ms per change on 2026-09-06. TournamentHUD should refetch.'],
  ['tables',
   'NOT PUBLISHED BY MEASUREMENT: 4,643,367 writes over 159 columns, 28.40ms per change on 2026-09-06 and 6,277ms of the 18,146ms apply_rls total. AdminTableHeatmap should refetch.'],
  ['agent_commissions',
   'NOT PUBLISHED BY MEASUREMENT: 1,802,610 writes, 10 columns, 6.7M live rows. AgentCommissionDashboard should refetch.'],
  ['agents',
   'NOT PUBLISHED BY MEASUREMENT: 1,066,935 writes, 31 columns, against 146 live rows - it is rewritten constantly. AgentPromoPanel should refetch.'],
  ['clubs',
   'NOT PUBLISHED BY MEASUREMENT: 1,047,848 writes over 94 columns, 35.96ms per change on 2026-09-06, against 5 live rows. DynamicWallet should refetch.'],
  ['game_management_events',
   'NOT PUBLISHED BY MEASUREMENT: 1,027,487 writes, 3.1M live rows. useGameManagementRealtime should poll or move to the engine socket.'],
  ['profiles',
   'NOT PUBLISHED BY MEASUREMENT: 1,000,061 writes over 120 columns, 45.29ms per change on 2026-09-06 - the worst per-change cost measured. PresenceIndicator wants presence, which is a channel feature, not a row change.'],
  ['union_wallets',
   'NOT PUBLISHED BY MEASUREMENT: 338,150 writes against 1 live row. DynamicWallet should refetch.'],
  ['chip_transactions',
   'NOT PUBLISHED BY MEASUREMENT: 258,956 writes, 822,598 live rows. AgentDashboardPage should refetch.'],

  [
    'table_hole_cards',
    'DELIBERATELY unpublished (PR #3032, 2026-09-06): the engine socket delivers the ' +
      'hero cards and the row is only the durable copy. It was 44% of all WAL decoding ' +
      'and reached zero subscribers. Do not re-add it without removing the socket path first.',
  ],
  ['commander_waitlist_group_members', 'Commander waitlist groups: subscription predates the tables being published'],
  ['commander_waitlist_groups', 'as above'],
  ['commission_rate_audit', 'audit trail; a push is not needed to read it'],
  ['financial_alerts', 'operator console subscribes; alerts arrive by other paths'],
  ['horse_daily_audit', 'daily job output; no live consumer'],
  ['horse_league_results', 'as above'],
  ['horse_self_tune_log', 'as above'],
  ['jarvis_training_sessions', 'unresolved'],
  ['merchandise_orders', 'unresolved'],
  ['pb_hands', 'unresolved'],
  ['poker_news', 'scraped content; refreshed on navigation'],
  ['poker_series', 'as above'],
  ['rake_rate_audit', 'audit trail'],
  ['rakeback_periods', 'period rollups; not live'],
  ['scraper_watchdog_state', 'infrastructure state'],
  ['settlement_periods', 'period rollups; not live'],
  ['social_interactions', 'unresolved'],
  ['social_page_comment_likes', 'unresolved'],
  ['social_page_followers', 'unresolved'],
  ['social_page_post_comments', 'unresolved'],
  ['social_page_post_likes', 'unresolved'],
  ['table_templates', 'operator config; changed rarely'],
  ['toke_calendar_events', 'Toke tracker; single-user data refreshed on navigation'],
  ['toke_downs', 'as above'],
  ['toke_expenses', 'as above'],
  ['toke_gig_days', 'as above'],
  ['toke_gigs', 'as above'],
  ['tournament_series', 'series metadata; changed rarely'],
  ['training_streaks', 'unresolved'],
  ['training_user_achievements', 'unresolved'],
  ['trivia_pvp_matches', 'unresolved'],
  ['union_admins', 'unresolved'],
  ['union_applications', 'unresolved'],
  ['union_clubs', 'unresolved'],
  ['user_daily_challenges', 'unresolved'],
  ['user_preferences', 'unresolved'],
  ['vip_subscriptions', 'unresolved'],
]);

/** Directories that hold client code with realtime subscriptions. */
const SCAN_DIRS = ['src'];

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue;
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|js|jsx)$/.test(name) && !/\.test\.|\.spec\./.test(name)) out.push(p);
  }
  return out;
}

/**
 * Table names this repo's client code subscribes to, mapped to EVERY file that
 * names them. Recording only the first file understated the work: `table_seats`
 * pointed at TableOperationsPanel while GlobalWaitlistListener's two handlers
 * went unnamed, so a reader fixing the one file named here would have believed
 * the table was done.
 */
function subscribedTables() {
  const found = new Map();
  for (const dir of SCAN_DIRS) {
    for (const file of walk(join(ROOT, dir))) {
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(/\btable:\s*'([a-z_][a-z0-9_]*)'/g)) {
        const rel = file.replace(ROOT + '/', '');
        const sites = found.get(m[1]);
        if (!sites) found.set(m[1], [rel]);
        else if (!sites.includes(rel)) sites.push(rel);
      }
    }
  }
  return found;
}

function publishedTables() {
  const url = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL || '';
  if (!url) {
    console.error('[realtime-publication] COULD NOT ASK: no SUPABASE_DB_URL / DATABASE_URL.');
    console.error('   This is not a pass. Set one, or run it where one is set.');
    process.exit(2);
  }
  const psql = process.env.PSQL_BIN || 'psql';
  let out;
  try {
    out = execFileSync(
      psql,
      [url, '-Atc', "select tablename from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' order by 1"],
      { encoding: 'utf8', timeout: 30_000 }
    );
  } catch (err) {
    console.error(`[realtime-publication] COULD NOT ASK: ${err.message}`);
    console.error('   This is not a pass.');
    process.exit(2);
  }
  const rows = out.split('\n').map((s) => s.trim()).filter(Boolean);
  if (rows.length === 0) {
    console.error('[realtime-publication] COULD NOT ASK: the publication came back empty.');
    console.error('   An empty publication is either a catastrophe or an unreadable answer;');
    console.error('   either way it is not a pass.');
    process.exit(2);
  }
  return new Set(rows);
}

const subscribed = subscribedTables();
const published = publishedTables();

const cannotFire = [];
/**
 * Subscribed, NOT published, and on the baseline. These are accepted - the
 * eleven were measured and excluded on purpose - but "accepted" is not
 * "working". Each one is a consumer in this repo whose channel joins, reports
 * SUBSCRIBED and receives nothing, for ever. The baseline records the decision;
 * it does not repair the page. Keeping them out of `cannotFire` is what lets
 * this detector go green on unrecorded drift, which is its actual job - but a
 * green run must still say out loud how many consumers are still dark, or the
 * next reader learns the same thing the hard way a third time.
 */
const knownDead = [];
/**
 * Baseline entries that are not tables at all - the scanner's regex matches a
 * `table:` key in an ordinary event payload. They are neither drift nor dead
 * consumers, so they must not inflate the dead count.
 */
const NOT_A_TABLE = new Set(['table_id']);
for (const [table, sites] of subscribed) {
  if (published.has(table)) continue;
  const where = sites.join(', ');
  if (KNOWN_UNPUBLISHED.has(table)) {
    if (!NOT_A_TABLE.has(table)) {
      knownDead.push({ table, where, sites, why: KNOWN_UNPUBLISHED.get(table) });
    }
    continue;
  }
  cannotFire.push({ table, where });
}

const unsubscribed = [...published].filter((t) => !subscribed.has(t)).sort();

console.log(
  `[realtime-publication] ${subscribed.size} table(s) subscribed in code, ${published.size} published, ` +
    `${KNOWN_UNPUBLISHED.size} known-unpublished on the baseline.`
);

if (unsubscribed.length > 0) {
  console.log(
    `[realtime-publication] ${unsubscribed.length} published table(s) THIS REPO does not subscribe to. ` +
      'The World Hub is a separate repo against the same database and subscribes to many of these, ' +
      'so this is NOT a delete list - it is where to start asking. Every published table costs a ' +
      'wal2json decode plus an apply_rls pass on every write of it, and that is the single largest ' +
      'consumer of database time on this project.'
  );
  if (process.env.REALTIME_LIST_UNSUBSCRIBED === '1') {
    for (const t of unsubscribed) console.log(`    ${t}`);
  } else {
    console.log('    (set REALTIME_LIST_UNSUBSCRIBED=1 to list them)');
  }
}

if (cannotFire.length > 0) {
  console.error('\n[realtime-publication] SUBSCRIPTIONS THAT CAN NEVER FIRE:\n');
  console.error('  These tables are subscribed to in code and are NOT in the supabase_realtime');
  console.error('  publication. The channel will join, report SUBSCRIBED, and receive nothing,');
  console.error('  forever, with no error - which is how the hole-card push stayed dead.\n');
  for (const { table, where } of cannotFire) console.error(`    ${table}   (${where})`);
  console.error('\n  Publish the table, delete the dead subscription, or add it to');
  console.error('  KNOWN_UNPUBLISHED in this file with the reason.');
  process.exit(1);
}

if (knownDead.length > 0) {
  console.log(
    `\n[realtime-publication] ${knownDead.length} SUBSCRIPTION(S) STILL CANNOT FIRE - accepted on the baseline:\n`
  );
  const deadSites = new Set();
  for (const { table, sites, why } of knownDead) {
    console.log(`    ${table}`);
    for (const site of sites) {
      deadSites.add(site);
      console.log(`        ${site}`);
    }
    console.log(`        ${why}`);
  }
  console.log(
    '\n  These are recorded decisions, not drift, so this run is not a failure.\n' +
      '  They are still dead consumers: the page subscribing to each one needs a\n' +
      '  different delivery path before its behavior is repaired.\n'
  );
  console.log(
    `[realtime-publication] OK - no unrecorded drift. ${knownDead.length} recorded table(s) ` +
      `across ${deadSites.size} file(s) still cannot fire.`
  );
} else {
  console.log('[realtime-publication] OK - every subscription this repo makes can actually fire.');
}
