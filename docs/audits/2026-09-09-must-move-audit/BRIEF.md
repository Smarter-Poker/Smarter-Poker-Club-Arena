# Must Move / Classic-Action-Madness full audit - swarm brief (2026-09-09)

Dan's order: "FULL AUDIT OF THE MUST MOVE GAMES, AND THE FUNCTIONALITY BETWEEN
CLASSIC, ACTION AND MADNESS. LINE BY LINE ... CHECK FOR ANY AND ALL BUGS, GAPS,
STUBS, ERRORS, REGRESSIONS OR WIRING ISSUES ... FIND AND FIX EVERYTHING ...
100% GOOD TO GO BEFORE WE ADD ON 'LIGHTNING POKER'."

## Where you work

- Worktree (branch `agent/cowork-mustmove/audit/must-move-classic-action-madness`,
  base origin/main 98ef24c6a1):
  - device_bash path: `$HOME/mnt/cowork-mustmove`  (read, grep, edit in place with
    python/sed; NEVER run any git command here - the VM strands index.lock)
  - host_terminal path: `~/Documents/.agent-trees/club-arena/cowork-mustmove`
    (real Mac bash: node/npm/vitest/tsc/git READ commands. 60 s limit per call ->
    launch anything longer with `nohup ... > /tmp/<lane>-<x>.log 2>&1 < /dev/null & disown`
    and poll the log. Prefix: `export PATH="$HOME/.nvm/versions/node/$(ls ~/.nvm/versions/node | tail -1)/bin:$PATH"`)
- Production database: Supabase MCP project `ydsaqnnuwyvtyxgvrnys` (read with
  execute_sql; the LIVE function body is `select pg_get_functiondef('public.fn_x'::regproc)`
  and is the truth over any migration file).
- Do NOT commit, push, or apply migrations to production. Write migration files
  (see below), probe them ROLLED BACK inside one execute_sql call
  (`BEGIN; ... ROLLBACK;` or a DO block ending in RAISE EXCEPTION), and report.
  The integrator applies them serially.

## Read first (all in the worktree)

- `CLAUDE.md` sections 4 (fix-first), 4.5, 5, 10.5, 10.8, 10.9; `AGENT-PLAYBOOK.md` Rule 1 Part C.
- `docs/HANDOFF-TABLE-STAKES-CURRENT-STATE.md`, `docs/OPORD-1.4-AMENDMENT.md` (section 18).
- `docs/changelog/2026-09-04-cash-games-slice-1.md`, `...-slice-1-hardening.md`,
  `2026-09-05-cluster-controller-slice-2.md`, `2026-09-05-the-must-move-lobby.md`,
  `2026-09-05-the-move-survives-the-hand-and-a-game-seats-you-once.md`,
  `2026-09-05-moving-in-n-hands-and-the-lobby-says-the-style.md`,
  `2026-09-05-action-and-madness-are-one-game-per-blind-category.md`,
  `2026-09-06-four-ceilings-on-the-cash-floor.md`, `2026-09-07-the-feeder-cluster-audit.md`,
  `2026-09-09-a-classic-game-has-no-antes-and-no-bombs.md`, `2026-09-09-cash-buyin-seat-refusal-recovery.md`,
  `2026-09-09-the-fleet-nobody-was-running.md`.
- Migrations: everything in `supabase/migrations/` from `20260904160500_cash_games_slice_1.sql`
  onward whose name mentions cash / cluster / seat / must_move / roster / band /
  classic / feeder / moved_seat (list with `ls supabase/migrations | grep ...`).

## Rules that bind you

1. FIX-FIRST (CLAUDE.md 4): find -> fix fully -> move on. No "recommendations" lists
   for things you could have fixed. Real code, real tests.
2. A restriction in code with nothing written behind it is a defect (10.8/10.9).
   Dan's rulings are written in the changelogs and handoffs above; the live code is
   evidence of behaviour, never of intent.
3. Horses are players (10.5): nothing may special-case `is_horse` to skip a rule.
4. Every fix ships with the test that would have caught it (root `tests/`, or
   `server/src/**/*.test.ts`). New `*.law.test.*` files need `docs/laws.d/<slug>.md`.
5. Migrations: create with `bash scripts/reserve-migration-version.sh <slug>` on
   host_terminal (never hand-pick a version). One BEGIN/COMMIT per file. Declare new
   objects in your own `scripts/ci/schema-manifest.d/<slug>.json` (read the README
   there); never edit the two big manifest JSONs.
6. Never spend real chips / never seat real players to test (11.5). Probe rolled back.
7. Copy: no em dashes (U+2014) anywhere in code, copy or docs. Title Case for player-facing copy.
8. UI: #SmarterCasinoRealism / #ClubArenaConsole - anything you touch visually must
   keep the premium console chassis; never introduce flat generic panels.
9. Keep your edits to your lane's files. If you must touch a shared file
   (lobbyEntries.ts, ServerTableEngineBase.ts, fn_cash_cluster_tick), keep the edit
   surgical and say so in your report so the integrator can reconcile.
10. Do not run the full vitest suite (it is huge); run the files covering your change,
    and `npx tsc --noEmit -p server` / root `npx tsc --noEmit` if you changed TS.

## What your report must contain

Write `docs/audits/2026-09-09-must-move-audit/lane-<letter>.md` with:
- Every file/function you read line by line (so the integrator knows coverage).
- Findings: each with severity (P0 money/integrity, P1 player-visible wrong behaviour,
  P2 gap/stub/dead code, P3 polish), evidence (query output or line refs), and the
  fix (file + what changed + test).
- Anything you could not fix and why (precisely).
- Commands you ran with their tail output (tsc / vitest counts).
