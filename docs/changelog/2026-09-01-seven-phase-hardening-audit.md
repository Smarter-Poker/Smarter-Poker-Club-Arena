# Seven-phase hardening audit (2026-09-01)

Follow-on to the push-and-publish cost audit. Dan asked for every remaining
improvement to be built out, one phase at a time, fully wired and tested.
This is the closeout record.

## Phases shipped

1. **Definer-function security lockdown.** 815 Supabase security-advisor
   findings; revoked browser execute on 12 unambiguous server-only money/sweep
   functions, probe-verified live. Migration `20260901232323`, PR #2572.
   Remaining 271-candidate verify-or-revoke tracked in issue #2573.
2. **Cron-liveness self-healer.** The detection script that another agent
   built now HEALS the repo-level schedule-registration wedge (disable+enable
   to re-register), gated on 3+ simultaneous overdue, with an anti-flap
   cooldown issue. Live fire-drill: cycled 11, all active after. PR #2575.
3. **Estate digest.** Daily 6:07am Chicago one-pager (publish truth, volume,
   cron liveness, incident board, migration drift) to a self-updating issue +
   in-app notification. Live-tested end to end. PR #2577.
4. **Disaster recovery.** Found the one single-copy risk (engine `server/.env`)
   and fixed it: AES-256 encrypted backup, keychain passphrase, roundtrip
   verified. `docs/dr/RESTORE-RUNBOOK.md` + `tests/dr-posture.test.ts`.
   PR #2578. Human-only controls (PITR, Hetzner snapshots, restore drill)
   filed as issue #2579.
5. **Migration backfill.** Recovered 676 unrecorded migration files byte-exact
   from the database's own statements (665 full SQL, 11 documented stubs);
   reconciler now reports all recorded. PR #2580.
6. **Unshipped-work rescue + Mac-SPOF runbook.** Pushed 85 orphan worktree
   branches to `origin/rescue/*` (100% of 2+-commit work).
   `docs/dr/MAC-IS-THE-ONLY-DEV-MACHINE.md`. PR #2582.
7. **Housekeeping** (this change set):
   - Flaky `titleCaseEveryWord` test given a 20s timeout (was tripping the 5s
     default under concurrent suites; work unchanged). PR: this.
   - World Hub `.gitignore` stops ignoring `.memory/` - it contradicted
     CLAUDE.md ('PUBLIC and tracked on main') and forced `git add -f`. WH #1241.

## Verified, no change needed

- **GH_PAT expiry (2026-11-19).** Swept every reference in both repos. Every
  workflow uses the App installation token FIRST with GH_PAT only as a
  fallback (`app-token || GH_PAT || GITHUB_TOKEN`); every script has a
  GITHUB_TOKEN alternative; `apply-main-ruleset.mjs` is a one-time manual
  admin tool. Nothing hard-depends on GH_PAT, so the expiry is already a
  non-event as long as the App mints (it does, from `vars.AUTOPILOT_APP_ID`).
  `check-token.sh` already verifies the live token before runs.

## Deferred, honestly - needs Dan, not an agent sweep

- **Docs distillation of CLAUDE.md (~800 lines).** Real value: the em-bars
  war happened because a rule's meaning was ambiguous across duplicated,
  self-correcting prose. But every line is a binding rule tied to a real
  incident, and a wholesale rewrite risks dropping one silently - the exact
  failure mode the estate keeps hitting. This should be a deliberate,
  reviewed pass with Dan choosing what moves to an archive, NOT an automated
  edit. Flagged rather than done, on purpose.
- **The 271-function definer verify-or-revoke** (issue #2573) and the two
  root-cause hunts (#2531, #2532) are genuine multi-session investigations,
  not sweep items.
