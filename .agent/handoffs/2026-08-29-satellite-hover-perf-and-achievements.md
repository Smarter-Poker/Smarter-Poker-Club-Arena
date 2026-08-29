# HANDOFF — satellite badge, hover removal, load performance, achievements integrity

**Session:** Cowork / Claude, 2026-08-28 → 2026-08-29
**Repo:** `Smarter-Poker-Club-Arena` (local canonical clone `~/Documents/club-arena`)
**Worktree used:** `~/Documents/.agent-trees/club-arena/cowork-sat2`
**Everything below is MERGED to `main`, SYNCED to World Hub, and SERVING in production unless a section says otherwise.**

---

## 0. STATE AT HANDOFF

| Thing                             | Value                                                          |
| --------------------------------- | -------------------------------------------------------------- |
| club-arena `main` HEAD at handoff | `8ec9b6eadc` (someone else's PR #1709 — mine are all below it) |
| World Hub `main` HEAD             | `805e95db56` → sync build `8ec9b6eadc`                         |
| Production `/api/health` version  | `805e95db`                                                     |
| My PRs                            | 8, all merged                                                  |
| Migrations applied to prod        | 3, all applied via Supabase MCP `apply_migration`              |
| Tests                             | 558 files / 8,555 passing at my last full run                  |
| `npx tsc --noEmit`                | exit 0                                                         |

**The page all of this revolves around:**
`https://smarter.poker/hub/club-arena/tournaments/dfae9288-40e2-485d-8c97-a13dd53ab483`
(20K GTD Sunday $200 Deep Stack, Shark Club.)

---

## 1. HOW TO WORK HERE (read this before touching anything)

### 1.1 The shell situation — this cost me hours, do not repeat it

- **The Cowork sandbox bash (`/sessions/.../mnt/...`) CANNOT run git write commands.** The mount cannot `unlink`, so any `git add`/`commit`/`status` strands a `.git/index.lock` that then blocks git on the Mac host too. Verified again this session: `touch .git/x && rm .git/x` → `Operation not permitted`.
- **The GitHub MCP (`mcp__github__*`) token is DEAD.** Every call returns `Authentication Failed: Bad credentials`. Do not plan around it. This contradicts `.agent/workflows/claude-mcp-push.md`, which still presents it as the primary push path.
- **What DOES work: `mcp__counselors__host_terminal`.** It runs real bash on the Mac. Two rules:
  1. **`PATH` is bare.** Always start with
     `export PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH`
     or `node`, `gh` and `npx` are all "command not found" — and husky hooks fail with `env: node: No such file or directory`.
  2. **It times out at roughly 10 seconds.** Anything longer must be backgrounded and polled:
     `( nohup sh -c '…' > /tmp/x.txt 2>&1 & ); sleep 8; cat /tmp/x.txt`
     then poll with a separate `sleep` in the sandbox bash (which allows up to ~120 s per call).
     `setsid` does not exist on this Mac. Plain `( nohup … & )` works.
- `gh` IS authenticated on the host (account `Smarter-Poker`, ssh protocol). `gh pr create --fill`, `gh pr view`, `gh run list`, `gh run view --log-failed` all work. **`gh pr checks` and `statusCheckRollup` do NOT** — the PAT lacks the scope and returns a wall of GraphQL "Resource not accessible" errors. Use `gh run list --branch <branch>` instead.

### 1.2 Shipping

```bash
cd ~/Documents/club-arena
eval "$(bash scripts/agent-workspace.sh <your-name> fix/<slug>)"
# work, then:
git add -A && git -c user.name=Smarter-Poker \
  -c user.email=254329056+Smarter-Poker@users.noreply.github.com \
  commit -m "…"
git push -u origin HEAD && gh pr create --fill
# STOP. Autopilot enables squash auto-merge within ~30s and merges on green.
```

- **Commit author MUST be `Smarter-Poker <254329056+Smarter-Poker@users.noreply.github.com>`.** Vercel refuses to build a commit it cannot attribute (goes to BLOCKED with no logs).
- The pre-commit hook runs `prettier --write` on every staged file. Expect large cosmetic diffs on files that were not previously formatted. **A file with a syntax error will fail the commit with `[FAILED] prettier --write` and lint-staged will REVERT your staged changes to a stash** — read `/tmp/<yourlog>` for `SyntaxError` lines.
- Typical time from merge to production: **8–20 minutes** (build-for-world-hub sync ~8 min, then Vercel). The sync workflow has `cancel-in-progress`, so **a newer merge CANCELS your sync run** and your change rides out on the next successful one. This happened to PR #1659 and cost ~2 hours of apparent delay. Nothing is lost; just wait for a later `completed success`.

### 1.3 Verifying a deploy — the honest way

```bash
# 1. is my squashed commit in the WH build?
cd ~/Documents/Smarter-Poker-World-Hub && git fetch -q origin main
CA=$(git log -1 --format=%s origin/main | grep -o "[0-9a-f]\{40\}")
cd ~/Documents/club-arena && git merge-base --is-ancestor <my-squashed-sha> $CA && echo SYNCED
# 2. is Vercel serving that WH commit?
curl -s https://smarter.poker/api/health   # .version == short WH sha
```

**Note:** PRs are SQUASH-merged, so your local branch SHA is never on `main`. Find the squashed one with `git log origin/main --grep="<subject fragment>" -1`.

---

## 2. WHAT SHIPPED (8 PRs, all merged)

| PR    | Squashed SHA | What                                                                    |
| ----- | ------------ | ----------------------------------------------------------------------- |
| #1607 | `d182a08c56` | New satellite chip artwork; badge 20px → 30px (the "50% larger" ask)    |
| #1659 | `283c0b937d` | Free-standing dish artwork; badge alt/title = "Satellite Winner"        |
| #1680 | `de2226eb59` | Versioned the art filename so a 30-day cache cannot serve the old icon  |
| #1689 | `8ba26965b0` | Removed hover MOTION estate-wide; entries list fills its panel          |
| #1693 | `4cd3e41955` | Zero hover on the lobby; "SATELLITE WINNER" text before the icon        |
| #1697 | `be5c12fdae` | Wallet stampede fix, service-worker media revalidation, sweep leftovers |
| #1700 | `2decddd06f` | Throttled the background auth token refresh                             |
| #1708 | `553e3f666d` | Achievements: 33,309 duplicate rows + farmable login streak             |

### 2.1 The satellite badge

- **Asset:** `public/images/satellite-winner-v3.png` — Dan's free-standing dish, trimmed to bounding box, squared, resampled to 120px Lanczos, 22,434 bytes, SHA-256 `33a9b9b6718ac909c94e293be846ef38e3484aa38dc97a01d0e5a11fca0d08f2`. **NOT circle-cropped** (the previous chip artwork was, and cropping this one slices the signal arcs and base off).
- `public/images/satellite-seat-icon.png` is **kept with identical bytes** so a browser on a stale JS chunk paints the new art rather than a broken-image box. It has **no importer left in `src/`** — safe to delete once no stale bundles are plausibly in flight.
- **Component:** `src/components/tournament/details/SatelliteSeatBadge.tsx` + `SatelliteSeatBadge.css` (new). Renders `<span class="sw-badge"><span class="sw-badge__text">Satellite Winner</span><img …></span>`. The `<img>` is `alt=""` + `aria-hidden` because the visible text carries the meaning — giving both the same string makes a screen reader say it twice.
- Used by exactly two surfaces: `EntriesTab.tsx` (inside `.et-marks`) and `RankingTab.tsx` (inside `.rk-nameline`).
- `white-space: nowrap` on `.sw-badge` is **load-bearing** — a break stacks "Satellite" over "Winner" and doubles one row's height in a list of 52px rows.
- At ≤420px the label stays and tightens (9px text, 26px icon) and **`.et-marks` max-width was raised 84px → 148px in `EntriesTab.css`**, which OWNS that selector. Do not set `.et-marks` from the badge stylesheet — two files at equal specificity makes the winner depend on CSS import order.
- **If you change the size,** change `width`/`height` in the TSX AND `.sw-badge__icon` in the CSS together. The attributes reserve the box pre-load (no reflow in a long list); the CSS paints.

### 2.2 Hover removal

Two passes:

1. **Estate-wide motion (PR #1689).** 500 hover `transform`s containing translate/scale/rotate/perspective removed, plus the 266 `box-shadow`s in those SAME blocks (a lift and its shadow are one effect). 266 files.
2. **Lobby, everything (PR #1693).** 34 remaining hover rules deleted from the 8 stylesheets that dress `.club-home`: `ClubHomePage.css`, `LobbyTable.css`, `GameLobbyPanel.css`, `AdvancedFilters.css`, `CasinoPlaque.css`, `LobbyAdStrip.css`, `TournamentLobbyCard.module.css`, `TournamentLobbyPage.module.css`.

Then (PR #1697) the leftovers:

- **179 empty `:hover {}` blocks** deleted across 121 files.
- **26 JS-driven hover handlers** across `HamburgerMenu.tsx` (20), `ErrorBoundary.tsx` (4), `SpectatorBadge.tsx` (2) — 40 `.style` mutations removed, 19 handlers deleted whole. **`handleItemHover(item.path)` was KEPT at all 7 call sites — it is a route PREFETCH, not a visual effect.**
- Dead `onMouseMove` in `CarouselSection.tsx` doing `getBoundingClientRect()` + 2 `setProperty` per pointer move per card, publishing `--x`/`--y` that nothing in `src/` reads.

**Rules embedded in the code, do not undo them:**

- The declaration is **DELETED**, never overwritten with `transform: none` — several elements carry a base `translate(-50%,-50%)` and `none` yanks them out of position on hover.
- Where a selector list paired `:hover` with `:focus-visible`, **only the `:hover` half was dropped.** Keyboard focus must stay visible.
- A scoped block at the bottom of `ClubHomePage.css` pins back the only two global hover rules a lobby element can still match (`.btn-primary:hover:not(:disabled)`, `::-webkit-scrollbar-thumb:hover`). **If you add a `.btn`, `.card`, `.tab` or bare `<a>` to the lobby, the hover comes back with it from `globals.css` / `design-system.css` / `club-engine.css` — add it to that block.**
- `tests/unit/lobbySweepFixes.test.ts` was rewritten in the same commit: it used to assert `.lt-row.is-mine:hover` EXISTS; it now asserts no lobby row has a hover state at all.

### 2.3 The entries panel dead space

`.et-scroll` was capped `max-height: min(58vh, 520px)` inside a panel the tab body stretches. Measured live: panel 860px, list 520px, content 1108px — **340px of dead space while the list scrolled**. `.et-panel` is now a flex column and `.et-scroll` is `flex: 1 1 auto; max-height: none; min-height: 160px`. `min-height: 0` on both is load-bearing (a flex item defaults to `min-height:auto`, refuses to shrink below content, and an overflow container that cannot shrink does not scroll — it pushes the footer off-screen). The old 420px cap was **deleted**, not left: it sits earlier in the file at equal specificity and could never have won.

### 2.4 The service worker (`public/sw-bus.js`)

**This was the reason Dan kept seeing the old icon after correct deploys.**

`MEDIA_CACHE = 'club-arena-media-v1'` is deliberately unversioned (nuking it per deploy re-downloads ~60 MB). Staleness was supposed to be handled by stale-while-revalidate — but the background half was plain `fetch(event.request)`, and these paths ship `Cache-Control: public, max-age=2592000`. A default fetch inside the freshness window **never reaches the server**, so the revalidation was a no-op for 30 days. The comment above it advertised this as a feature ("no network cost").

Proof: a `fetch(url, {cache:'reload'})` from inside the page returned the **original 19,441-byte** artwork while `curl` got the new bytes. `cache:'reload'` bypasses the HTTP cache but **not the service worker**.

Fixed with three things, all load-bearing:

1. `cache: 'no-cache'` on the background request → real conditional request (If-None-Match), unchanged media answers **304, no body**.
2. `MEDIA_REVALIDATE_AFTER_MS = 6h` floor — without it, every image on every page view (~120 on a table) issues a conditional request.
3. `event.waitUntil(revalidate)` — without it the browser may kill the worker after the response is handed over, the cache never updates, and it would LOOK fixed while behaving exactly as before.

**Still true and still the rule: version the FILENAME when replacing artwork people must see immediately.** A new URL is right on the first paint; this is only right on the next one.

### 2.5 Load performance

Measured on ONE clean load of the tournament page, before anything:

| Endpoint                     | Calls        | Slowest                |
| ---------------------------- | ------------ | ---------------------- |
| `wallet_transactions`        | 20           | 2,879 ms               |
| `tournament_players`         | 13           | 400 ms                 |
| `training_user_achievements` | 12           | 823 ms                 |
| `profiles`                   | 11           | 1,976 ms               |
| `club_members`               | 8            | 2,298 ms               |
| `/auth/v1/user`              | 7 (later 13) | 631 ms                 |
| `agents`                     | 6            | 2,607 ms               |
| **TOTAL**                    | **85**       | last call at **8.6 s** |

Ten idle seconds afterwards fired **zero** requests — it is all mount cost, not polling. Timings within each group ran `130, 129, 1680, 1773, 1872, 1988` ms: a fast pair then a ladder climbing ~100 ms/step, i.e. queueing behind saturation, not slow SQL.

**Three root causes, all fixed:**

1. **Wallet stampede.** `useWalletStore`'s `BALANCE_FRESH_MS` guard compares a stamp written only AFTER a request returns, so components mounting in the same tick all read the same stale stamp and all fetch. `DiamondService.getBalance` costs 1 `profiles` + 2 `wallet_transactions` per call. Fixed with `coalesce(key, run)` — a module-level `Map<string, Promise<void>>` — on `loadBalances`, `loadDiamonds`, `loadTransactions`. **`finally` clears the entry on both paths deliberately**: caching a rejected promise would leave the wallet broken for the whole session after one flaky request. Pinned by `tests/unit/walletStoreCoalescing.test.ts` (verified to fail 3/4 with coalescing disabled, reporting 6/5/4 calls where it wants 1).
2. **Auth refresh.** `getAuthUser()` in `src/lib/supabase.ts` fired a discarded fire-and-forget `supabase.auth.getUser()` on **every** call — 13 per page. Client already has `autoRefreshToken: true`. Now `nudgeTokenRefresh()`: max one per 60 s, concurrent nudges collapse.
3. **Achievements** — see §3, it was not an N+1.

**Result, measured on the deployed build, same page:**

|                              | Before            | After              |
| ---------------------------- | ----------------- | ------------------ |
| Total Supabase calls         | 85                | **41–54**          |
| `wallet_transactions`        | 20 (max 2,879 ms) | **3** (max 715 ms) |
| `/auth/v1/user`              | 13                | **0**              |
| `profiles`                   | 11 (max 1,976 ms) | **6** (max 723 ms) |
| `club_members`               | 8                 | **2**              |
| `agents`                     | 6                 | **0**              |
| `training_user_achievements` | 12                | **0**              |

---

## 3. THE BIG ONE — achievements (PR #1708)

### 3.1 The table was 99.87% duplicates

Before: **33,353 rows for 44 real (user, achievement) pairs. 33,309 surplus. Worst single pair 13,047 rows** (user `47965354-0e56-43ef-931c-ddaab82af765` — Dan's own account — achievement `streak_7`), still growing one row per page load.

**Mechanism:** no unique constraint on `(user_id, achievement_id)`, and the client wrote read-then-insert:

```ts
const { data: existing } = await supabase        // <-- error DISCARDED
  .from('training_user_achievements')
  .select(...).eq(user).eq(achievement).maybeSingle();
if (existing) update(...) else insert(...)
```

`.maybeSingle()` **errors** when >1 row matches. Only `data` was destructured, so the error was thrown away, `existing` came back undefined, code read that as "no row" and INSERTed. One duplicate begets the next.

Side effects: progress could never accumulate (so those achievements were effectively unearnable); `target` was never written so every row carried the default `1`; the `unlocked` boolean had **never been written by any code** and read `false` on all 33,353 rows while 8 were genuinely unlocked.

### 3.2 The login streak was farmable for real chips

`AchievementTriggerService.onLogin` looped 3 streak ids and called `incrementProgress` on each, **every time Supabase raised an auth event** — and it raises one on `INITIAL_SESSION`, `SIGNED_IN` and `TOKEN_REFRESHED`. So reloading advanced "Log in 7 days in a row". `streak_30` pays 100 chips and `streak_100` pays 500 via `add_to_promo_wallet` (real money path).

Production proof: **3 of 5 `streak_7` unlocks and 1 of 2 `streak_30` unlocks carried `unlocked_at` on the SAME DAY the row was created** — impossible for a consecutive-day achievement.

No day guard existed. `profiles.login_streak` read **0 on all 1,023 profiles**; `profiles.last_login_date` was stale on all of them. Nothing had ever maintained either column.

### 3.3 Migrations applied to production (all via Supabase MCP `apply_migration`)

| Version          | Name                                            |
| ---------------- | ----------------------------------------------- |
| `20260829020808` | `achievements_one_row_per_user_per_achievement` |
| `20260829020832` | `fn_achievement_record_progress`                |
| `20260829021334` | `table_waitlist_one_active_seat_per_player`     |

Repo copies live at `supabase/migrations/20260829020000_*.sql`, `…020100_*.sql`, `…020200_*.sql`. **The repo filename prefixes deliberately do not match the applied versions** — the MCP stamps its own timestamp. Do not "fix" this by renaming; check by NAME.

1. **Dedupe + unique index.** Merges each group (progress = MAX, `unlocked_at` = EARLIEST non-null, `created_at` = EARLIEST — nobody loses progress or an unlock), deletes the rest, **asserts zero duplicate groups remain before creating the index**, then `CREATE UNIQUE INDEX training_user_achievements_user_achievement_uidx`. Backfills `unlocked` from `unlocked_at`. **Result: 33,353 → 44 rows, 0 duplicate groups, 9 unlocked rows agreeing on both columns.**
   The index is also what makes the pre-existing `onConflict: 'user_id,achievement_id'` upsert legal — **that call had been failing for as long as it existed**, because ON CONFLICT needs a matching constraint.
2. **`fn_achievement_record_progress(p_user_id uuid, p_achievement_id text, p_progress numeric, p_target numeric) RETURNS boolean`.** SECURITY DEFINER, `search_path = public, pg_temp`, granted to `authenticated, service_role`. One statement: progress only RISES (`GREATEST`, clamped to target), `unlocked_at` set once and **never cleared**, `unlocked` kept in step, and it **returns true ONLY on the call that performed the transition** so the reward pays exactly once across tabs. Refuses to write another user's row (`auth.uid()` check; NULL = service role = allowed).
3. **`table_waitlist_one_active_per_player_uidx`** — PARTIAL unique index on `(table_id, user_id) WHERE status = 'waiting'`. Partial by design: that table keeps history (`cleared`/`seated`/`left`/`expired` are terminal and legitimately repeat); only being in one queue twice AT ONCE is wrong. Asserted zero violations before applying.

### 3.4 Client changes

- `AchievementService.incrementProgress` and `.setProgress` both route through a new private `_record()` → the RPC. The read error is now **handled**, not dropped.
- New `AchievementService.incrementProgressTo(userId, id, progress)` — absolute set that RETURNS whether this call unlocked it.
- `onLogin` rewritten: reads `profiles.login_streak, last_login_date`; **same UTC day → returns immediately, one SELECT, zero writes**; yesterday → streak+1; older/null → 1. **Claims the day (writes the profile) BEFORE the achievement writes**, so a failure there costs a missed advance, never a day counted twice. Then writes the 3 streak achievements **in parallel**.

### 3.5 Verified on the deployed build

Three consecutive reloads of the tournament page:

- `training_user_achievements` direct queries: **12 → 0**
- First load: `rpc/fn_achievement_record_progress` ×3 (day not yet counted — correct). **Second and third loads: 0.**
- Table rows: **47 → 47**, duplicate groups **0**
- `profiles.login_streak` = 1, `last_login_date` = `2026-08-29` (both were dead before)
- `streak_7` progress = 7 (preserved from the merge, not revoked)

---

## 4. NOT DONE — pick these up

### 4.1 HIGH — `gen-schema-manifest.mjs` writes its third manifest in a self-reverting format

`scripts/ci/gen-schema-manifest.mjs` writes three files. The comment inside it explains the Prettier-oscillation trap and fixes it with `JSON.stringify(…, 2)` for the schema and column manifests — **but `supabase-required-columns-manifest.json` (added later) is still written in a form Prettier reverts**. Regenerating churns **3,960 lines with zero content change**, and `scripts/ci/detect-silent-revert.mjs` flagged exactly this in PR #360.

I **deliberately reverted that file out of PR #1708** rather than bury a 3,960-line reformat in a money-adjacent PR. **It is still broken.** Fix = make that third write match the other two, in its own PR.

Also noted: regenerating picked up `profiles.player_tags` in the column manifest — somebody else's column, somebody else's PR to declare. Also reverted out.

### 4.2 HIGH — the `.maybeSingle()`-error-discarded pattern is estate-wide

**115 places** in `src/` destructure only `data` from a Supabase call followed by `.maybeSingle()`. That is the exact bug class that produced 33,309 duplicate rows.

I narrowed it to the dangerous subset — a discarded-error read followed by an **insert on the same table** — and found **8**:

| File                        | Table                        | Status                                      |
| --------------------------- | ---------------------------- | ------------------------------------------- |
| `WaitlistService.ts:163`    | `table_waitlist`             | **GUARDED** by the new partial index (§3.3) |
| `AchievementService.ts`     | `training_user_achievements` | **FIXED**                                   |
| `PromotionService.ts:187`   | `promotion_claims`           | already has a unique constraint — safe      |
| `PlayerNotesService.ts:140` | `player_notes`               | already has a unique constraint — safe      |
| `TournamentService.ts:2478` | `tables`                     | **CHECKED — safe.** See note below          |
| `TournamentService.ts:2725` | `tournament_waitlists`       | already has a unique constraint — safe      |
| `ReferralService.ts:58`     | `referral_codes`             | already has a unique constraint — safe      |
| `HorseOrchestrator.ts:1161` | `union_clubs`                | already has a unique constraint — safe      |
| `FriendListPanel.tsx:231`   | `friendships`                | already has a unique constraint — safe      |

**`TournamentService.ts:2478` (final-table creation) — checked at the end of the session, and it is safe from the explosion mechanism.** The read is
`.limit(1).maybeSingle()`, and `limit(1)` means the query can never return more
than one row, so `.maybeSingle()` cannot raise the "multiple rows" error that
drove the achievements loop. It can still create a SECOND final table if the
read fails transiently (network/RLS), because the error is discarded — but that
is a one-shot risk, not a per-page-load loop. Verified in production:
**0 tournaments have more than one open table matching `%Final Table%`.**
Worth hardening (handle the error, or a partial unique index on
`(tournament_id) WHERE name ILIKE '%Final Table%' AND status <> 'closed'`), but
it is not on fire.

Broader item: the other 107 discarded-error reads are mostly harmless (a read where "error → absent" only misrenders), but nobody has swept them.

### 4.3 MEDIUM — remaining load cost on the tournament page

After all fixes the page still makes **~41–54 Supabase calls**. Largest remaining:

- `tournament_players` ×13–14 — not investigated at all.
- `profiles` ×6–9 — coalescing helped but did not eliminate; likely several independent profile fetches per component.
- `user_table_settings` ×3–4, `tournaments` ×3.

Nobody has looked at whether `tournament_players` ×14 is one query per entrant or 14 components each asking once.

### 4.4 MEDIUM — dead / stale schema and code

- `profiles.streak_days` and `profiles.last_login` exist; `last_login` IS current, `streak_days` was not examined. `login_streak`/`last_login_date` are now live again (§3.4). Worth reconciling the four into one.
- `public.wallets` remains frozen with 732,591,994.33 chips stranded (pre-existing, documented in CLAUDE.md §11.5). Untouched.
- `src/components/carousel/Carousel.css` has one `will-change: transform` on an element nothing transforms any more — a permanent compositor layer for nothing. Left alone because that file's transform is carousel-driven and I did not want to guess.
- `public/images/satellite-seat-icon.png` is a deliberate duplicate of `satellite-winner-v3.png` (§2.1). Delete when comfortable.

### 4.5 LOW — the old satellite tooltip is gone

`title="Won Their Seat Via Satellite"` was replaced by the visible label. If anyone wants a tooltip back, note the popup Title-Case rule (CLAUDE.md §5.7) and that `check-ui-text` forbids em dashes.

### 4.6 NOT AUDITED AT ALL

- **The other tabs on the details page**: `BlindsTab`, `TablesTab`, `UnionsTab`, `RewardsTab`, `SatellitesTab`, `DetailOverviewTab`. I confirmed the details-page tree has **0 `.single()`, 0 TODO/FIXME, 0 discarded-error reads** — but I did not read them for logic, wiring or accessibility.
- **Mobile at 375px** — I verified the satellite badge geometry by injecting the real CSS into the live page and measuring (badge 127.5px inside a 148px allowance, rows stayed 52px). **I never actually rendered the page at 375px**; `resize_window` needs explicit `width`/`height`, not `preset`.
- **The `unlocked` boolean is now correct in the DB but nothing reads it.** If a future query filters on it, it is finally trustworthy.
- **`AchievementService.checkWins` / `checkSpecialHand` / `getUserAchievements`** now go through the RPC via `setProgress`, but I only exercised the login path in tests.

---

## 5. TRAPS THAT COST ME TIME (do not re-learn these)

1. **Never verify a cached asset with a cache-busting query string.** I checked deploys with `?cb=<timestamp>` — a URL no cache has ever seen — and reported the origin as what the user sees. Dan was staring at the old icon the whole time. Use `curl -I` on the bare URL, and check the service worker's Cache Storage.
2. **`cache: 'reload'` does not bypass a service worker.** It bypasses the HTTP cache only. If browser and curl disagree, suspect the SW.
3. **A CI check named "TypeScript Check" can fail for reasons unrelated to TypeScript.** Mine failed on "Supabase Invariants — New Migrations Were Applied" because `scripts/ci/supabase-schema-manifest.json` did not list the new function. Regenerate with `scripts/ci/gen-schema-manifest.mjs`; the service-role key is in `~/Documents/club-arena/.env` (`set -a; . .env; set +a; export SUPABASE_URL="$VITE_SUPABASE_URL"`).
4. **A CSS regex sweep must mask comments first.** My first hover pass matched a `:hover` inside a comment and cut `ClubBottomNav.module.css` in half; prettier caught it at commit and reverted everything to a stash. Blank out `/* … */` to same-length spaces before matching so indices still line up.
5. **`git checkout -- <file>` does not reset a STAGED file.** Use `git restore --source=HEAD --staged --worktree -- '*.css'`.
6. **A test that pins the behaviour you are removing must be updated in the SAME commit** (CLAUDE.md §5 rule 8). Two did this session: `lobbySweepFixes.test.ts` and `AchievementTriggerService.test.ts`. Both were rewritten to pin the NEW rule with the reason inline, not deleted.
7. **Verify a new test actually fails without the fix.** I disabled the coalescing map and confirmed `walletStoreCoalescing.test.ts` fails 3/4 (6, 5, 4 calls vs 1 expected), then restored. A test that passes either way pins nothing.

---

## 6. FILES TOUCHED (for a quick `git log -p` orientation)

```
src/components/tournament/details/SatelliteSeatBadge.tsx   (rewritten)
src/components/tournament/details/SatelliteSeatBadge.css   (new)
src/components/tournament/details/EntriesTab.css           (flex fill + .et-marks width)
src/components/navigation/HamburgerMenu.tsx                (JS hover removed, prefetch kept)
src/components/common/ErrorBoundary.tsx                    (JS hover removed)
src/components/table/SpectatorBadge.tsx                    (JS hover removed)
src/components/home/CarouselSection.tsx                    (dead cursor tracker removed)
src/pages/ClubHomePage.css                                 (lobby hover guard block)
src/lib/supabase.ts                                        (nudgeTokenRefresh)
src/stores/useWalletStore.ts                               (coalesce)
src/services/AchievementService.ts                         (_record + RPC)
src/services/AchievementTriggerService.ts                  (onLogin day guard)
public/sw-bus.js                                           (media revalidation)
public/images/satellite-winner-v3.png                      (new)
scripts/ci/supabase-schema-manifest.json                   (+1 line)
supabase/migrations/20260829020{000,100,200}_*.sql         (new, all applied)
tests/unit/walletStoreCoalescing.test.ts                   (new)
tests/unit/achievementsCannotBeFarmed.test.ts              (new)
tests/unit/lobbySweepFixes.test.ts                         (assertion replaced)
tests/unit/AchievementTriggerService.test.ts               (assertion replaced)
+ 266 stylesheets (hover motion), 121 (empty blocks), 8 (lobby)
```

Changelogs, one per PR, under `docs/changelog/2026-08-2{8,9}-*.md`. Read
`2026-08-29-achievements-33309-duplicate-rows-and-a-farmable-streak.md` first — it
has the full numbers and reasoning for §3.
