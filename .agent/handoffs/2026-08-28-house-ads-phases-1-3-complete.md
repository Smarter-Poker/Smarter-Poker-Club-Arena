# HANDOFF — smarter.poker House Ads, Phases 1–3 complete

**Written:** 2026-08-28, ~17:15 UTC / 12:15 CDT
**Author:** Cowork agent (session `cowork-ads2`)
**Status:** ALL WORK MERGED AND PUBLISHED. Nothing is in flight. Nothing is broken.
**Read time:** 10 minutes. Read it all before touching anything.

---

## 0. READ THESE FIRST, IN THIS ORDER

You are inheriting a repo with hard rules that exist because work was lost.

1. `~/Documents/club-arena/AGENT-PLAYBOOK.md` — byte-identical in all seven repos.
   How to ship without losing work, every guard, and **where every credential
   lives**.
2. `~/Documents/club-arena/.agents/rules/00-agent-playbook.md` — RULES 1–8 and
   the mandatory VERIFICATION PASS (Parts A–E). **RULE 1: finishing is
   merging.** **RULE 5: never ask the human to run a command.** **RULE 7: fix
   your own build.**
3. `~/Documents/club-arena/CLAUDE.md` — repo law. Sections you will actually
   need: **4** (fix-first), **5** (code safety + popup Title Case, no em
   dashes), **10** (Dan's working rules), **10.5** (HORSES ARE PLAYERS — hard
   law), **11** (Open Claw is the only sanctioned scheduler), **11.5** (never
   spend real chips to test a rule), **12** (never rebase main).
4. `~/Documents/Smarter-Poker-World-Hub/CLAUDE.md` — the 8 Immutable Rules and
   the deploy pipeline.

**Dan's standing instructions, verbatim, that shaped this work:**

- _"even vips will see ads remove that for now"_ — VIPs see ads. No
  suppression, and do not re-advertise "Ad-Free" either.
- _"if you add a cap or a hold, make it rotate, and make a suppressed ad
  countable."_
- Never call AI players "bots" — **they are horses**.
- No emoji in source. Popups/toasts are Title Case with **no em dashes**.
- Mobile-first: 375px first, then scale up.
- _"Never ask permission for obvious work. Just do it."_
- When corrected, change course immediately. Do not defend the rejected path.

---

## 1. CREDENTIALS — WHERE THEY LIVE, NOT WHAT THEY ARE

**I am deliberately not pasting secret values into this file, and you should
not either.** This document is committed to a repo, and `.memory/` and
`docs/` are public and tracked on main. The estate's own playbook states the
convention: _"where every credential lives (never the value — the place)."_
Every credential below is already on the machine you are running on, so you
have full access without any value being written down.

| What                      | Where it lives                                                                     | How to load it                                                    |
| ------------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Supabase service role key | `~/Documents/club-arena/.env` and `~/Documents/Smarter-Poker-World-Hub/.env.local` | `set -a; . ~/Documents/club-arena/.env; set +a`                   |
| Supabase URL              | same, or hardcode                                                                  | `https://kuklfnapbkmacvwxktbh.supabase.co` (public, not a secret) |
| GitHub auth               | `gh` CLI on the host, already authenticated                                        | `export PATH=/opt/homebrew/bin:$PATH` then `gh ...`               |
| Supabase DDL/SQL          | **Supabase MCP** — `apply_migration` / `execute_sql`                               | Project id `kuklfnapbkmacvwxktbh`                                 |
| Sentry                    | `~/Documents/club-arena/.env` (`SENTRY_AUTH_TOKEN/ORG/PROJECT`)                    | read by the sync script                                           |
| Test account              | `daniel@bekavactrading.com`, password in WH `.env.local`                           | never commit it                                                   |

**Known-good facts about tooling:**

- The **GitHub MCP returns "Bad credentials"**. This is not a blocker. Use
  `gh` on the host via `mcp__counselors__host_terminal`. The playbook says
  the same.
- `gh pr view --json statusCheckRollup` **fails** with "Resource not
  accessible by personal access token". Use
  `gh run list --branch <b> --json name,status,conclusion,headSha` instead.
- The host terminal tool **drops the connection on long commands** (pushes,
  `tsc`). The command usually _still completes_. Never assume failure — go
  back and check `git log`, `git ls-remote`, or the push log file.
- Always `export PATH=/opt/homebrew/bin:$PATH` first or `gh`/`node` are missing.

---

## 2. WHERE THINGS ARE

### Repos and worktrees

| Thing                      | Path                                                                                                                             |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Club Arena shared clone    | `~/Documents/club-arena` (GitHub repo: **`Smarter-Poker/Smarter-Poker-Club-Arena`** — note the folder name and repo name differ) |
| Club Arena worktree (mine) | `~/Documents/club-arena/.agent-trees/cowork-ads2/w`                                                                              |
| World Hub shared clone     | `~/Documents/Smarter-Poker-World-Hub`                                                                                            |
| World Hub worktree (mine)  | `~/Documents/Smarter-Poker-World-Hub/.agent-trees/cowork-ads2/w`                                                                 |

**RULE 2: never develop in the shared clone.** Make your own worktree:

```bash
cd ~/Documents/club-arena && git pull --ff-only
eval "$(bash scripts/agent-workspace.sh <your-name> fix/<slug>)"
```

My two worktrees are clean and fully merged. You may reuse or delete them.

### The ads system, file by file

**Club Arena (Vite SPA):**

| File                                                        | What it is                                                                                                                     |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `src/services/AdService.ts`                                 | Client. `resolve()`, `logImpression()`, `logClick()`, `isSafeAdImage()`. Impressions de-dup **per page load, not per render**. |
| `src/components/ads/HouseAdCard.tsx` + `.css`               | Single-card renderer for `empty_state` and `session_summary`. Image with glyph fallback on `onError`.                          |
| `src/components/ads/` (lobby strip)                         | `lobby_strip` surface.                                                                                                         |
| `src/pages/ClubHomePage.tsx` (~line 4129)                   | Mounts `empty_state` **only** in the `totalHere === 0` branch.                                                                 |
| `src/components/session/SessionSummaryHost.tsx` (~line 446) | Mounts `session_summary`. Uses `useNavigate()`.                                                                                |
| `src/pages/admin/HouseAdsPage.tsx`                          | **The admin panel.** ~1470 lines. Stats, suppression, conversions, sparkline trend, placement CRUD, retention strip.           |
| `src/pages/AdminDashboardPage.css`                          | `.admin-panel-soft` (the retention strip) is defined here.                                                                     |
| `tests/unit/houseAds.test.ts`                               | **85 tests**, source-pinned (readFileSync + regex). House style.                                                               |

**World Hub (Next.js):**

| File                                          | What it is                                                                                |
| --------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `pages/api/club-arena/house-ads.js`           | **The admin API.** Platform-admin gate at lines ~155–175, ahead of every method branch.   |
| `src/lib/hubAds.js`                           | The single Hub ad client. `isSafeHubDestination`, `leavesTheNextRouter`, `isSafeAdImage`. |
| `src/components/ui/HubPromoStrip.js`          | Hub home strip.                                                                           |
| `src/components/ads/HubPromoRail.jsx`         | Hub rail.                                                                                 |
| `__tests__/house-ads-hub-promotions.test.mjs` | **24 tests**, registered in `package.json` `prebuild`.                                    |

### Database (project `kuklfnapbkmacvwxktbh`)

Tables: `ad_catalog`, `ad_placement`, `ad_event`, `ad_event_retention_policy`.

Functions (all `service_role` only **except** `fn_resolve_ads`, which the
browser must call):

| Function                                     | Purpose                                                                                                                    |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `fn_resolve_ads(p_slot, p_club_id, p_limit)` | **The only client-callable one.** All targeting, caps, flight dates, `{clubId}` expansion and weighted rotation live here. |
| `fn_ad_stats()`                              | Per-ad totals.                                                                                                             |
| `fn_ad_suppression()`                        | Cap state **in people** over rolling 24h.                                                                                  |
| `fn_ad_conversions(p_window_hours)`          | Did the same player do the thing within N hours.                                                                           |
| `fn_ad_daily(p_days)`                        | 14-day trend.                                                                                                              |
| `fn_ad_retention_status()`                   | Read-only prune preview. **New today.**                                                                                    |
| `fn_prune_ad_events()`                       | The delete. Now has exactly one caller.                                                                                    |
| `fn_strip_client_writes_from_new_views()`    | Event-trigger body. **New today.** Not ads — estate-wide guard.                                                            |

---

## 3. WHAT I DID THIS SESSION — EVERY ITEM

### Merged, verified on `main`, published

**Club Arena PR #1621** — merged 2026-08-28 **17:13:07 UTC**, merge commit
`d7ca4477e2`. All checks green (CI — Build & Type Safety, Silent Revert Guard,
Agent Autopilot).

**World Hub PR #915** — merged 2026-08-28 **17:00:23 UTC**. All checks green.

Earlier the same day, also mine and already merged: **CA #1560** (08:57 UTC),
**WH #914** (17:00 UTC). **WH #912** closed as superseded by #914 (verified an
ancestor). **CA #1615** closed as superseded by #1621.

### 3.1 CHECK 10 was red on main and blocking EVERY PR in the estate

`no_client_writable_views` reads the **live catalog**, not the diff, so it
fails on whatever the database looks like at that moment. It named
`v_insurance_activity` and `v_insurance_pnl` (another agent's, created that
morning).

**The migration that created them contains no GRANT statement.** The default
ACL does:

```
pg_default_acl, schema public, objtype r
  anon=arwdxtm/postgres, authenticated=arwdxtm/postgres
```

`a`, `w`, `d` = INSERT, UPDATE, DELETE. Postgres applies the relation default
ACL to **views** as well as tables, so every view created in `public` is born
holding client write grants nobody typed.

**This was the second occurrence in 24 hours** —
`20260827010000_revoke_client_write_grants_on_club_hand_daily` is the same
failure on a different view, patched one view at a time with the mechanism
left running.

Fixed both halves in
`supabase/migrations/20260828085231_a_new_view_must_not_inherit_write_grants.sql`:
revoked on the two live views, plus a `ddl_command_end` event trigger
(`trg_strip_client_writes_from_new_views`) for `CREATE VIEW` /
`CREATE MATERIALIZED VIEW` in `public`.

**The default ACL is deliberately NOT changed.** It is shared with tables,
where client writes are guarded by RLS rather than by withholding the grant.
Changing it would silently break the next ordinary table. **Do not "improve"
this by changing the default ACL.**

Not a breach: both views aggregate (`GROUP BY`), so they were never updatable
and the grants were inert. The invariant is still right to fail closed,
because a **simple one-table** view with the same grants is a real RLS bypass.

### 3.2 An unknown slot silently relocated a live placement (my own bug)

`pages/api/club-arena/house-ads.js` normalised an unrecognised slot to
`lobby_strip` and audience to `all`. I had even written the comment justifying
it. On `PATCH` that **moves a live placement to a surface nobody named**,
answers `Saved`, and leaves the panel disagreeing with the database.

`normaliseSlot`/`normaliseAudience` are **deleted**, replaced by
`readSlot`/`readAudience` returning `null`. All three call sites 400 with
`Not A Known Slot: <value>`.

**Two nuances that are load-bearing — do not "simplify" them:**

- On **create**, an _absent_ slot still defaults to `lobby_strip`. An ad with
  no placement runs nowhere and looks perfectly healthy in the list. Absent =
  default; present-but-unknown = refusal.
- That validation runs **before** `ad_catalog` is written. Refusing afterwards
  strands a live ad with no placement. **There is a test pinning the relative
  line order of those two statements.**

### 3.3 `fn_prune_ad_events` was a permanent delete with no caller

Not just dead code — a loaded DELETE with no schedule, no preview, no route.
It cannot be scheduled here (CLAUDE.md §11: Open Claw only; §11.3 fails CI on
a net-new `pages/api/cron/` file), so it went to the operator.

Added `fn_ad_retention_status()`
(`supabase/migrations/20260828164114_retention_you_can_look_at_before_you_pull_the_lever.sql`),
surfaced as `retention` on GET, and `POST ?kind=prune` as its single caller.

The panel strip has four deliberate properties. **Preserve all four:**

1. The count is shown before the button **and printed on the button**. Nobody
   learns the size of a permanent delete from its result.
2. **No "how many days" input.** The server reads the policy itself, so the
   number at render and the number at click cannot diverge.
3. When nothing is prunable there is **no control at all**, not a disabled
   one. A dead button on a destructive action invites the experimental click.
4. Backing out of the confirm **disarms** it.

### 3.4 Also fixed

- `.admin-panel-soft` was used with no CSS behind it. Now defined in
  `AdminDashboardPage.css`.
- Schema manifests regenerated against live with
  `scripts/ci/gen-schema-manifest.mjs`.

---

## 4. TRAPS THAT COST ME REAL TIME — YOU WILL HIT THESE

### 4.1 A stale branch will silently REVERT other agents' work

Twice today a branch of mine had fallen behind `main` and its PR would have
reverted other people's code — the World Hub one by **190 files including
built Club Arena assets**, which **RULE 3 forbids touching by hand**.

**Before every push:**

```bash
git diff origin/main..HEAD --stat
```

**Deletions of files you did not touch = STOP.** Rebuild: fresh branch from
`origin/main`, apply only your own hunks:

```bash
git diff <yourcommit>^ <yourcommit> -- <your files> > /tmp/mine.patch
git checkout -b <new-branch> origin/main
git apply -3 /tmp/mine.patch
```

### 4.2 Never merge main into a branch whose commits were already squash-merged

Squash-merge rewrites your commits under a new SHA. Your originals stay on the
branch and **Silent Revert Guard reads them as reverting the squash of
themselves**. This is what killed CA #1615. Rebuild as a single commit on main
instead.

### 4.3 Three-dot vs two-dot diff

`git diff origin/main...HEAD` diffs from the **merge-base**, which predates the
squash, and will show thousands of phantom lines. Use
`git diff origin/main..HEAD` for "what would this PR actually apply".

### 4.4 `build-info.json` and `/health` are CDN-cached

I read `build-info.json` and got a build 12 hours old, **48 commits behind
main**, and nearly reported a stalled publish pipeline. It was cache. Always:

```bash
curl -sL -H 'Cache-Control: no-cache' \
  "https://smarter.poker/hub/club-arena/ca-provenance.json?cb=$(date +%s)"
```

`ca-provenance.json` gives `commit`, `buildTime`, `behindMain`, `dirty`.

### 4.5 Grepping the "live bundle" for a lazy chunk finds nothing

`empty_state` is absent from `index-*.js` because it lives in the
`ClubHomePage-*.js` chunk. Grep the right chunk before concluding code is not
deployed.

### 4.6 Other

- Commit messages go through **`-F <file>`**. A shell heredoc ate a backticked
  word from one of mine.
- Husky runs Prettier on commit; your file will be reflowed. That is normal.
- The pre-commit hook blocks `supabase.auth.getSession()` **by name, including
  inside comments**. Use `getAuthUser()`.
- Commits must be authored
  `Smarter-Poker <254329056+Smarter-Poker@users.noreply.github.com>` or Vercel
  refuses to build them (BLOCKED, no logs at all).
- `--no-verify` is **forbidden** (RULE 4).

---

## 5. PRODUCTION STATE — MEASURED, NOT REMEMBERED

Read at 17:10 UTC 2026-08-28:

```
ads_total 6 · ads_active 6 · placements 18 · placements_active 18
slots_live 4 · events 248 · clicks 3 · ads_running_nowhere 0
PEOPLE REACHED: 5
with_image 0 · in_experiment 0
```

Per slot:

| slot              | ads | impressions | people | clicks | last event |
| ----------------- | --- | ----------- | ------ | ------ | ---------- |
| `lobby_strip`     | 6   | 225         | 5      | 2      | 16:47 UTC  |
| `hub_promotions`  | 6   | 18          | 4      | 1      | 12:24 UTC  |
| `session_summary` | 3   | 2           | 2      | 0      | 13:31 UTC  |
| `empty_state`     | 3   | **0**       | 0      | 0      | never      |

Retention: 180-day policy, 248 events, oldest 2026-08-27, **0 past the
cutoff** — so the panel correctly shows "Nothing Past The Cutoff." and offers
nothing to press.

`economy_invariants()`: **12/12 green.**

Published build: `behindMain: 0`. Both repos' `main` contain all the work
(verified by content, since squash-merge changes SHAs).

**`empty_state` at 0 impressions is NOT a bug.** It renders only where the
lobby has genuinely nothing _and_ the player has no remedy. The other empty
views carry a "Show All Games" button, and an advert beside a fix competes
with the fix. Its condition has not occurred for those 5 people. It is live in
the deployed `ClubHomePage` chunk — verified.

---

## 6. WHAT IS LEFT

### The one thing I did NOT verify and did not claim

**A real browser end-to-end of the placement editor against production.**
Create / edit / toggle / delete a placement through
`/hub/club-arena/admin/house-ads` as a platform admin, and confirm the
database agrees afterwards. Everything else this session was proved by command
output or a live query. This one is unit-tested only. **Do this first.**

### Deliberately deferred, with reasons — do not treat as bugs

| Item                                   | Why it is deferred                                                                                                                    |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `table_between_hands` slot unwired     | Declared, no placements. Wiring it needs a decision about interrupting play. Dan's call.                                              |
| `diamonds_store` off `session_summary` | Showing "Buy Chips Instantly" to someone who just lost is a **targeting** decision, and targeting belongs to Dan, not to a component. |
| `fn_prune_ad_events` unscheduled       | CLAUDE.md §11: Open Claw is the only sanctioned scheduler; §11.3 fails CI on a net-new cron route. It is operator-driven on purpose.  |
| Image creatives (0 in use)             | Built and tested. Nothing to show yet.                                                                                                |
| A/B experiments (0 in use)             | `experiment_key` shipped; no experiment has been defined.                                                                             |

### My honest read on priority

**Total reach is five people.** The ad system now measures reach in people,
refuses silent writes, reports per surface, attributes conversions, rotates by
weight, and prunes on demand. Building more of it — `table_between_hands`,
images, experiments — adds machinery above a five-person funnel. Those are
ready to switch on the day there is an audience.

The highest-value question left is **why five people**, and that is a
different project outside the ads code. Get Dan's direction before starting
it.

---

## 7. YOUR FIRST FIVE COMMANDS

```bash
export PATH=/opt/homebrew/bin:$PATH

cd ~/Documents/club-arena && git fetch origin main && git log --oneline -5 origin/main

cat ~/Documents/club-arena/.agents/rules/00-agent-playbook.md

curl -sL -H 'Cache-Control: no-cache' \
  "https://smarter.poker/hub/club-arena/ca-provenance.json?cb=$(date +%s)"

eval "$(bash ~/Documents/club-arena/scripts/agent-workspace.sh <your-name> fix/<slug>)"
```

Then, via the **Supabase MCP** (project `kuklfnapbkmacvwxktbh`):

```sql
select check_name, ok from public.economy_invariants() order by ok;
```

If anything there is `false`, **fix it before your own work** — CLAUDE.md §4
is fix-first, and a red `main` blocks everyone, not just you.

---

## 8. THE STANDARD YOU ARE HELD TO

RULE 6: **no claim without a command behind it.** "Tests pass" means you ran
them and can paste the count. "It is deployed" means you checked what
production serves, cache-busted.

RULE 8, the Zero-Assumption Doctrine: a green PR proves your code does not
crash. It does not prove you fixed the problem. Assume the user's browser is
hostile — stale `localStorage`, old bookmarks, expired tokens, mid-flight
drops. If your fix needs a freshly-cleared browser, it is not a fix.

And the one that matters most here: **an honest gap is worth more than a
confident claim someone else has to discover is wrong.** Two of the three
defects I fixed today were my own, found by re-reading my own merged diff
against the question _"is every new function actually called, and does every
write do what it says?"_ Ask that of your own work before you call it done.
