# Agent operations guide

Read root `AGENTS.md`, `AGENT-PLAYBOOK.md` and `docs/agent-policy/REFERENCE-INDEX.md` at task start and every resumption. They link to the current owner policy, operating law and hardening standard. Read `PUBLISHING.md` for delivery. Later owner instructions govern operating authority; the product and financial laws below remain applicable within the assigned scope. Historical programmes are not automatic assignments.

## 4. VERIFY AGAINST REALITY, NOT AGAINST FILES — the recurring lesson

Every serious incident this month traces to trusting a stale artifact:

- MIGRATION FILES LIE. Before touching a live DB function, diff against
  `pg_get_functiondef()` on production. A drafted "fix" for atomic_table_buyin
  based on the last migration file would have reverted three later security
  gates and broken every buy-in (uuid vs text). The live definition is truth.
- THE SCHEMA MANIFEST GOES STALE. CI "phantom RPC" failures usually mean the
  manifest lags production, not that the code is wrong. Check pg_proc first;
  regenerate through the trusted Club Arena schema-manifest workflow, whose
  database credential comes from the repository secret store. A workstation
  `.env` is never production authority.
- A REPORTED SHA IS NOT A DEPLOY. Prove pushes on content:
  `git show origin/main:<file> | grep <symbol>`. A coordinator once reported
  "deployed" while origin had not moved.
- A BACKGROUNDED CHROME TAB STOPS requestAnimationFrame COMPLETELY. Every
  framer-motion animation freezes and AnimatePresence mode="wait" phase
  switches never mount -- "Start Training" looks dead when it is fine.
  Foreground the tab and assert rAF ticks before believing any screenshot.
- BACKLOG ITEMS GO STALE. Two "known gaps" (streaks wiring, training_answers
  columns) were already fixed when an agent went to fix them. grep the code
  and query the DB before starting work someone described weeks ago.

## 5. THE HOUSE BUG SHAPE — hunt it in every audit

Nearly every real defect found across 60+ fixes was a SILENT FALLBACK MASKING
A FAILURE: `|| 0` where 0 is also a valid seat index; `|| 'hero'` on a missing
lookup; `?? 0` colliding with fold's real EV; `|| 6` inventing a pot;
`|| 1.5` inventing another; one enum value covering two different poker
situations; hero-relative tables indexed with absolute indices (FOUR separate
shipped defects); `catch {}` swallowing and guessing; a fail-OPEN cap check
returning [] on DB error. When auditing, grep for these shapes first. When
writing code: unknown stays unknown, caps fail closed, never render a guess.

## 6. CONCURRENCY — several agents share these repos at once

- NEVER `git add -A` / `git add .` -- it has swallowed other agents'
  half-finished work repeatedly. Stage explicit paths you personally edited.
- Re-read `git status` immediately before every commit.
- When origin moved under you: MERGE, do not rebase (rebasing under
  concurrent writers churns SHAs and broke handoffs twice).
- Never stash or revert another agent's dirty files; use the worktree pattern.
- Commit coherent, reviewed slices and push the feature branch promptly.
  Destructive reset/rebase shortcuts are forbidden in shared repositories;
  preserve another agent's work and merge current `origin/main` hunk by hunk.

## 7. HOUSE RULES QUICK LIST

- No emoji in source, data rows, or commit messages. Approved glyphs:
  suits and the set in TRAINING-UI-SPEC. Three deliberate exceptions where
  emoji ARE the payload: EmojiThrower.jsx, ThrowableEmojis.jsx, and the
  reaction arrays in LivePokerTable.jsx.
- API routes: `getServerUserWithFallback` from serverAuth -- never authUtils
  (client-only, breaks server auth), never raw supabase.auth.getUser (hook
  blocks it; note the hook's own error message wrongly says authUtils).
- `.maybeSingle()` never `.single()`. No raw supabase-js imports in API routes.
- Migrations via Supabase MCP `apply_migration` (auditable), mirrored into
  supabase/migrations/ EXACTLY as applied. Data-shape rule: sole-value fields
  (icon:'x') get remapped, inline decorations get deleted -- blanking a
  sole-value field ships an empty UI slot.
- Run the harnesses before committing anything they cover; they are cheap and
  they have caught real regressions: WH `scripts/*-check.js` +
  `engine-correctness-harness.js`; CA `scripts/multi-table-check.js` +
  `server/src/*.test.ts`. Never loosen an assertion to make it pass.
- `public/hub/club-arena/` in WH was build output. It is **DELETED** (2026-09-02)
  and must never come back: Club Arena publishes to its own origin
  (`ca-static.smarter.poker`) and the World Hub reaches it with a single
  rewrite. Next serves `public/` BEFORE that rewrite, so a file re-vendored
  there does not duplicate the bundle, it SHADOWS it - production would keep
  serving whatever was last committed while the origin published into the void.
  `tests/club-arena-is-a-rewrite.test.mjs` in the World Hub fails CI if it
  returns.

## 8. REAL-BROWSER E2E — run before claiming UI work done

File-level checks, harnesses and even deployed-chunk greps prove the CODE
shipped; only a real browser proves the FLOW works. Both repos now carry
production walkthrough scripts — run the relevant one and read its PASS/FAIL
lines + screenshots BEFORE reporting any user-facing work as complete.

- Club Arena: `e2e-live/` (plain playwright, standalone). Run from the HOST
  (network + node_modules): `SP_EMAIL=... SP_PASS=... bash scripts/e2e-host.sh
multitable-walk` (or `trainer-walkthrough`). Read e2e-live/README.md first —
  it encodes the selector map and five hard-won rules (single-use refresh
  tokens, icon-only "+" button, buy-in confirm class, rAF stops in
  backgrounded tabs, always leave tables at the end).
- The @playwright/test suite lives in `tests/e2e/` (see playwright.config.ts).
  The top-level `e2e/` directory is ORPHANED — testDir moved to tests/e2e in
  3de146acd and nothing runs those specs. Do not add specs there.
- Screenshots land in /tmp/e2e-shots. To LOOK at them (mandatory for visual
  claims): use the current available image-viewing tool on the actual saved artifact.
- A run that fails can be a PRODUCT bug, a TEST bug, or a PLATFORM incident —
  check https://status.supabase.com before debugging your own code (the
  2026-08-20 API Gateway degradation produced infinite club-home skeletons
  that looked exactly like an app bug; ClubHomePage now has a 15s watchdog
  that surfaces the Retry panel instead).

## 9. Provider or deployment failure

Follow `PUBLISHING.md` and the operating law. Diagnose the actual failing owner and compare its last successful equivalent. Repair and validate promptly. An outage does not authorize a local build/upload, a second publisher, a new scheduler or bypassing checks. Retain the exact pending run and continue eligible authorized work. Keep actual publication and live proof outstanding until verified.

## 10. ASSET AND SCHEMA-GRANT TRAPS (2026-08-20 sweep)

Two whole classes of defect turned up by measuring instead of reading:

**Images ship at source resolution unless someone stops them.** The arena's
first paint was 6.21 MB of images — a 297 KB PNG for a 40-pixel help icon, a
1179x1509 avatar drawn at 48x48. Now 1.6 MB, FCP 1012ms -> 696ms.
`scripts/optimize-arena-images.sh` handles both halves:

    bash scripts/optimize-arena-images.sh          # critical path, to 3x render box
    bash scripts/optimize-arena-images.sh --bulk   # everything else in public/images
    bash scripts/optimize-arena-images.sh --check  # CI gate, non-blocking

Both modes are IDEMPOTENT and that property is load-bearing: pngquant shaves
another ~25% off an already-quantised file every time it runs, so a byte-based
rule would keep "finding work" and silently degrade quality on each pass. The
critical-path pass keys on DIMENSIONS; the bulk pass keys on BYTES-PER-PIXEL
with the threshold above every observed post-pass value. Prove it after any
change by running twice and hashing.

Before adding an entry, MEASURE the render box with getBoundingClientRect() on
the deployed page — do not guess it from the design.

Uploaded images need the same treatment at both ends: `sizedStorageUrl()` asks
Supabase's transform endpoint for the display size (263 KB -> 4.3 KB per seat
avatar), and AvatarService downscales to 512px before upload so the original is
never stored.

**A table's RLS policy passing does NOT mean the query will.** Column grants
are separate, and Postgres rejects the WHOLE statement when a star-select
touches an ungranted column. `profiles` has 114 columns and `authenticated` may
read 103, so `.select('*')` returned 403 on every profile load, for every
signed-in user, forever — and both call sites had written the failure off as an
"expected anon/RLS denial". It was neither.

    -- what to check when a read 403s but the policy looks fine
    select count(*) from information_schema.columns
      where table_schema='public' and table_name='X';
    select count(*) from information_schema.column_privileges
      where table_schema='public' and table_name='X'
        and grantee='authenticated' and privilege_type='SELECT';

If those two numbers differ, never `select('*')` on that table. Storage buckets
have the same trap by path prefix: club-assets granted INSERT only under
`club-logos/%` while the code wrote to `club-cards/%`, so club-card baking had
never once succeeded — and it retried on every HomePage load.

Test a suspected grant problem with a REAL user JWT, not the anon key. Anon
often has no grants at all, so it fails for a different reason and tells you
nothing:

    JWT=$(curl -s "$URL/auth/v1/token?grant_type=password" -H "apikey: $ANON" \
      -H 'Content-Type: application/json' -d '{"email":"...","password":"..."}' \
      | python3 -c 'import json,sys;print(json.load(sys.stdin)["access_token"])')
    curl -s -o /dev/null -w '%{http_code}\n' "$URL/rest/v1/profiles?select=*&id=eq.$ID" \
      -H "apikey: $ANON" -H "Authorization: Bearer $JWT"
