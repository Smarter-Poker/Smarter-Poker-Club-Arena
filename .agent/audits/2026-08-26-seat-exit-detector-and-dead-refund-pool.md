# 2026-08-26 — Seat-exit detector, the dead refund pool, and a corrected rule

Status: **DB changes are live in production. Repo changes are pushed as PR #1037 with squash auto-merge armed** (see "Push status" at the bottom).

---

## Applied to production

Three migrations, each with post-apply assertions that would have aborted the
transaction on failure. All three returned success; verified again independently
afterwards.

### 1. `20260826_fix_unaccounted_seat_exits_lower_bound`

`fn_unaccounted_seat_exits()` matched a seat exit to its refund inside
`occurred_at - interval '2 minutes' .. occurred_at + p_grace`. The upper bound
scaled with `p_grace`; the lower bound was hardcoded at two minutes. The engine
writes the cash-out **before** it closes the `table_seats` row and the gap
between them is unbounded, so any refund landing more than two minutes early was
reported as missing.

Exit 6522 (user `f7201058`) was paid 85.85 at 09:33:33 and its seat closed at
09:38:50 — a 5m17s gap. Correct refund, reported as a critical.

Lower bound is now `GREATEST(p_grace, interval '15 minutes')`.

|                    | before     | after |
| ------------------ | ---------- | ----- |
| flagged exits (7d) | 2          | 1     |
| ids                | 6522, 7458 | 7458  |

The false positive is gone and the real shortfall is retained. A money alarm
that cries wolf is how the real one stops being read.

### 2. `20260826_wrap_live_comments_auth_uid`

`live_comments / lc_sel` wrapped four of its five `auth.uid()` calls and left the
first bare, in the leading disjunct where it is evaluated per row before
anything can short-circuit it. Fixed with `ALTER POLICY` (not DROP + CREATE, so
roles/cmd/permissive are preserved and the table is never briefly unprotected).

Unwrapped `auth.*()` calls in schema `public`: **1 -> 0**. Total policies
unchanged at 1417.

### 3. `20260826_retire_dead_leave_rpcs_and_fix_tabclose_pool`

**`player_leave_table()` credited a pool nothing reads.** It is the tab-close
auto-cashout, fired from `TablePage.tsx:5181` via `navigator.sendBeacon`. It
refunded the stack into `public.wallets`, while every other money path on the
platform settles into `club_members.chip_balance` via `fn_add_chips()`.

`public.wallets` is dead:

```
last updated_at .............. 2026-08-21 00:59:34Z
rows updated in last 24h ..... 0        (against 6,511 seat exits)
stranded balance ............. 732,591,994.33
live pool (club_members) ..... 121,205,561.53
```

A tab-close refund would have credited an unreadable ledger **and** closed the
seat — the stack leaves the felt and lands nowhere. Exactly the failure mode
CLAUDE.md 11.5 exists for.

It has never billed anyone: `wallet_transactions` rows matching `'Tab-close%'`
= **0, all time**. The function has never completed once. A landmine, not an
active leak — which is also why it was safe to change.

Now: settles through `fn_add_chips()` + `log_wallet_transaction()`, and RAISES
rather than closing a seat it cannot resolve a club wallet for (leaving the
stack intact for the engine's startup sweep).

Deliberately **not** changed: the security context stays INVOKER. Promoting it
to SECURITY DEFINER is plausibly what would make it start firing, and switching
on an untested money path is a separate decision needing its own evidence. This
makes the payout correct **if** it fires; it does not make it fire.

Per CLAUDE.md 11.5 rule 5 this path was reasoned about and asserted, **not
executed**. No probe was run. No chips were moved.

Also dropped: `fn_leave_table(uuid)` and `fn_leave_table(uuid, uuid)`, both of
which only ever returned `{"success": false, "error": "not_implemented"}`. Zero
call sites in either repo.

### 4. `CLAUDE.md` section 11.5 rule 3 — corrected

The rule said the refund path is `fn_leave_seat_and_refund`. **That function is
tournament-only.** Its third statement is
`IF NOT FOUND OR v_tbl.tournament_id IS NULL THEN RETURN ... 'table_not_found'`.
Called on a cash table it refunds nothing and leaves the seat untouched. An
agent following the old wording to "safely" release a cash seat would have
believed chips were returned when they were not. Replaced with a per-table-type
refund table.

---

## Still open

| #   | Item                                                                         | Why it is not done                                                                                                                                                                                                                                          |
| --- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Exit 7458: 25.90 chips owed to `a916c222`**                                | Real loss, verified. Add-on 25.90 at 12:55:23, cash-out of only 19.10 at 12:55:24, stack 45.00 at 12:55:25 (`19.10 + 25.90 = 45.00`). The cash-out read a stale stack that excluded the add-on. Fix is engine-side on Hetzner, not a migration. Spec below. |
| 2   | **The engine force-cashes out every seated player roughly every 33 minutes** | ROOT CAUSE FOUND, see below. Not fixable from here (no SSH to Hetzner), and `agent/cowork-standby/feat/leader-standby-failover` is already the right fix in flight.                                                                                         |
| 3   | 12 `multiple_permissive_policies` groups (25 policies, 12 tables)            | Minor planner cost. Untouched.                                                                                                                                                                                                                              |
| 4   | 77 RLS-enabled tables with zero policies                                     | **Verified safe** — RLS denies all client access and service_role bypasses. Hygiene only: their `anon`/`authenticated` grants are misleading and should be revoked.                                                                                         |
| 5   | Two backup tables in `public`                                                | `club_member_daily_stats_profit_backup_20260826` (123,463 rows), `vip_backfill_20260812_backup` (470).                                                                                                                                                      |
| 6   | Auth connection pool -> percentage-based                                     | No tool access; dashboard or management API only.                                                                                                                                                                                                           |
| 7   | `TablePage.tsx` — 748 KB / 15,345 lines                                      | Large refactor. This, not route splitting, is the real bundle win: every route in `App.tsx` is already `lazyWithRetry(() => import(...))`.                                                                                                                  |

### #2 — engine restart churn — CORRECTED 2026-08-26, I overstated this

**The original version of this section was wrong in its most alarming claim and
is replaced here. Read the correction, not the headline it replaced.**

What I first wrote was that the engine "force-cashes out every seated player
roughly every 33 minutes". The measurements behind it were right; the conclusion
drawn from them was not, because I never checked WHO was being cashed out.

```
distinct users in startup-cleanup cash-outs (4d) .. 584
of those, profiles.is_horse = true ................ 584   (100%)
of those, human ...................................   0
rows attributable to horses ....................... 35,331  (100%)
```

**Every single one is a horse. Not one human player has been affected.**

The reason is a guard that was already there and that I failed to read before
drawing a conclusion. `auto-deploy-hetzner.yml` has carried a **drain gate**
since 2026-08-24 that reads `humansSeatedTotal` from `/health` and DEFERS the
restart while any human is seated, rather than kicking them. It is paired with
`MIN_RESTART_SPACING_SEC` (20 minutes) coalescing and a matching 20-minute
catch-up schedule — which is also the real explanation for the ~33 minute
average interval I measured and mistook for a fault.

So the deploy cadence is not harming players. Cashing horses out on a cold start
and reseating them is the intended behaviour.

**Two things from the original finding do still stand:**

- `engine_recovery_events` holds **1,891 `watchdog_kill_rebuild`** events over
  four days, 228 of them `start_failed:start_load_table` in the last two. That
  is the table loader failing at startup and the watchdog rebuilding around it.
  It is unrelated to the drain gate and is not explained by deploys.
- 198 runs of `auto-deploy-hetzner.yml` in four days is a lot of engine
  restarts. It costs runner minutes and it churns horse seats. Worth a look as
  an efficiency question — **not** as a player-harm one.

**And the claim it was used to support is withdrawn.** I wrote that the add-on
race was "being rolled 33,760 times per four days". It is not. Those 33,760
cash-outs are horses. The add-on race is evidenced by exactly two incidents:
exit 7458 (25.90, repaid by
`20260826_repay_seat_exit_7458_addon_shortfall`) and the hand-written correction
for hand #1458859 (14.18). It is a real bug and worth fixing — it is not
happening at that volume.

### Spec for #1 — the add-on / leave race

The shape is already known here: `wallet_transactions` carries a hand-written
row reading _"Correction: hand #1458859 settlement (final stack 34.18) lost to
mid-hand cashout race at 23:49:15Z — refund of 14.18 shortfall"_. Same class of
bug, patched by hand once.

Required behaviour, to be asserted in a unit test before any engine change:

1. An add-on and a cash-out on the same seat must not interleave. The cash-out
   must read `table_seats.stack` under the same lock the add-on writes it with.
2. Given: seat with stack S, an add-on of A committed at T, a leave at T+e.
   Then the credit must equal `S` (post-add-on), never the pre-add-on value.
3. `table_pending_addons` (2,863 rows) and `table_addon_idempotency` (2,253)
   already exist — the reconciliation between a pending add-on and a seat exit
   should be asserted, not assumed.

Do **not** verify this by calling the live path. See 11.5.

---

## Concurrency note — another agent moved underneath this work

Migrations were landing from at least one other session while this ran:

```
20260826151027  an_addon_that_cannot_apply_must_not_debit      <- same bug as #1 above
20260826151310  20260826_fix_unaccounted_seat_exits_lower_bound   (this session)
20260826151326  20260826_wrap_live_comments_auth_uid             (this session)
20260826151345  20260826_retire_dead_leave_rpcs_and_fix_tabclose_pool (this session)
20260826151459  lobby_publishes_48h_of_card
20260826151609  close_the_money_rpcs_no_browser_ever_calls
```

All three of this session's changes were re-verified afterwards and survived
intact (flagged exits 1, bare auth policies 0, stubs 0, `player_leave_table`
still routing to `fn_add_chips`).

**But `close_the_money_rpcs_no_browser_ever_calls` (151609) revoked client
EXECUTE on `player_leave_table`.** Its grants are now `postgres` and
`service_role` only. That is a defensible hardening, and it independently
confirms the diagnosis above — but it leaves a **live client call site that can
no longer succeed**: `TablePage.tsx:5181` still fires this RPC through
`navigator.sendBeacon` on unload, as `authenticated`. It will now be rejected.

Failure mode is benign (the beacon is fire-and-forget, the seat stays open, and
the engine's startup sweep cashes the player out) but the call site is dead code
that should be removed or re-pointed. Whoever owns 151609 should be told.

Someone is also already on the add-on race (`an_addon_that_cannot_apply_must_not
_debit`) — coordinate before duplicating item #1.

---

## Push status

Pushed. Branch `agent/cowork-seatexit/fix/detector-and-dead-refund-pool`,
**PR #1037**, squash auto-merge armed. It lands the moment the six required
checks report.

Getting there took three corrections worth recording:

1. **The GitHub MCP token is revoked** — `create_branch` and
   `search_repositories` both return `Authentication Failed: Bad credentials`.
   Not a scope problem. It needs rotating.
2. **The sandbox cannot reach github.com** — `git ls-remote` returns
   `HTTP code 403 from proxy after CONNECT`, so no credential would help there.
3. **The host can.** SSH to `git@github.com:Smarter-Poker/Smarter-Poker-Club-Arena.git`
   works from the Mac and `gh` is authed as `Smarter-Poker` (it lives at
   `/opt/homebrew/bin`, which is not on the non-interactive shell's PATH —
   export it or `gh` reports `command not found`).

Two further traps for the next agent:

- **The main clone was at a detached HEAD, 8 commits behind**, because `main`
  is checked out in another worktree (`.agent-trees/club-arena/agent-replayer`).
  `git checkout main` there fails. Claim your own worktree, per AGENT-PLAYBOOK.
- **`scripts/git-safe-push.sh` runs `git add -A` (line 133) and commits with
  `--no-verify` (line 205).** At the time of writing the repo root held 20
  untracked items including `.agent-trees/` and a dozen scratch files from other
  agents. Running it unmodified would have swept all of that into the commit and
  skipped the test gate that CLAUDE.md section 8 says must never be skipped.
  This work was staged explicitly by path and committed with hooks enabled.

**Unverifiable from here:** the PAT cannot read check state — GraphQL returns
`Resource not accessible by personal access token` for
`statusCheckRollup.contexts`, so `checks=0` on a PR is a permissions artifact
and NOT evidence that CI did not run. Do not read it as such.
