/**
 * SHIPPED FUNCTIONALITY DOES NOT QUIETLY DISAPPEAR.
 * ============================================================================
 * Several agents push to this repo at once. Rebases rewrite SHAs, PRs land
 * from stale bases, and a merge resolved the wrong way silently reverts a
 * file. On 2026-08-21 I lost track of my own work three times and had to
 * re-land it, each time discovering the loss by running greps BY HAND.
 *
 * Worth being exact, because I told Dan the wrong thing first: there is no
 * evidence any of it was a destructive force-push. The GitHub events API shows
 * zero forced pushes to main, no merge commits touched the affected file, and
 * two of the three commits are still ancestors of main. At least one "loss"
 * was my own shell command breaking on a backtick so the push never carried
 * the commit. The real problem was never force-pushes - it was that NOTHING
 * WATCHED, so a regression and a bad diagnosis looked identical.
 *
 * This is that watch. Each entry is one behaviour that is live in production
 * and expensive to lose. The client suite already gates the World Hub bundle,
 * so a regression here cannot reach a user - it stops the publish.
 *
 * ADDING TO THIS LIST: only for behaviour that (a) shipped, (b) has already
 * regressed once or would be silent if it did, and (c) can be checked by the
 * presence or absence of something concrete. It is not a style guide, and a
 * sentinel that needs updating on every refactor is a bad sentinel - anchor on
 * the RPC name, the file, the rule, not the phrasing around it.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = (p: string) => resolve(__dirname, '..', p);
const read = (p: string) => readFileSync(root(p), 'utf8');
const has = (p: string, needle: string) => existsSync(root(p)) && read(p).includes(needle);

/** Behaviour that is live and must stay live. */
const MUST_CONTAIN: Array<[file: string, needle: string, why: string]> = [
  // Roles — the grant matrix lives in Postgres; the client must ASK it.
  ['src/types/clubRoles.ts', 'co_owner',
    'the seven club roles, including co_owner'],
  ['src/pages/ClubMembersPage.tsx', 'ca_club_grantable_roles',
    'the members page asks the server what it may offer'],
  ['src/pages/ClubMembersPage.tsx', 'fn_club_set_member_role',
    'one write path for a role change'],

  // Cashier — two screens that both got the downline wrong, opposite ways.
  ['src/pages/CashierPage.tsx', 'ca_club_my_downline',
    'a super agent sees their downline, not the whole club'],
  ['src/pages/CashierTradePage.tsx', 'ca_club_my_downline',
    'a super agent sees their whole downline, not only direct assignees'],

  // Union statements — the settlement lifecycle.
  ['src/pages/UnionStatementsPage.tsx', 'ca_union_set_statement_paid',
    'a statement can be marked settled'],
  ['src/pages/UnionStatementsPage.tsx', 'ca_union_record_presettlement',
    'a payment received mid-period can be recorded'],

  // Club Data — the per-player view and the prior-period comparison.
  ['src/pages/club/ClubDataPage.tsx', 'ca_club_player_breakdown',
    'the Players tab'],

  // Table — the action bar was black because four stylesheets own .action-btn.
  ['src/components/table/ActionPanel.css', '.action-panel .action-btn',
    'table action buttons are scoped so an unrelated stylesheet cannot repaint them'],
  ['src/components/table/tableGeometry.ts', 'betChipOffsetPx',
    'every seat’s chips sit the same distance from the player'],

  // Leaderboard — lost once already, on 2026-08-21: this method's body was
  // reverted by a merge while the migration creating the function sat in the
  // repo unapplied. Losing it does not break the page, which is why nothing
  // caught it — the client fallback aggregates from raw rows capped at 10,000,
  // and every club is past that cap with no ORDER BY before it, so the page
  // silently ranks an arbitrary half of a club's history. Measured on SHARK
  // CLUB while it was lost: true #1 shown at #5, true #2 at #28, true #3 at
  // #116 with $0, true #10 absent. Anchored on the CALL, so a rename trips it
  // deliberately and a passing mention in a comment cannot satisfy it.
  ['src/services/LeaderboardService.ts', "rpc('fn_club_tournament_stats',",
    'the club tournament leaderboard is aggregated in the database, not from a capped page of rows'],
];

/** Things that were removed on purpose and must not come back. */
const MUST_NOT_EXIST: Array<[file: string, why: string]> = [
  ['src/components/table/TipDealer.tsx', 'dealer tipping was removed entirely'],
  ['src/components/feedback/TipPrompt.tsx', 'the second tipping modal'],
  ['server/src/handlers/tipdealer.ts', 'the orphan tipdealer route'],
];

describe('shipped functionality is still here', () => {
  it.each(MUST_CONTAIN)('%s still has %s', (file, needle, why) => {
    expect(existsSync(root(file)), `${file} is gone — ${why}`).toBe(true);
    expect(has(file, needle), `${file} no longer references ${needle} — ${why}`).toBe(true);
  });

  it.each(MUST_NOT_EXIST)('%s stays deleted', (file, why) => {
    expect(existsSync(root(file)), `${file} came back — ${why}`).toBe(false);
  });

  it('the sentinel list is not empty or trivially passing', () => {
    // A guard that checks nothing passes forever. If someone empties the list
    // to make a build go green, this fails instead.
    expect(MUST_CONTAIN.length).toBeGreaterThanOrEqual(10);
    expect(MUST_NOT_EXIST.length).toBeGreaterThanOrEqual(3);
    // and every sentinel names a real file path
    for (const [file] of MUST_CONTAIN) {
      expect(file.startsWith('src/'), file).toBe(true);
    }
  });
});
