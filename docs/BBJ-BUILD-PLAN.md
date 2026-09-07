# Bad Beat Jackpot: build plan

Dan, 2026-09-04: "TAKE EVERYTHING YOU JUST SUGGESTED, AND CREATE COMPREHENSIVE
BUILD PLAN AND BREAK IT DOWN INTO PHASES. DO ONE PHASE AT A TIME, AND INSURE
THAT EACH ONE IS FULLY BUILT OUT, CODED AND WIRED IN, AND THAT EVERYTHING WAS
PUBLISHED BEFORE CLAIMING SUCCESS." And: "stop after each phase for a status
update."

This file is the plan of record. One phase is one pull request. A phase is
complete when its PR has merged, the bundle is serving from
`https://smarter.poker/hub/club-arena/build-info.json` (`ca_sha` = the squash
commit) and the engine has restarted on it (a hand-count dip in `hand_history`
after the :55 gate), and Dan has been told. The next phase does not start until
Dan says so.

Everything here follows the 2026-09-04 audit
(`docs/changelog/2026-09-05-bbj-full-audit.md`, PR #3045), which fixed the
defects that stopped a jackpot paying or announcing at all. The phases below
are what makes the feature complete, provable, and safe to grow.

Rules that bind every phase: CLAUDE.md 10.5 (horses are players: every payout,
notification and count treats a horse exactly as a human), 10.6 (animations
always play), 10.9 (money decisions are the agent's when the path is clear and
proven in a rolled-back transaction), 11.5 (never spend real chips to test),
and the production DDL policy (one migration, one transaction).

---

## Phase 1 of 6 - The record and the moment

The player always has a record of what they won, and the moment is never lost
to a bad socket or a wrong clock.

| #   | Item                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Where                                                       |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| 1.1 | Every recipient is notified, seated or not, saying what they won and where it landed ("added to your stack at the table" / "credited to your wallet"). Decided AGAINST a `chip_transactions` row for a seat credit: `fn_my_wallet_ledger` sums every row to a player as wallet-in, so a felt credit journalled there double-counts on cash-out; pot wins are not journalled to the wallet either.                                                                                                                                                                                                             | `server/src/services/supabase/bbj.ts`                       |
| 1.2 | `bbj_hit`, `bbj_payout_complete`, `bbj_hit_global` carry `replay_until` (60 s, the hub's ceiling) so a socket that reconnects after the event still receives it. The identity gate on the client already refuses a replay it has seen.                                                                                                                                                                                                                                                                                                                                                                        | `ServerTableEngineSettlement.ts`                            |
| 1.3 | Every EVENT frame carries the engine's clock (`ts`); the client keeps the offset (`src/utils/serverClock.ts`) and the freshness gate compares engine-to-engine. A phone running two minutes fast can no longer silently refuse every celebration. Phase 1 shipped this as `src/lib/serverClock.ts`; PR #3227 found that the app then had TWO `serverNow()` with opposite signs, folded them into the canonical `utils` one (latency-corrected, and it inherited this phase's EVENT + PING feed), and pinned the result with `tests/there-is-one-server-clock.law.test.ts`. Semantics unchanged, path changed. | `TableStateHub.ts`, `EngineStateClient.ts`, `bbjHitOnce.ts` |
| 1.4 | `fn_bbj_recent_hits` names players by `fn_arena_name` (was `display_name` first: a real name on 30 profiles).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | migration `20260905015127`                                  |
| 1.5 | `bbj_unlinkable` / `bbj_drift` become one open alert row per condition, refreshed while true, resolved with a note when it clears (was one new row per hour).                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `FeeReconciler.raiseOrRefreshCondition`                     |
| 1.6 | This plan and `docs/BBJ-RUNBOOK.md`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | docs                                                        |

Tests: `BBJPayoutIsPaidOrQueued` (17), `BBJEventsSurviveAReconnect` (6),
`AConditionIsOneAlert` (6), `tests/unit/serverClock.test.ts` (7),
`TheJackpotQueueWriterIsRegisteredAtBoot` (4).

The last one came out of the phase-1 verification sweep (2026-09-06) and is
about WIRING rather than logic. `processBBJPayout` queues an unpayable jackpot
through a writer that `FeeReconciler` installs with a module-scope side
effect, and every other test installs its own stub writer - so all of them
passed with the real registration deleted. Drop the import chain into
FeeReconciler and a detected-but-unpayable jackpot would leave no durable
record at all, only an alert. Verified by mutation: commenting the
registration out turns two of its pins red.

Known and deliberately NOT in this phase: the felt names a horse by
`display_name` ("RakeGhost") while `fn_arena_name` gives its `alias`
("RunnerFox44"), so the celebration at the table and the BBJ page can still
disagree on a horse's name. That is a platform naming question (engine
`loadSeatedPlayers`), not a jackpot one; recorded for the naming law's owner.

## Phase 2 of 6 - A hit is never lost **[SHIPPED 2026-09-06]**

Record: `docs/changelog/2026-09-06-bbj-phase-2-a-hit-is-never-lost.md`.
Migration `20260906152329_an_unpayable_jackpot_share_is_parked_not_lost`
applied. 2.6 (the post-deploy drain proof) is the one item that can only be
done after the merge is live; it is run and recorded there.

| #   | Item                                                                                                                                                                                                            |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2.1 | Write-ahead: the `bbj_payout` queue row is inserted BEFORE the first RPC attempt and resolved on success, so a hard crash between detection and payout is recovered by the reconciler.                          |
| 2.2 | `bbj_payout_pending` when a payout is queued (a hit during the :55 freeze is announced at the table: "Jackpot hit, paying after the break") and `bbj_payout_paid` when the drain lands it. Client handles both. |
| 2.3 | One unresolvable wallet parks its share (`bbj_unclaimed_shares` + alert + reconciler re-drive) instead of failing the whole payout.                                                                             |
| 2.4 | Metrics: jackpots detected / paid / queued / re-driven.                                                                                                                                                         |
| 2.5 | Settlement-level integration test: a showdown through `bbj_payout` with a mocked RPC, asserting all three hub events and the queue behaviour.                                                                   |
| 2.6 | Post-deploy proof: seed one `bbj_payout` row for an already-paid hand and confirm the reconciler resolves it via `already_paid` with no chip moved.                                                             |

## Phase 3 of 6 - Everyone hears it

| #   | Item                                                                                                                                                                                                                                         |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 3.1 | Lobby pop-up: ClubHomePage subscribes to the `bbj_winners` INSERT (readable since #3045) and emits `BBJ_HIT_GLOBAL`. The same subscription replaces TablePage's hit_count-baseline detection.                                                |
| 3.2 | `bbj_pools` leaves the Realtime publication (63k updates/day decoded for every subscriber through a stream a minute behind at peak); the balance rides the engine snapshot and a 10 s poll of `fn_bbj_pool_for_club` for non-table surfaces. |

> **3.2 is in two halves and the second one is GATED. Read this before you drop
> the table from the publication.** The client half is done and live in both
> repos: Club Arena PR #3385 (six subscriptions replaced by one shared
> ten-second poll, `src/lib/bbjPoolFeed.ts`) and World Hub PR #1516 (three
> more, all of which were ALSO reading the dead `pool_amount` column and so
> reporting the jackpot as $0.00 while the union pool held 107,092.27).
>
> There were **nine** subscribers, not the six the audit found - the World Hub
> was never searched until 2026-09-06. Dropping `bbj_pools` from the
> publication before BOTH bundles are live in players' browsers freezes the
> figure on every stale tab with nothing to say why.
>
> So the migration lands only when: Club Arena's bundle carries #3385 (done -
> `ca_sha b0a646b8bc`, published 23:45 UTC) AND the World Hub's Vercel deploy
> carries #1516 (pending). Verify both, then drop it, then confirm with
> `select 1 from pg_publication_tables where pubname='supabase_realtime' and
tablename='bbj_pools'` returning nothing.
> | 3.3 | "Playing for $X" on the felt masthead. |
> | 3.4 | Push notification when the jackpot crosses a threshold (club setting). |
> | 3.5 | World Hub jackpot tile (separate repo, its own PR, last in the phase). |

## Phase 4 of 6 - Prove it live

| #   | Item                                                                                                                                                                |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 4.1 | Staff-only rigged deck on a flagged private test table (platform admin + test club flag, test chips), so the whole path can be watched in minutes instead of weeks. |
| 4.2 | Run the drill on real hardware at 375 px with four tables open: celebration, sibling pop-up, ticker, Previous Winners, wallets, notifications.                      |
| 4.3 | Fix everything the drill shows.                                                                                                                                     |

## Phase 5 of 6 - Close the books

| #   | Item                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 5.1 | Audit the admin money controls the way the hit path was audited: `fn_union_fund_bbj_pool`, `fn_bbj_move_between_banks`, promo rain, the owner's `bbj_percent` switch, `BBJAdminAnalytics`, `fn_resolve_bbj_pool`, `record_rake`.                                                                                                                                                                                                                                                                           |
| 5.2 | Convert the three SECURITY INVOKER writers (`record_rake`, `fn_resolve_bbj_pool`, `fn_union_fund_bbj_pool`) so INSERT/UPDATE/DELETE can be revoked from `anon` and `authenticated` on every `bbj_*` table.                                                                                                                                                                                                                                                                                                 |
| 5.3 | Resolve the promo-bank drift (`fn_bbj_promo_bank_check`, 6,705 chips) and the lifetime conservation gap (70,795 above baseline) with a fix or a written resolution on the alert row.                                                                                                                                                                                                                                                                                                                       |
| 5.4 | Table-share farming check in the multi-account detector.                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 5.5 | `I7_raked_hand_never_banked`: rake is not banked inline and `rake-repair-unbanked-hourly` catches it every hour, which by CLAUDE.md 10.11 means the cause is not fixed. Measured 2026-09-06: 0 of 51,733 raked hands (62,498.69 chips) unbanked NOW, so no money is missing - but `fn_rake_bbj_audit` raised CRITICAL on 5 hands at 07:38 and 3 at 06:38 that the repair then fixed. Fix the cause; then give the audit a grace that outlasts the repair, so a CRITICAL stops firing on correct behaviour. |

## Phase 6 of 6 - Mini BBJ, funded by the backup reserve (last, per Dan)

Design first, for Dan's sign-off, because it sets future payouts (CLAUDE.md
10.9: what the next event owes is his): a flat amount per stakes tier, a custom
formula, and separate qualifying hands for hold'em and PLO. Then the mini bank
per tier fed from `backup_balance`, the second detection tier in `detectBBJHit`,
the payout RPC, the celebration variant, the ticker and the page.

## Open decision (Dan's)

Whether the main jackpot rules stay this strict (Ace in hand, both cards play
for both players, quads-or-better winner). At current volume that is roughly
one hit every few weeks against a $104k pool.
