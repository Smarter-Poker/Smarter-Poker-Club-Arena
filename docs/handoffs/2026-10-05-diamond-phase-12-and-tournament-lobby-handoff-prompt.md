# HANDOFF PROMPT: Diamond Arena Phase 12 tail, and the in-game Tournament Lobby (2026-10-05)

Paste this whole file as the first message of a new chat. Everything below is addressed to you, the receiving agent.

Verified 2026-10-05 18:16 UTC unless a line says otherwise.

---

## Part 0. Who you are and what you are picking up

You are an agent working for Dan, the owner-operator of Smarter.Poker. Two repositories matter:

- **Club Arena** (`Smarter-Poker/Smarter-Poker-Club-Arena`): a Vite + React 19 + TypeScript SPA plus the Hetzner poker engine. It is published by `publish-club-arena.yml` to `https://ca-static.smarter.poker` and served at `https://smarter.poker/hub/club-arena/`.
- **World Hub** (`Smarter-Poker/Smarter-Poker-World-Hub`): Next.js on Vercel, project `hub-vanguard`, served at `https://smarter.poker`.
- **Supabase project:** `kuklfnapbkmacvwxktbh`. The database is shared by both apps.

The prior session ran 2026-10-04 to 2026-10-05 and shipped two programmes.

1. **In-game Tournament Lobby redesign.** It is done and live:
   - The lobby is a full-screen, industry-standard popup that works on mobile, and every tab and stat is wired.
   - Satellite Rewards are built, and Previous Hands is full screen.
   - A 14-defect review pass and a later deep audit found nothing outstanding.
2. **Diamond Arena build programme, Phase 12 (Release, Retirement And Live Proof).** The retirement half is done and live:
   - Three migrations are applied.
   - Legacy World Hub copy and legal pages are corrected.
   - The trial-balance "unknown hours" defect is root-caused and fixed.

   The release half is deliberately NOT done. The arena switches stay closed, and the reasons are in Part 1.

What went wrong, bluntly:

- The prior agent twice handed push, publish and decision steps back to Dan. He rejected this with force; see Part 1.
- One migration apply attempt hit the :50-:03 UTC break window and was refused by the database. It applied nothing; see Part 8.

---

## Part 1. STOP CONDITIONS. Read before any work.

### Dan's binding words, verbatim

> "NO, NOTHING IS ME, THIS IS ALL YOU TO DO. HUMAN DOESN'T PUSH OR PUBLISH SMH."

> "YOU CAN DECIDE WHO AND WHAT IS DONE, AND YOU HAVE FULL ACCESS TO THE DASHBOARD! USE CLI OR CURL"

> "AND THESE ARE YOURS TO MAKE, NOT MINE"

What this means for you:

- You push, merge, publish, apply migrations and verify live yourself.
- You make the routine decisions. Never end a report with "what I need from you" when a tool path exists.
- When a path is truly blocked, prove it with the exact error, then give Dan the one click that finishes it.

### The arena switches are CLOSED, and you do not open them

- **The switches:** `public.ca_arena_settings.cash_games_enabled` and `tournaments_enabled`. Both are `false`.
- **The decision:** the prior agent decided on 2026-10-05 to keep them closed. It is recorded in `docs/POKER-ARENA-DIAMOND-BUILD-PROGRAMME.md` (Phase 12, "Decisions, October 5, 2026") and in `docs/changelog/2026-10-05-diamond-phase-12-decisions.md`.
- **The three conditions that open them:**
  1. **Privacy hole closed** (Phase 10 line 2). Today any signed-in account can read every account's Diamond balance, legal name, birth year and city through the API. This is live now, switches or not.
  2. **Rake, fee, bad-beat jackpot and guarantee funding have approved rates and destinations.** These are Phase 9 questions A1 to A20 and B1 to B22 in `docs/DIAMOND-DESTINATIONS-DESIGN-2026-09-21.md`. Until then they are "refused by name" in code.
  3. **The certified buy-in, play, leave and transfer run** (Phase 12 line 5) passes on the published build. It needs a signed-in session.
- **The rule:** do not flip either switch, and do not write a migration that flips one, until all three hold and are evidenced.

### What you must NOT do

- Never apply DDL in minutes :50 to :03 UTC. A database event trigger refuses it. Check `date -u` first, apply once, and never retry in a loop.
- Never probe a money function without a rolled-back transaction. Over the Supabase MCP, a rollback is one call containing one `DO` block that ends in `RAISE EXCEPTION`; an error is the success case. See Club Arena `CLAUDE.md` 11.5.
- Never use Dan's personal account for a probe.
- Never print secrets or read `.env` values.
- Never commit in the main clones `/home/claude/smarter-poker-club-arena` or `/home/claude/smarter-poker-world-hub`. Use linked worktrees; a hook refuses the main clone.
- Never `--no-verify`.
- Never add a cron, watcher, sweep, backfill or repair job as a fix (Club Arena `CLAUDE.md` 10.11 and 10.12).
- Never filter horses out of anything (`CLAUDE.md` 10.5).
- Never re-push a branch whose PR already merged. Cut a fresh branch from `origin/main`.
- Player copy rules: no em dashes (U+2014), no emoji, Title Case, no `:hover` selectors.

---

## Part 2. Environment bootstrap. Run these first.

```bash
date -u                                   # break-window check before any DDL
cd /home/claude/smarter-poker-club-arena && git fetch -q origin && git log --oneline -1 origin/main
cd /home/claude/smarter-poker-world-hub  && git fetch -q origin && git log --oneline -1 origin/main
gh auth status
```

Worktree pattern (Club Arena):

```bash
cd /home/claude/smarter-poker-club-arena && git fetch -q origin
git worktree add /home/claude/ca-wt/<slug> -b claude/<slug> origin/main
cd /home/claude/ca-wt/<slug>
ln -s /home/claude/smarter-poker-club-arena/node_modules node_modules
git config user.name Smarter-Poker
git config user.email 254329056+Smarter-Poker@users.noreply.github.com
# Every commit and push: prefix PATH, otherwise lint-staged picks a broken global eslint 10
PATH="$PWD/node_modules/.bin:$PATH" git commit ...
PATH="$PWD/node_modules/.bin:$PATH" git push -u origin claude/<slug>
```

World Hub is the same pattern under `/home/claude/wh-wt/<slug>`. It has no node_modules in the clone.

- To run its tests, deps exist at `/tmp/claude-0/whdeps/node_modules`. If you symlink them, put the link outside the repo and remove it after.
- Some of its tests need `node --test --experimental-vm-modules`.
- Never run `npm run build`, `npm install` or `rm -rf .next` in World Hub.
- The commit author must be `Smarter-Poker`, or Vercel blocks the deploy.

### Tool quirks

| Thing                                            | Reality                                                           | What to do instead                                                                                                                                |
| ------------------------------------------------ | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gh pr create`                                   | Fails (GraphQL blocked)                                           | `gh api repos/<owner>/<repo>/pulls -X POST -f title=... -f head=<branch> -f base=main -F body=@file`                                              |
| `gh` workflow dispatch                           | HTTP 403 "Resource not accessible by integration"                 | Apply migrations with the Supabase MCP `apply_migration`, pasting the file body exactly (md5 asserts catch typos)                                 |
| curl to smarter.poker, ca-static, api.vercel.com | Proxy CONNECT 403                                                 | Built-in browser pane: `mcp__remote-devices__Claude_Browser__navigate` to `https://smarter.poker/api/health`, then `javascript_tool` with `fetch` |
| GitHub repo settings (archive)                   | "Repository settings writes are not permitted through this proxy" | Not possible from this session; see Part 5                                                                                                        |
| Vercel DNS                                       | No list or delete record tool; only whole-zone replace            | Do not replace the zone                                                                                                                           |
| Long sleeps                                      | The tool caps at 10 minutes                                       | Keep each `sleep` loop at or below about 540 s                                                                                                    |

Club Arena auto-opens a PR for a pushed branch (sometimes it does not; then create one) and auto squash-merges on green required checks:

- TypeScript Check
- Client Unit Tests (vitest)
- Server Engine
- Production Build
- CSS Beat E2E
- Money trigger declaration authority

World Hub's autopilot bot also merges on green. If it does not, merge with `gh api .../pulls/<n>/merge -X PUT -f merge_method=squash`.

PR bodies end with:

```
🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01PbFTFDKpXuirMGabk4KHpx
```

Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and the `Claude-Session:` line above.

---

## Part 3. How the pieces work

**Tournament Lobby call path**

- `src/pages/TablePage.tsx` mounts `TournamentLobbyModal` with `isOpen`, `tournamentId`, `currentTableId={tableId}` and `onClose`. It stays mounted after first open, on purpose (Dan's "open instantly" ruling).
- `src/components/table/TournamentLobbyModal.tsx` draws a full-screen popup with `data-popup-chassis="none"`. It handles the focus trap, Escape (ignored when the key was already handled by a stacked dialog) and touch stopPropagation.
- It renders `src/pages/tournament/TournamentDetails.tsx`, which provides the header, status pill, scrolling tab strip, footer actions, "Back To Table" and `watchTable`. `watchTable` closes the popup, and closes without navigating when the target is the current table.
- The tabs live in `src/components/tournament/details/`:
  - DetailOverviewTab
  - RankingTab (realtime channel keyed per mount via `useId`)
  - EntriesTab
  - TablesTab
  - RewardsTab (satellite seats from recorded prizes)
  - shared helpers in `types.ts`: `finishedFieldSummary`, `shortTableName`, and the `onWatchPlayer(tableId, tableName?)` signature
- Previous Hands: `src/components/table/HandDetailModal.tsx/.css` is a full-height panel.

**Diamond accounting path**

- pg_cron job 201 (`ca-diamond-snapshot-hourly`, minute 10) calls `public.fn_ca_diamond_snapshot()`, which writes `public.ca_diamond_snapshots`.
- At :20, `fn_ca_diamond_trial_balance_watch` calls `fn_ca_diamond_trial_balance(now() - 1 hour)`.
- With no snapshot in the window, the trial balance now measures from the newest earlier snapshot. Only "no snapshot at all" reads unknown.
- A healthy run: about 5 s per snapshot, zero failures. Before the fix, p95 was 26 s, and one run was cancelled at 120 s on 2026-10-01.

**Page preferences path**

- World Hub services in `src/services/{bankroll,memoryGames,news,pokerNearMe}Preferences.js` read the stored jsonb column, merge the patch over it, then call RPC `public.update_page_preferences(p_user_id, p_column_name, p_preferences)`. The RPC replaces the column.
- The getters merge the stored value over defaults (#2128).

---

## Part 4. State inventory (verified 2026-10-05 18:16 UTC)

### Live revisions (read through the browser pane)

| Surface                      | Live SHA                     | Contains all work below                 |
| ---------------------------- | ---------------------------- | --------------------------------------- |
| Club Arena `build-info.json` | `7acd3ec2` (built 18:04:34Z) | yes (main HEAD `5083089f` and earlier)  |
| World Hub `/api/health`      | `8a25bdf9`                   | yes (`5929705b`, #2131, is an ancestor) |

### Club Arena PRs (all merged)

| PR    | Squash on main | What                                                                |
| ----- | -------------- | ------------------------------------------------------------------- |
| #6072 | `639b792b`     | Full-screen standard tournament lobby; frames removed; mobile fixed |
| #6090 | `391f08ac`     | Satellite Rewards tab shows seats                                   |
| #6091 | `91afa41f`     | Previous Hands full screen                                          |
| #6102 | `fad86293`     | Migration: legacy Diamond Arena DB objects dropped                  |
| #6109 | `7c087d88`     | Phase 12 evidence docs                                              |
| #6117 | `a7521fd1`     | Migration: snapshot reads the register once per holder              |
| #6118 | `78e32cab`     | Migration: page preferences count rows; dead freeze scope retired   |
| #6120 | `cdbff23f`     | Lobby review pass, 14 defects                                       |
| #6149 | `1a95cbe9`     | Docs: migrations live                                               |
| #6158 | `40e8dd9d`     | Docs: diamond subdomain has no record                               |
| #6171 | `f7efd046`     | Docs: Phase 12 decisions                                            |

### World Hub PRs (all merged)

| PR    | Squash     | What                                                          |
| ----- | ---------- | ------------------------------------------------------------- |
| #2112 | `6a76ac23` | Diamond Arena retirement leftovers removed                    |
| #2115 | `4bafd6a6` | Knowledge-base entries ds-1, wh-14 and wh-20, plus copy       |
| #2117 | `202f005f` | Preference services merge before save; leaderboard menu links |
| #2128 | `65328bbf` | Preference getters merge stored values over defaults          |
| #2131 | `5929705b` | Terms and Official Rules no longer describe the retired arena |

### Migrations applied to production (history versions as recorded)

- `20261004214251 the_legacy_diamond_arena_database_objects_are_dropped`
- `20261005004041 the_diamond_snapshot_reads_the_register_once_per_holder` (repo file `20261004231413_...`)
- `20261004231057 page_preferences_count_the_row_they_wrote_and_the_dead_arena`

Every `@live-proof` predicate read true on 2026-10-05.

A rolled-back probe proved the preferences fix:

- a save for the service identity returned `{"probe": 1}`;
- another user's id answered `Unauthorized: User ID mismatch`;
- the dropped column answered `Invalid preference column: diamond_arena_preferences`.

### Before and after

| Metric                                 | Before                                       | After                                                                   | Source                               |
| -------------------------------------- | -------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------ |
| Snapshot job 201 duration              | p50 7.8 s, p95 26.2 s, max 40.3 s (347 runs) | about 5.3 s average; 16 runs, 0 failed (00:41 to about 16:40 UTC Oct 5) | `cron.job_run_details`               |
| Fixture subquery buffer reads          | 855,590                                      | about 85,000 for the whole statement                                    | EXPLAIN ANALYZE on production, Oct 4 |
| `update_page_preferences` success rate | 0% (every call raised "Profile not found")   | works                                                                   | rolled-back probe, Oct 5             |

---

## Part 5. The task that blocks everything else: archive the old repo

**Done:**

- `diamond.smarter.poker` needs nothing. It has no record of its own: a random name such as `zzq-random-8705.smarter.poker` resolves to the same Vercel addresses and serves the same "404: NOT_FOUND".

**Not done:**

- Archive `Smarter-Poker/Smarter-Poker-Diamond-Arena`. It is currently `archived: false`, public, last pushed 2026-09-20.

Every route the prior agent tried, and its exact result:

| Route                                                                                                                  | Result                                                                 |
| ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `gh api repos/Smarter-Poker/Smarter-Poker-Diamond-Arena -X PATCH -F archived=true` (after `add_repo` with push access) | 403 "Repository settings writes are not permitted through this proxy." |
| GitHub GraphQL `archiveRepository`                                                                                     | 403 "GitHub GraphQL is not available from Claude Code sessions"        |
| Built-in browser pane at `/settings`                                                                                   | "Page not found" (not signed in)                                       |
| Dan's Chrome via `Control_Chrome`                                                                                      | Settings page showed "Page not found"; then "Chrome is not running"    |
| Claude in Chrome extension                                                                                             | "Browser extension is not connected"                                   |

Next actions:

1. Retry, in order: the `gh` PATCH, then Claude in Chrome (`tabs_context_mcp`), then `Control_Chrome`. If Chrome is signed in to a GitHub account that administers the repo:
   - open `https://github.com/Smarter-Poker/Smarter-Poker-Diamond-Arena/settings`;
   - find "Archive this repository" in the Danger Zone;
   - type the confirmation exactly as GitHub asks;
   - confirm with `gh api repos/Smarter-Poker/Smarter-Poker-Diamond-Arena --jq .archived`, which must print `true`.
2. If every route still refuses, tell Dan in one sentence that it is one click in GitHub Settings, then Danger Zone, then Archive. Do not write it as a "what I need from you" list.
3. **Once `.archived` is true**, remove the repo from these CI estate lists in one PR per repo:
   - World Hub `scripts/ci/check-main-is-green.mjs:114`
   - World Hub `scripts/ci/check-prs-can-actually-merge.mjs:90`
   - Club Arena `.github/scripts/estate-integrity.sh:40`

   Read the comment at Club Arena lines 266-267 first: two allow-list entries there explain deleted workflows in that repo. Decide whether they go too, and update any test that pins those lists in the same commit. Push, merge, and verify both repos' main is green.

---

## Part 6. Backlog, prioritised

### HIGH

**Close the profile privacy hole (Phase 10 line 2).**

- Evidence: `docs/DIAMOND-PHASE-10-LINES-1-2-6-2026-09-29.md`, question 1. Any signed-in account can read every account's Diamond balance, legal name, birth year and city through the API.
- Decision already made: the operator delegated decisions, and the obvious answer is that those four fields are private.
- Work:
  - Find every reader in both repos (grep `profiles` selects of `diamonds`, legal name, birth year, city).
  - Move the readers to a self-only RPC or a column-level grant.
  - Prove it with a rolled-back probe that one account cannot read another's fields, and that each owner still can.
- Done means: the migration is applied, both apps are live, and the probe evidence is recorded.
- Watch out: profile columns are read by many World Hub pages. A REVOKE without moving the readers breaks pages, so move the readers first.

### MEDIUM

**Phase 12 line 5, the certified buy-in, play, leave and transfer run.**

- It needs a signed-in session for the platform service identity (`daniel@smarter.poker`, role god). Never use Dan's personal account.
- It also needs the switches open, so it comes last. Blocked until the HIGH item is done and the economics are decided.

**Phase 9 economics, questions A1 to A20 and B1 to B22.**

- Dan said decisions are the agent's. These are prices and rates, so make them only with a written rationale in the destinations design doc, and keep rake, fees and BBJ refused until each answer is implemented and proved.
- This is large. Plan it as its own task.

### LOW

- **Stale comment** in `src/pages/TablePage.tsx` near line 28080: it says the lobby is "Mounted only while open". It now stays mounted after first open. Fix the comment only.
- **Hand History list drawer:** the search input font is about 11.6 px at 375 px wide, which triggers iOS focus-zoom. Fix: font-size 16 px on that input. The drawer keeps its 75dvh sheet by design.
- **Previous Hand arrows:** the nav glyphs U+25C0 and U+25B6 may render as emoji on some iOS versions. Verify on a device or replace them with SVG chevrons.
- **Two snapshot hours with no row and no cron failure row** (2026-10-01 23:10, 2026-10-04 00:10). pg_cron recorded no run. Investigate only if it recurs after the fix.

### Done differently than specified

- The Previous Hands _list drawer_ stays a 75dvh sheet. Only the hand detail popup is full screen, as Dan confirmed ("Yes, make it full screen" was about the popup).
- The Official Rules version label was bumped to V2.1 when the retired freeroll entry method was removed. No entry method was invented in its place, because other free methods remain.

### DECLINED, do not build

- Opening the arena switches before the three conditions in Part 1 hold. If a future agent "finishes Phase 12" by flipping them, that is a mistake.
- Replacing the whole smarter.poker DNS zone to remove `diamond`. There is no record to remove, and a whole-zone replace can take the site down.

### BLOCKED on a human

- Repository archive, only if every route in Part 5 still refuses.

---

## Part 7. Defects found, and their lessons

1. **Mobile lobby had "zero functionality".**
   - Cause: the content panel was a 52 px strip inside a console chassis, and touch did not reach it.
   - Fix: full-screen panel, chassis removed, touch propagation stopped.
   - Lesson: "appears on desktop, dead on mobile" is geometry until proven otherwise.
2. **Finished events contradicted themselves** ("In The Money" counted unpaid entrants; tables listed after the event ended).
   - Fix: `finishedFieldSummary` and paid-only counts.
   - Lesson: derive finished-state stats from recorded prizes, not live counters.
3. **The 14 review-pass defects** (#6120), for example:
   - Escape on the Sign Up card closed the whole lobby.
   - A watch inside the lobby did nothing for the current table.
   - A cancelled event showed a ticking "Starts In".
   - The overview invented "Rebuy thru Lv 8" from a default of 8 and read the columns in reverse.
   - Rewards could print "450% Of The Field Paid".

   Lesson: every default in display code is a claim to the player. Print nothing when the data is absent.

4. **Trial balance "unknown" for three hours.**
   - Cause: the snapshot called SECURITY DEFINER `fn_ca_is_fixture_account` per ledger row: 209,249 calls to keep 23 rows. It hit `statement_timeout` (120 s) on 2026-10-01 17:10, or never started (pg_cron "job startup timeout"; a database restart on 10-03).
   - Fix: net per holder, then ask once per holder; measure from the previous snapshot when one is missed.
   - Lesson: a SECURITY DEFINER function with SET is never inlined. Calling one per row is a hidden loop.
5. **`update_page_preferences` never saved anything.**
   - Cause: `IF NOT FOUND` after `EXECUTE ... INTO`. EXECUTE does not set FOUND.
   - Fix: `GET DIAGNOSTICS v_rows = ROW_COUNT`.
   - Lesson: grep for `FOUND` after any dynamic `EXECUTE`.
6. **Preference getters dropped defaults** for a stored `{}`. Bankroll Auto-Save and Notifications showed off; Poker Near Me geofence alerts read off.
   - Fix: merge stored values over defaults (#2128).
   - Lesson: fixing a write path changes what readers see. Audit the readers in the same task.

The shape they share: a confident answer produced where the code had no data (a default, a NULL read as clean, FOUND read as success). Look for that shape first.

---

## Part 8. Traps and instruments that lie

- **Supabase MCP `apply_migration` returning `{"status":"cancelled"}`.** Nothing was applied. Check with `execute_sql` against the live-proof predicates before retrying, and retry once.
- **The break window.** Applying at 10:52 UTC was refused: "migration refused: 10:53:01 UTC is inside the hourly maintenance break window". The prior agent checked the time at :52 and still applied. Check `date -u` in the same breath as applying.
- **Migrations are often applied by someone else** (the `apply-merged-migration.yml` workflow) while you wait. Read `SELECT version, name FROM supabase_migrations.schema_migrations WHERE version >= '20261004'` before applying, or you will try to apply twice. The md5 preimage asserts make a second apply abort safely.
- **Recorded versions can differ from the file version.** The snapshot migration is recorded as `20261005004041` because the MCP stamps apply time. Liveness is judged by name and `@live-proof` lines (`scripts/ci/check-migrations-are-live.mjs`).
- **A PR "closed" with `merged_at` set is merged.** The remote branch is then deleted, so a stop-hook may report "no remote branch". Verify with `git cat-file -e origin/main:<path>`, then detach and delete the local branch. Do not re-push.
- **`publish-club-arena.yml` runs show "cancelled"** when a newer merge supersedes them. That is not a failure. Prove publication by comparing the live `ca_sha` from `build-info.json` with your commit using `git merge-base --is-ancestor <your-sha> <live-sha>`.
- **A Vercel deployment showing "success" is not live proof.** Read `/api/health` `commitSha` through the browser pane.
- **"Page not found" on a GitHub settings URL** means not signed in or not an admin. The repo exists.

---

## Part 9. Verification commands

Did the work land (files, not ticks)?

```bash
cd /home/claude/smarter-poker-club-arena && git fetch -q origin
for c in 639b792b 391f08ac 91afa41f cdbff23f a7521fd1 78e32cab f7efd046; do git merge-base --is-ancestor $c origin/main && echo "$c ok"; done
```

Healthy: seven `ok` lines.

Live revisions (built-in browser pane, `javascript_tool` on a smarter.poker tab):

```js
const h = await fetch('/api/health', { cache: 'no-store' }).then((r) => r.json());
const b = await fetch('/hub/club-arena/build-info.json?x=' + Date.now(), {
  cache: 'no-store',
}).then((r) => r.json());
({ wh: h.commitSha, ca: b.ca_sha, built: b.built_at });
```

Healthy: each SHA has the work above as an ancestor.

Database live proofs (`execute_sql`, read-only):

```sql
SELECT
 to_regprocedure('public.fn_arena_deposit(integer,text)') IS NULL AS doors_gone,
 to_regclass('public.diamond_arena_events') IS NULL AS table_gone,
 md5(pg_get_functiondef('public.update_page_preferences(uuid,text,jsonb)'::regprocedure))='875d8538e2edb229d6ebe898eebb1281' AS prefs_ok,
 md5(pg_get_functiondef('public.fn_ca_diamond_snapshot()'::regprocedure))='2419d7a9c757d9a0135b8fec75edd2c8' AS snap_ok,
 (SELECT count(*) FROM cron.job_run_details WHERE jobid=201 AND start_time > now()-interval '24 hours' AND status<>'succeeded') AS snapshot_failures_24h,
 (SELECT bool_or(cash_games_enabled OR tournaments_enabled) FROM public.ca_arena_settings) AS any_switch_open;
```

Healthy: the first four are true, `snapshot_failures_24h` is 0, and `any_switch_open` is false.

If a snapshot failure appears, read `return_message` in `cron.job_run_details` for job 201 before anything else.

Club Arena build gate for a code change:

```bash
npx tsc --noEmit
npx vitest run <changed tests> <tests referencing changed files>
```

On 2026-10-05 the gate passed:

- `tsc` clean;
- 68 of 69 relevant files and 1830 tests passed;
- one 5 s timeout while `tsc` ran concurrently, which passes alone.

---

## Part 10. File map

| Path                                                                                      | What                                             | Status               |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------ | -------------------- |
| `src/components/table/TournamentLobbyModal.tsx/.css`                                      | Full-screen lobby popup                          | live                 |
| `src/pages/tournament/TournamentDetails.tsx/.css`                                         | Lobby body, tabs, footer                         | live                 |
| `src/components/tournament/details/*`                                                     | Tabs and shared helpers                          | live                 |
| `src/components/table/HandDetailModal.tsx/.css`                                           | Previous Hand popup                              | live                 |
| `src/pages/TablePage.tsx`                                                                 | Mounts the lobby (stale comment near line 28080) | live                 |
| `docs/POKER-ARENA-DIAMOND-BUILD-PROGRAMME.md`                                             | Programme; Phase 12 status and decisions         | current              |
| `docs/evidence/diamond-phase-12/*`                                                        | Accounting time series, legacy sweep             | current              |
| `docs/DIAMOND-DESTINATIONS-DESIGN-2026-09-21.md`                                          | Phase 9 questions A1 to A20, B1 to B22           | open                 |
| `docs/DIAMOND-PHASE-10-LINES-1-2-6-2026-09-29.md`                                         | Privacy hole audit                               | open                 |
| `supabase/migrations/20261004214251_...`, `20261004231413_...`, `20261004231057_...`      | The three applied migrations                     | applied              |
| `.github/scripts/estate-integrity.sh`                                                     | Lists the old repo (lines 40, 266-267)           | change after archive |
| World Hub `src/services/*Preferences.js`                                                  | Preference services                              | live                 |
| World Hub `pages/terms.js`, `pages/legal/official-rules.js`                               | Legal pages, updated Oct 5                       | live                 |
| World Hub `scripts/ci/check-main-is-green.mjs:114`, `check-prs-can-actually-merge.mjs:90` | List the old repo                                | change after archive |

---

## Part 11. How to behave on this work

- Carry each change through push, PR, merge, publish and live verification yourself. Report those as separate states.
- Fix at the root and pin it with a test. A net or a monitor is not a fix.
- Read the live database before believing a doc; docs in this repo have been wrong and corrected.
- Write your own changelog file, `docs/changelog/YYYY-MM-DD-<slug>.md`. Never append to `MIGRATION-CHANGELOG.md`.
- Migrations:
  - reserve the version with `node scripts/new-migration.mjs "<what>"`;
  - one BEGIN/COMMIT;
  - md5 preimage and postimage asserts;
  - `-- @live-proof:` lines;
  - prove it on a local Postgres first;
  - apply once, outside :50 to :03 UTC.
- Do not send frequent progress updates. Work in long stretches and report once, at the end, plainly, including what you could not do and the exact error.
- Use parallel subagents for independent work. Give each the full rules from this document.

---

## Part 12. Opening moves, in order

1. Run Part 2 bootstrap and the Part 9 verification block. Confirm everything still reads healthy.
2. Retry the repo archive (Part 5, step 1). If it succeeds, do Part 5 step 3 in both repos and verify both mains are green.
3. If the archive is still refused, report it in one sentence and move on.
4. Start the HIGH item, the profile privacy hole:
   - inventory the readers in both repos;
   - design the self-only read path;
   - write and locally prove the migration;
   - ship the reader changes first, then the migration;
   - verify live with a rolled-back probe.
5. Do the LOW items as one small Club Arena PR (comment, input font size, arrow glyphs).
6. Leave Phase 9 economics and Phase 12 line 5 as their own planned tasks.

While blocked on anything, you can safely work on items 4 and 5.

Do not open the arena switches.
