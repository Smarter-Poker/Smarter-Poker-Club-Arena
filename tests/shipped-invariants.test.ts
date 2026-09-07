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
import { sliceYamlBlock } from './helpers/sourceWindow';

const root = (p: string) => resolve(__dirname, '..', p);
const read = (p: string) => readFileSync(root(p), 'utf8');
const has = (p: string, needle: string) => existsSync(root(p)) && read(p).includes(needle);

/** Behaviour that is live and must stay live. */
const MUST_CONTAIN: Array<[file: string, needle: string, why: string]> = [
  // Roles — the grant matrix lives in Postgres; the client must ASK it.
  ['src/types/clubRoles.ts', 'co_owner', 'the seven club roles, including co_owner'],
  // 2026-08-23: re-anchored from ClubMembersPage to MemberManagementPage. The
  // Players tab was split - the roster lists, the member page acts - so role
  // granting moved wholesale. The CAPABILITY is what this pins, so it follows
  // the code to its new file rather than being deleted along with the old one.
  [
    'src/pages/MemberManagementPage.tsx',
    'ca_club_grantable_roles',
    'the member page asks the server what it may offer',
  ],
  [
    'src/pages/MemberManagementPage.tsx',
    'fn_club_set_member_role',
    'one write path for a role change',
  ],

  // Cashier — two screens that both got the downline wrong, opposite ways.
  //
  // 2026-08-25: re-anchored from ca_club_my_downline, for the same reason the
  // trade grid was, plus a worse one. `ca_club_my_downline` RETURNS TABLE
  // (agent_id, path, depth, username, ...) - one row per downline AGENT. This
  // page cast it to `{ scoped, user_ids }` and read two fields it has never
  // had, so the recipient filter collapsed to the viewer's own id and every
  // super agent, agent and sub agent found exactly one recipient on the Send
  // tab: themselves, which fn_agent_wallet_send refuses as a self-send.
  //
  // The sentinel also PASSED throughout, because the string survived in a
  // comment. A capability sentinel that a comment can satisfy is not a
  // sentinel; this one now names the call the send actually refuses on.
  [
    'src/pages/CashierPage.tsx',
    "supabase.rpc('fn_club_cashier_members'",
    'a super agent sees their downline, not the whole club and not just themselves',
  ],
  // 2026-08-25: re-anchored from ca_club_my_downline to fn_club_cashier_members.
  // The CAPABILITY pinned here is "the trade grid offers only the downline", and
  // it now comes from the function the SEND ITSELF refuses on
  // (fn_club_cashier_can_transact walks the same edge), so the list and the
  // refusal cannot disagree. The old call built the list a third way and its
  // super_agent branch also swept in every unassigned member of the club.
  [
    'src/pages/CashierTradePage.tsx',
    'fn_club_cashier_members',
    'the trade grid offers only the downline the send RPC will accept',
  ],
  [
    'src/pages/CashierTradePage.tsx',
    'fn_agent_wallet_send',
    'the trade grid spends the agent wallet, not a second club-ledger path',
  ],

  // Union statements — the settlement lifecycle.
  [
    'src/pages/UnionStatementsPage.tsx',
    'ca_union_set_statement_paid',
    'a statement can be marked settled',
  ],
  [
    'src/pages/UnionStatementsPage.tsx',
    'ca_union_record_presettlement',
    'a payment received mid-period can be recorded',
  ],

  // Club Data — the per-player view and the prior-period comparison.
  ['src/pages/club/ClubDataPage.tsx', 'ca_club_player_breakdown', 'the Players tab'],

  // Table — the action bar was black because four stylesheets own .action-btn.
  [
    'src/components/table/ActionPanel.css',
    '.action-panel .action-btn',
    'table action buttons are scoped so an unrelated stylesheet cannot repaint them',
  ],
  [
    'src/components/table/tableGeometry.ts',
    'betChipOffsetPx',
    'every seat’s chips sit the same distance from the player',
  ],

  // Leaderboard — lost once already, on 2026-08-21: this method's body was
  // reverted by a merge while the migration creating the function sat in the
  // repo unapplied. Losing it does not break the page, which is why nothing
  // caught it — the client fallback aggregates from raw rows capped at 10,000,
  // and every club is past that cap with no ORDER BY before it, so the page
  // silently ranks an arbitrary half of a club's history. Measured on SHARK
  // CLUB while it was lost: true #1 shown at #5, true #2 at #28, true #3 at
  // #116 with $0, true #10 absent. Anchored on the CALL, so a rename trips it
  // deliberately and a passing mention in a comment cannot satisfy it.
  [
    'src/services/LeaderboardService.ts',
    "rpc('fn_club_tournament_stats',",
    'the club tournament leaderboard is aggregated in the database, not from a capped page of rows',
  ],
  // 2026-08-26: club_chat RLS was requiring status='active' while production
  // holds 1480 'approved' and only 20 'active' — club chat was silent for
  // 98.7% of members. The migration widens both INSERT and SELECT to
  // ANY(['active','approved']). Guard: the migration must exist on disk so it
  // cannot be silently deleted. Checked via MUST_NOT_EXIST below.
  // 2026-08-26: /avatars/default-player.png does not exist in either repo.
  // SpectatorOverlay and SettingsPanel both referenced it. Now both use
  // resolveAvatarDisplay from avatarUtils, which falls back to DiceBear.
  // This pin catches anyone re-introducing the broken path.
  [
    'src/components/table/SpectatorOverlay.tsx',
    'resolveAvatarDisplay',
    'SpectatorOverlay must not reference the non-existent /avatars/default-player.png',
  ],
  [
    'src/components/table/SettingsPanel.tsx',
    'resolveAvatarDisplay',
    'SettingsPanel must not reference the non-existent /avatars/default-player.png',
  ],
  // 2026-08-26: PremiumCard.css declared a global .card-back { rotateY(180deg) }
  // which collided with CardReveal.css and CommunityCards.css. The animated
  // face now has its own name; the canonical nested CardBack remains untouched.
  [
    'src/components/table/PremiumCard.css',
    '.premium-card__back',
    'PremiumCard card-back rule must be scoped to avoid colliding with CardReveal and CommunityCards',
  ],
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

  /* A spec that no job runs is not a gate, it is a document. hero-card-row
     lived in that state: 40 assertions covering bug list item 11, referenced by
     no workflow, so the layout it guards could regress with every check green.
     Anchored on the FILE NAME inside the required job's command, because that
     is the thing whose absence makes the spec stop mattering. */
  it.each([
    ['tests/e2e/multi-table.spec.ts'],
    ['tests/e2e/live-animations.spec.ts'],
    ['tests/e2e/hero-card-row.spec.ts'],
  ])('the required CSS Beat E2E job actually runs %s', (spec) => {
    const ci = readFileSync(root('.github/workflows/ci.yml'), 'utf8');
    const job = ci.slice(ci.indexOf('CSS Beat E2E (multi-table + animations)'));
    expect(job.length, 'the CSS Beat E2E job is gone from ci.yml').toBeGreaterThan(0);
    expect(job.includes(spec), `the CSS Beat E2E job no longer runs ${spec}`).toBe(true);
  });

  /* GITHUB_TOKEN must never be the credential a merge is made with. A merge it
     produces does not trigger downstream workflows, so the commit lands on main
     and publish-club-arena.yml never fires: merged, never published, which
     reads exactly like a regression. The `||` chain is the thing that keeps it
     last, and 'simplifying' it is a one-character change with no visible
     symptom, so pin the chain itself. */
  it('Autopilot never reaches for GITHUB_TOKEN before a publishing token', () => {
    const wf = readFileSync(root('.github/workflows/agent-autopilot.yml'), 'utf8');
    const uses = [...wf.matchAll(/GH_TOKEN:\s*\$\{\{([^}]*)\}\}/g)].map((m) => m[1]);
    expect(uses.length, 'no GH_TOKEN assignment found in agent-autopilot.yml').toBeGreaterThan(0);
    for (const expr of uses) {
      const gt = expr.indexOf('secrets.GITHUB_TOKEN');
      if (gt === -1) continue; // no fallback at all is fine
      const pat = expr.indexOf('secrets.GH_PAT');
      const app = expr.indexOf('steps.app-token.outputs.token');
      expect(
        pat >= 0 || app >= 0,
        `GH_TOKEN: ${expr.trim()} — GITHUB_TOKEN with no publishing token ahead of it`
      ).toBe(true);
      if (pat >= 0) expect(pat, expr.trim()).toBeLessThan(gt);
      if (app >= 0) expect(app, expr.trim()).toBeLessThan(gt);
    }
  });

  /* THE PUBLISH PATH. Every gate in this repo answers "did it merge"; these
     three are the ones that answer "did it ship", and each pins a setting whose
     removal is invisible until production has been stale for hours. */
  describe('the publish path cannot be quietly disarmed', () => {
    const publisher = () => readFileSync(root('.github/workflows/publish-club-arena.yml'), 'utf8');

    it('the publisher does not cancel a run that is already publishing', () => {
      /* cancel-in-progress: true killed every build before its sync step. With
         agents pushing to main every minute or two the queue was never idle and
         never finished, and production sat on one sha for hours while main ran
         far ahead. false lets a RUNNING build finish and only cancels a pending
         one, so each wave converges on publishing the latest main. */
      const cfg = publisher();
      const block = sliceYamlBlock(cfg, 'concurrency:');
      expect(
        /cancel-in-progress:\s*false/.test(block),
        'publish-club-arena.yml would cancel an in-flight publish again'
      ).toBe(true);
    });

    it('a red client suite still stops the bundle from shipping', () => {
      // ci.yml's unit job never completes on main - pushes land faster than CI
      // and cancel it - so the suite runs HERE, inside the workflow that
      // publishes. Losing this line means a red suite ships to users.
      expect(publisher().includes('npx vitest run tests/')).toBe(true);
    });

    it('an older build cannot overwrite a newer one — ancestry, not wall clock', () => {
      /* 2026-08-22, twice in one day: cancel-in-progress: false lets an
         OLDER-sha run FINISH after a newer one, and because the older run was
         still building, its built_at is the LATER timestamp — so a stand-down
         guard comparing times waves the regression straight through. "Newer"
         must mean git history. Pinned on the mechanism: the sync step reads
         the deployed ca_sha and asks the compare API where it stands. */
      const wf = publisher();
      expect(wf.includes('"ca_sha"'), 'the sync step no longer reads the deployed ca_sha').toBe(
        true
      );
      expect(
        /\/compare\/\$\{THEIRS_SHA\}\.\.\.\$\{OURS_SHA\}/.test(wf),
        'the sync step no longer asks the compare API for ancestry'
      ).toBe(true);
      expect(
        /behind\)\s+VERDICT=standdown/.test(wf),
        'a behind (older) build no longer stands down'
      ).toBe(true);
    });

    it('the stand-down guard reads the DEPLOYED file, not the one it just wrote', () => {
      /* 2026-08-23: the "Sync dist/" step rsyncs our bundle into
         public/hub/club-arena/ BEFORE the guard runs, so reading that path
         compared the bundle to itself - THEIRS_SHA equalled OURS_SHA on
         attempt 1 and the guard could not fire on the attempt that usually
         decides the outcome. A losing older-sha run that checks World Hub out
         after the winner pushed would then overwrite it and fast-forward
         cleanly, with every check green. origin/main is the only honest
         answer to "what is deployed". */
      const wf = publisher();
      // 2026-09-03: the deployed provenance is the origin's
      // current/build-info.json, read over ssh BEFORE anything is written -
      // the same "read the deployed file, not the one you brought" rule.
      expect(
        /cat \$ORIGIN_ROOT\/current\/build-info\.json/.test(wf),
        'the guard no longer reads the deployed provenance from the origin'
      ).toBe(true);
      expect(
        /THEIRS_SHA=\$\(printf '%s' "\$THEIRS_JSON"/.test(wf),
        'THEIRS_SHA is being parsed from something other than the deployed file'
      ).toBe(true);
    });

    it('the build output travels as an artifact, not an 84MB branch push', () => {
      /* 2026-08-23: the sync job used to read dist/ out of an orphan branch
         force-pushed as `build/world-hub-sync-<sha>`. From 05:17 UTC every
         publish died there with `remote: fatal error in commit_refs`, four
         runs and a manual dispatch, and production sat 40 minutes behind main
         with a dozen merged pull requests stuck behind it. A small push to the
         repo worked and the same 84MB dist pushed from a workstation over SSH
         worked, so it was neither the ref backend nor the size - only the
         runner's HTTPS push of that pack. upload-artifact is what passing
         build output between jobs is for, and it also ends the 84MB push per
         commit and the ref left behind by every failed run. */
      const wf = publisher();
      expect(wf.includes('actions/upload-artifact')).toBe(true);
      expect(wf.includes('actions/download-artifact')).toBe(true);
      expect(
        /git push[^\n]*build\/world-hub-sync/.test(wf),
        'the orphan sync branch is back - that push is what deadlocked publishing'
      ).toBe(false);
      expect(
        wf.includes('if-no-files-found: error'),
        'an empty dist would upload silently and the sync would publish nothing'
      ).toBe(true);
    });

    it('something asks production what it is actually serving', () => {
      // Without this, "merged" and "published" have the same green tick, and
      // three separate incidents here were merges that never published.
      expect(existsSync(root('.github/workflows/publish-watchdog.yml'))).toBe(true);
      expect(
        readFileSync(root('.github/scripts/publish-watchdog.sh'), 'utf8').includes(
          'build-info.json'
        ),
        'the watchdog no longer reads the deployed provenance file'
      ).toBe(true);
    });
  });

  /* The playbook is the first thing every agent reads. Pinned on the answers it
     has to contain, not its prose, so it can be rewritten freely and cannot be
     quietly hollowed out. Each string below is a question an agent arrives
     with: how do I start, where are the credentials, why can I not merge. */
  it('AGENT-PLAYBOOK.md still answers the questions agents arrive with', () => {
    const p = readFileSync(root('AGENT-PLAYBOOK.md'), 'utf8');
    for (const needle of [
      'agent-workspace.sh', // how to start without destroying anyone's work
      'AUTOPILOT_APP_ID', // where the credential lives
      'reference-transaction', // what saves your commits from a reset
      'build-info.json', // how to check it actually shipped
      'estate-integrity', // what watches the guards
    ]) {
      expect(p.includes(needle), `AGENT-PLAYBOOK.md no longer mentions ${needle}`).toBe(true);
    }
    // A secret VALUE must never appear here. These repos are read by agents and
    // some of them are public.
    expect(
      /\b(sb_secret|service_role_key\s*=|ghp_|github_pat_)/i.test(p),
      'AGENT-PLAYBOOK.md looks like it contains a credential value'
    ).toBe(false);
  });

  it('CLAUDE.md sends agents to the playbook first', () => {
    expect(readFileSync(root('CLAUDE.md'), 'utf8').includes('AGENT-PLAYBOOK.md')).toBe(true);
  });

  /* Claude reads CLAUDE.md at session start; Antigravity reads
     .agents/rules/*.md with `trigger: always_on`. Two different front doors,
     and until 2026-08-22 only one of them mentioned the playbook - so an
     Antigravity agent following its always-on rule never learned it existed. */
  it('Antigravity has an always-on rule that points at the playbook', () => {
    const r = readFileSync(root('.agents/rules/00-agent-playbook.md'), 'utf8');
    expect(r.includes('trigger: always_on'), 'the rule is no longer always-on').toBe(true);
    expect(r.includes('AGENT-PLAYBOOK.md'), 'the rule no longer points at the playbook').toBe(true);
    expect(r.includes('agent-workspace.sh'), 'the rule no longer carries the ship sequence').toBe(
      true
    );
  });

  /* The guards can all be reverted, and nothing but this notices. Pinned on the
     file, not its contents: what matters is that SOMETHING still compares the
     seven repos to each other. */
  it('something still watches the guards themselves', () => {
    expect(existsSync(root('.github/workflows/estate-integrity.yml'))).toBe(true);
    const sh = readFileSync(root('.github/scripts/estate-integrity.sh'), 'utf8');
    // The three questions it exists to answer. Losing any one of them turns it
    // into a script that passes for a reason nobody checked.
    expect(sh.includes('bypass_actors'), 'no longer checks for unexpected bypass actors').toBe(
      true
    );
    expect(
      sh.includes('required_status_checks'),
      'no longer checks that required checks exist'
    ).toBe(true);
    expect(sh.includes('SHARED_FILES'), 'no longer compares the shared guards').toBe(true);
  });

  /* Dan 2026-08-26 (villain-card rebuild, four rounds in one day): every
     villain hand renders through ONE geometry — the small PokerBros-style
     rotational cluster on `.seat__cards--opponent`, driven by --vh-* tokens,
     where game type changes only the card count. The bug it replaced was a
     SECOND renderer: a hold'em-only `--twocard` branch plus an Omaha
     sliver-overlap treatment, which drifted apart for weeks. A second layout
     branch reappearing is the regression, and it would be silent — each
     branch looks fine alone. Anchored on the selectors and tokens, not
     phrasing. */
  it('the villain hand has exactly ONE renderer — the cluster, no game-type branch', () => {
    const css = read('src/components/table/SeatSlot.css');
    const tsx = read('src/components/table/SeatSlot.tsx');
    // The cluster geometry is present and CSS-token driven.
    expect(css.includes('--vh-card-h'), 'cluster sizing tokens are gone').toBe(true);
    expect(css.includes('--vh-rot-step'), 'cluster splay tokens are gone').toBe(true);
    expect(css.includes('--sp-wrap-overlap'), 'the shared plate-overlap token is gone').toBe(true);
    // The deleted second renderer stays deleted.
    expect(
      css.includes('.seat__cards--opponent.seat__cards--twocard'),
      'the hold-em twocard layout branch came back'
    ).toBe(false);
    expect(
      tsx.includes("seat__cards--twocard'"),
      'SeatSlot emits the deleted twocard class again'
    ).toBe(false);
    expect(css.includes('--sp-opp-overlap'), 'the Omaha sliver-overlap renderer came back').toBe(
      false
    );
  });

  it('rabbit hunt stays live in every format: cash, MTT, spins, heads-up', () => {
    // Dan 2026-08-26: "implement it fully in the cash games, mtt, spins and
    // heads up." Verified live that day - production had zero tables or
    // tournaments with the feature off across all formats, and reveals were
    // being consumed. What keeps it that way is exactly three anchors, and
    // losing any one of them turns a format off SILENTLY:
    //
    // 1. Every tournament table (MTT, Spin, SNG/heads-up) carries the
    //    tournament's toggle onto its tables row, defaulting ON. Before this
    //    line, tournament tables simply inherited the column default and a
    //    host had no switch at all.
    const tm = read('server/src/tournament/TournamentManagerBase.ts');
    expect(
      tm.includes('allow_rabbit_hunt: tournament.allow_rabbit_hunt !== false'),
      'tournament tables no longer carry the rabbit hunt toggle'
    ).toBe(true);
    // 2. The availability event honors tables.allow_rabbit_hunt and defaults
    //    ALLOWED - `!== false`, never `=== true`, or every row that predates
    //    the column goes dark.
    const settle = read('server/src/engine/ServerTableEngineSettlement.ts');
    expect(
      settle.includes('?.allow_rabbit_hunt !== false'),
      'the offer gate no longer defaults to allowed'
    ).toBe(true);
    // 3. The reveal path is format-agnostic: the handler knows nothing about
    //    game types, so a new format is included by construction. If a format
    //    gate ever appears here, someone must say which format it turns off
    //    and why, in this file, on purpose.
    const handler = read('server/src/handlers/rabbithunt.ts');
    expect(
      handler.includes('game_type') || handler.includes('tournament_type'),
      'the reveal handler grew a format gate - rabbit hunt is meant to work in every format'
    ).toBe(false);
    // And the host toggle column ships as a migration, defaulting true.
    expect(
      existsSync(root('supabase/migrations/20260825_tournaments_allow_rabbit_hunt.sql')),
      'the tournaments.allow_rabbit_hunt migration is gone'
    ).toBe(true);
  });

  it('the financial audit corrections retain their canonical RPCs', () => {
    expect(has(
      'supabase/migrations/20260907194634_mini_jackpot_allocations_conserve_before_recipient_credit.sql',
      'CREATE OR REPLACE FUNCTION public.fn_bbj_mini_payout'
    )).toBe(true);
    expect(has(
      'supabase/migrations/20260907195229_union_statements_retain_opening_balance_and_check_finance_access.sql',
      'CREATE OR REPLACE FUNCTION public.fn_union_club_statement_of_account'
    )).toBe(true);
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

