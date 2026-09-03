# AGENT OPERATIONS GUIDE — read before touching anything

For every Claude agent (Cowork, CLI, Antigravity, subagents) on this platform.
Written 2026-08-19 after a session that hit every trap below and paid for it.
Companion to `.agent/SELF-PUBLISH-PROTOCOL.md` (push mechanics) and
`.agent/CLAUDE_AGENT_RULES.md` (RULES 1-12). If this file and reality
disagree, verify reality, then fix this file.

## 1. KNOW WHICH SHELL YOU ARE IN — the single biggest source of wasted time

| Shell                       | Where it runs                    | Network                                             | Delete files    | Repo access       | Use for                                |
| --------------------------- | -------------------------------- | --------------------------------------------------- | --------------- | ----------------- | -------------------------------------- |
| `counselors__host_terminal` | The Mac host, user smarter.poker | YES                                                 | YES             | ~/Documents/\*    | push, publish, gh, locks cleanup, node |
| `device_bash` (Cowork VM)   | Sandboxed Linux VM, repo mounts  | NO                                                  | NO (`rm` fails) | /sessions/_/mnt/_ | editing files, running node harnesses  |
| `Bash` (cloud container)    | Anthropic cloud sandbox          | partial (proxy blocks github repos + smarter.poker) | YES             | NO repo           | npm lockfile work, Playwright renders  |

- Host shells are NON-LOGIN: start anything needing node/gh with
  `export PATH="/opt/homebrew/bin:$PATH"`. nvm also exists (~/.nvm).
- Host commands killed by the 60s MCP tool timeout KEEP RUNNING. Check
  `pgrep -f <script>` before starting a second copy. Run long jobs detached:
  `nohup <cmd> > /tmp/x.log 2>&1 &` and poll the log.
- On the VM, never fight a git lock by renaming it repeatedly -- 100+ stale
  `.lock.old` files accumulated that way. From the HOST:
  `find .git -name "*.lock*" -mmin +10 -delete`.
- The VM cannot run `next build` or `vite build` (arch-mismatched node_modules).
  Do not try. Typecheck with the repo's own tsc; build gates run on host/CI.

## 2. PUSH AND PUBLISH — never end a session unpushed, never hand off

Full mechanics in `.agent/SELF-PUBLISH-PROTOCOL.md`. Summary:

- World Hub: host shell -> clear stale locks -> ensure upstream
  (`git branch --set-upstream-to=origin/main main` if `git status -sb` shows a
  bare `## main`) -> `nohup bash scripts/git-safe-push.sh "msg" > /tmp/push-wh.log 2>&1 &`
  -> poll for DEPLOY_VERIFIED:true and SHA_MATCHED:true.
- Club Arena: if origin moved and the tree holds another agent's uncommitted
  files, merge in a THROWAWAY WORKTREE (never stash their files):
  `git worktree add --detach /tmp/ca-merge origin/main; cd /tmp/ca-merge;
git merge --no-edit main; ln -sfn ~/Documents/club-arena/node_modules node_modules;
./node_modules/.bin/tsc --noEmit -p tsconfig.app.json; git push origin HEAD:main;`
  then remove the worktree. Pushing CA main triggers: CI, Silent Revert Guard,
  Publish Club Arena (publishes the bundle to ca-static.smarter.poker), Auto-Deploy Hetzner Engine
  (server/ changes go LIVE on the game engine). Verify ALL of them:
  `gh run list --repo Smarter-Poker/Smarter-Poker-Club-Arena --limit 5`.
  A red run = not published. Fix forward the same session.
- Vercel needs nothing manual (GitHub integration deploys on push). Verify
  READY on the expected commit via the Vercel MCP, then content-check.

## 3. CREDENTIALS — where things actually are (post-rotation, 2026-08-19)

- `VERCEL_TOKEN`: valid tokens live in `Smarter-Poker-World-Hub/.env.local`
  and `club-arena/.env` (sourced from the Vercel CLI session, verified against
  the API). If one ever 401s again, the CLI session at `~/Library/Application
Support/com.vercel.cli/auth.json` on the host is the source of truth.
- Supabase: NEW-format keys (`sb_secret_...`, `sb_publishable_...`) in
  `WH/.env.local` and `CA/.env`. Legacy JWT-format keys are REVOKED --
  placeholders marked `<REVOKED-2026-08-16-...>` are intentional, leave them.
  Server work goes through the Supabase MCP when available (project
  kuklfnapbkmacvwxktbh); it needs no local key.
- GitHub: the host's git remotes and `gh` CLI are already authenticated --
  just use them from host_terminal. Do NOT copy tokens into new files, do NOT
  print token values into chat/logs, ever. `GH_PAT`/`AUTOFIX_GITHUB_TOKEN`/
  `NPM_TOKEN` placeholders marked `<ROTATED-2026-08-16>` are intentional.
- Hetzner: SSH keys exist ONLY as GitHub Actions secrets (write-only). WH
  workflows use `HETZNER_SSH_PRIVATE_KEY`; CA workflows use `HETZNER_SSH_KEY`.
  Rotations must update BOTH names in BOTH repos' Settings -> Secrets.
- `.env.example` files contain intentional placeholders that 401. Never
  "fix" them with real values -- they are committed and public.

## 4. VERIFY AGAINST REALITY, NOT AGAINST FILES — the recurring lesson

Every serious incident this month traces to trusting a stale artifact:

- MIGRATION FILES LIE. Before touching a live DB function, diff against
  `pg_get_functiondef()` on production. A drafted "fix" for atomic_table_buyin
  based on the last migration file would have reverted three later security
  gates and broken every buy-in (uuid vs text). The live definition is truth.
- THE SCHEMA MANIFEST GOES STALE. CI "phantom RPC" failures usually mean the
  manifest lags production, not that the code is wrong. Check pg_proc first;
  regenerate with `node scripts/ci/gen-schema-manifest.mjs` (CA repo, needs
  SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from CA/.env).
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
- Commit early and often -- Antigravity's `git reset --hard origin/main`
  destroys uncommitted work AND unpushed local-only commits. If you must stop
  with unpushed work, `git bundle create .agent/backup-<date>.bundle
origin/main..HEAD` first (untracked files survive resets).

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
  claims): cp into a device-mounted folder, stage via device_stage_files,
  then Read the staged path.
- A run that fails can be a PRODUCT bug, a TEST bug, or a PLATFORM incident —
  check https://status.supabase.com before debugging your own code (the
  2026-08-20 API Gateway degradation produced infinite club-home skeletons
  that looked exactly like an app bug; ClubHomePage now has a 15s watchdog
  that surfaces the Retry panel instead).

## 9. WHEN GITHUB ACTIONS IS DOWN — publish it yourself

2026-08-20: every workflow on every commit began failing in 2-5 seconds with
`runner_name: ""` — jobs never got a runner (org billing / spending limit).
Nothing had built or deployed for ~20 minutes and nobody noticed, because a
red X next to a commit looks like a normal test failure.

Tell the two apart before you debug your own code:

    gh run view <id> --json jobs   # runner_name empty + <5s duration = no runner
    gh run list --limit 20         # EVERY workflow failing, including trivial
                                   # ones like Silent Revert Guard => infra

When it is infra, your commits are pushed but NOT published. Publish the Club
Arena bundle yourself, straight to its origin (rewritten 2026-09-03 — there is
no World Hub in this path any more):

    cd ~/Documents/club-arena
    git worktree add --detach /tmp/ca-pub origin/main
    ln -s ~/Documents/club-arena/node_modules /tmp/ca-pub/node_modules
    cd /tmp/ca-pub && npm run build

    SHA=$(git -C /tmp/ca-pub rev-parse HEAD)
    # build-info.json must name the sha you are publishing, or the watchdog
    # will read production as behind main forever.
    python3 - "$SHA" <<'JSON'
    import json,sys,datetime
    json.dump({"ca_sha":sys.argv[1],"built_at":datetime.datetime.utcnow().isoformat()+"Z","built_by":"manual"},
              open('/tmp/ca-pub/dist/build-info.json','w'), indent=2)
    JSON

    ORIGIN=$(security find-generic-password -a smarter-poker -s estate-ci-ip -w)
    rsync -az --delete -e "ssh -i ~/.ssh/hetzner_deploy" \
      /tmp/ca-pub/dist/ "ci@$ORIGIN:/srv/club-arena/releases/$SHA/"
    # additive, never --delete: a player mid-hand still asks for the previous
    # hashed chunks (see deploy-paths.md, Tier 2).
    rsync -az -e "ssh -i ~/.ssh/hetzner_deploy" /tmp/ca-pub/dist/assets/ "ci@$ORIGIN:/srv/club-arena/pool/assets/"
    rsync -az -e "ssh -i ~/.ssh/hetzner_deploy" /tmp/ca-pub/dist/fonts/  "ci@$ORIGIN:/srv/club-arena/pool/fonts/"
    ssh -i ~/.ssh/hetzner_deploy "ci@$ORIGIN" \
      "cd /srv/club-arena && ln -sfn /srv/club-arena/releases/$SHA current.tmp && mv -Tf current.tmp current"

    curl -s "https://smarter.poker/hub/club-arena/build-info.json?cb=$RANDOM" | grep "$SHA"

The last line is the only proof that counts. A rollback is the same symlink
swap against an older directory under `releases/`.

CHECK WHAT YOU PUBLISH. The retired sync script refused a bundle that could
not boot: it resolved the entry chunk out of index.html and confirmed the
Supabase URL and anon key were baked into it. That check existed because the
old one ("index.html exists") passed a config-less build to production on
2026-08-20 and every visitor got a blank page (`Uncaught Error: supabaseUrl is
required`). Doing this by hand, you are that check:

    ENTRY=$(grep -oE '/assets/index-[^"]+\.js' /tmp/ca-pub/dist/index.html | head -1)
    grep -q "supabase.co" "/tmp/ca-pub/dist${ENTRY}" && echo "config baked in: OK" || \
      echo "REFUSE TO PUBLISH: no Supabase config in the entry chunk"

Vercel deploys on git push and does NOT depend on GitHub Actions, so a WH push
still ships. Verify content-level, never by SHA alone:

    curl -s https://smarter.poker/hub/club-arena/build-info.json
    # then grep the chunk the live index actually imports for your own string

`vercel` failing with "token ... is not valid" on a machine that is logged in
means a stale VERCEL_TOKEN in the process environment is shadowing auth.json.
No .env edit fixes that. Use `bash scripts/vercel-safe.sh <cmd>`.

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
