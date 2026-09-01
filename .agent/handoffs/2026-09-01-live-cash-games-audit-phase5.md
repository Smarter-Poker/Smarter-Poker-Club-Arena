# HANDOFF - Live Cash Games Full Audit - PHASE 5 OF 6

**Written:** 2026-09-01 ~13:00 UTC
**Repo:** `Smarter-Poker/Smarter-Poker-Club-Arena`
**Supabase project_id:** `kuklfnapbkmacvwxktbh`
**Status:** Phases 1-4 complete and verified in production. **You start at Phase 5.**

Read `.agent/handoffs/2026-08-31-live-cash-games-audit-phase2.md` first for the
laws, the environment traps and the full history. This file only updates it.

---

## WHAT CHANGED SINCE THAT FILE WAS WRITTEN

### The environment is better than it says

- **GitHub Actions is running again.** It was stopped account-wide on the night
  of 2026-08-31 and every workflow failed in seconds with no steps. It is fine.
- **The GitHub MCP is still dead** (`Bad credentials`). Do not debug it.
- **The working route is the Mac host, not the sandbox.** `mcp__counselors__host_terminal`
  runs bash on Dan's machine, where `git@github.com` SSH works and
  `api.github.com` is reachable. The sandbox (`mcp__workspace__bash`) has NO
  egress to GitHub at all. The API token lives in `~/Documents/club-arena/.env`
  as `GITHUB_TOKEN` (93 chars, admin scope, authenticates as Smarter-Poker).
  `gh` is NOT installed; use `curl` against the REST API.
- **Claim a worktree**, per AGENT-PLAYBOOK: `git worktree add -b fix/<slug>
~/Documents/.agent-trees/club-arena/<your-name> origin/main`. Takes ~40s;
  run it with `nohup ... &` and return immediately, because the host_terminal
  tool kills the process group when a call times out.
- **`node` is not on the default PATH.** Prefix everything with
  `export PATH="$HOME/.nvm/versions/node/$(ls ~/.nvm/versions/node | tail -1)/bin:$PATH"`.
- **The pre-push hook takes ~3 minutes** (guards, then `tsc`, then the tests
  covering your diff). Launch `git push` with `nohup ... > /tmp/push.log 2>&1 &`
  and poll the log in later calls. Do NOT `--no-verify`.
- **Rebasing your branch onto main is refused by a ref-guard hook.** Use
  `git merge origin/main` instead. The manifest WILL conflict, because several
  agents add functions to it every hour: resolve by taking main's copy whole and
  re-appending only your own names. Never regenerate it.

### Phases 1 to 4 are done

| Phase      | Scope                       | Status                                                                   |
| ---------- | --------------------------- | ------------------------------------------------------------------------ |
| 1 of 6     | Money-integrity alarms      | DONE, re-verified today                                                  |
| 2 of 6     | Cash table config integrity | DONE (PR #2382 merged)                                                   |
| 3 of 6     | Cash rule guards            | DONE - `docs/changelog/2026-09-01-phase-3-cash-rule-guards.md`           |
| 4 of 6     | Deploy truth watchdog       | DONE - `docs/changelog/2026-09-01-deploy-truth-lives-in-the-database.md` |
| **5 of 6** | **Human-path E2E**          | **YOU START HERE**                                                       |
| 6 of 6     | Storage/cost + dead schema  | pending                                                                  |

### New machinery you should know exists

- `fn_repay_unaccounted_seat_exits(p_since, p_max_total)` - repays stacks that
  left the felt with no wallet credit. Reads the detector live, so nothing is
  paid twice. **Not scheduled on purpose.** Used once today to return 1,216.54
  chips to 12 horses whose seats were vacated during the Deep Stack Society
  teardown.
- `fn_ca_unresolved_write_failures()` - the write-failure count that can reach
  zero (the raw table is append-only and only ever climbs).
- `ca_engine_deploy_attempts` + `fn_ca_engine_deploy_truth_watch()`, scheduled
  `ca-engine-deploy-truth-10m`. Answers "is the engine running main" from the
  database, because Actions cannot watch itself. Raises four alarms into
  `financial_alerts` under `deploy_truth.*`.

### The single most useful query in this repo now

```sql
select engine_version, count(*) tables_held, count(distinct instance_id) instances,
       min(acquired_at) claimed, max(heartbeat_at) last_heartbeat
from public.engine_table_leases group by 1 order by 5 desc;
```

That is what the engine is ACTUALLY running. `auto-deploy-hetzner` prints
`DID NOT DEPLOY - this run shipped nothing` and exits 0 on most runs, by design
(the restart windows are 6pm, 10pm, 4am, 10am, 2pm America/Chicago). A green
tick is not a deploy. This query is.

---

## PHASE 5 OF 6 - HUMAN-PATH E2E (start here)

**Nothing verified in phases 1 to 4 involved a human.** Measured again today:
94 live cash seats, **all 94 are horses**, zero humans seated. Horses have no
browser, so everything proven so far is the SERVER path.

Unexercised because there have been no humans:

- client rendering and the auth/session handoff from World Hub
- the cashier and deposit UI
- seat reservation and the 60-second hold countdown (both halves ARE shipped -
  `WaitlistBanner.tsx`, `GlobalWaitlistListener.tsx`, and the `SEAT_RESERVED`
  guard in `atomic_table_buyin` - but no human has ever raced one)
- mobile at 375px
- animation timing on real hardware
- **insurance purchase**: offered 596 times in its life, bought 3 times, last on
  2026-08-29. The offer path runs constantly; the purchase and settlement path
  is all but unproven.
- **rabbit hunt**: zero offers and zero reveals, ever. Player-initiated, so this
  is not a defect, but it means the charge path (`fn_consume_rabbit_hunt`) has
  never run in production.

**Test account:** `daniel@bekavactrading.com`, password in `.env.local` as
`TEST_USER_PASSWORD` (never commit it). Production:
`https://smarter.poker/hub/club-arena/`. Use the built-in browser or
Claude-in-Chrome; the Playwright MCP is flaky.

**Do the money paths inside the test account only, and never DELETE a
`table_seats` row to clean up** (CLAUDE.md 11.5). Leaving a cash seat refunds
through the Hetzner engine cash-out, NOT through `fn_leave_seat_and_refund`,
which is tournament-only and will silently refund nothing.

---

## PHASE 6 OF 6 - STORAGE / COST + DEAD SCHEMA

Unchanged from the previous handoff, plus two new candidates found today:

- `rabbit_hunt_offers` and `rabbit_hunt_reveals` have **zero rows, ever**, and
  `sp-prune-rabbit-hunt-offers` runs every 30 minutes to prune them. The engine
  keeps its offers in memory (`ServerTableEngineBase.rabbitHuntOffers`), so
  those tables may be vestigial. Confirm before dropping.
- `solved_spots_gold` is still 80 GB of a 106 GB database; `data_audit_log` is
  3 GB with `seq_scan = 0` and `idx_scan = 0`.

---

## OPEN, NOT MINE, AND WORTH SOMEONE'S ATTENTION

Three tournament-side money alarms were firing while this was written:
`Tournament.winner_prize_credit_failed` (36 in 48h, last 11:11 UTC),
`Tournament.prize_credit_failed` (41), `fn_detect_results_without_a_hand` (4,
last 12:20 UTC). Another agent holds tournament liveness - see
`docs/changelog/2026-09-01-phase4-liveness.md`, a different phase plan from this
one. Do not assume this audit covered them. It did not.

One house rule needs Dan, not an agent: the `no_rathole` buy-in floor in
`atomic_table_buyin` has **no time window**. It reads the player's most recent
exit from that table however long ago that was, so someone who left three weeks
ago with 900 must still return with 900. Live rooms bound this to the session.
It is one `AND ts.left_at > now() - <window>` if he wants it bounded. It is
dormant either way: `no_rathole` is set on 1 of 976 cash tables.
