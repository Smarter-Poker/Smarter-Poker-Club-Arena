# Bad Beat Jackpot: runbook

How the jackpot works end to end, where its money is, what each alarm means,
and how to put a payout right by hand. Written from the 2026-09-04 audit;
kept current by every phase of `docs/BBJ-BUILD-PLAN.md`.

## The path, in order

1. **Collection.** Every cash hand that sees a flop with 3+ dealt in pays the
   tier's BBJ drop (`bbjFeeBB`, RakeConfig data). `logBBJCollection` banks it
   into the club's pool, or the UNION pool if the club is in a union
   (`bbj_pools`: `main_balance` / `backup_balance` / `promo_balance` per
   `BBJ_POOL_ALLOCATION`). A failed banking call is queued in
   `pending_fee_distributions` (`kind = bbj_contribution`) and re-driven every
   5 minutes by `FeeReconciler.reconcilePendingFees`.
2. **Detection** (`detectBBJHit`, `server/src/config/RakeConfig.ts`) runs at
   showdown on board one. Rules per variant are in `BBJ_QUALIFYING_HANDS`;
   `BBJ_RULES` holds the gates (3+ dealt, pot > 10 BB, no double board, first
   runout). Hold'em: AAAJJ+ with an Ace in hand must lose to quads+, and BOTH
   hole cards must play for loser and winner. On a hit the engine emits
   `bbj_hit` to the table and stores the hit for settlement.
3. **Payout** (`processBBJPayout` -> `bbj_atomic_payout_v2`). One transaction:
   locks the pool, computes total = tier percent of main (main only, never the
   reserve), 50% to the bad-beat holder, 25% to the hand winner, 25% split
   across everyone else dealt in; credits seated recipients on
   `table_seats.stack` and departed ones on the club wallet of the club the
   seat was bought in from (`bbj_credit_one_recipient`); writes
   `bbj_payouts`, `bbj_payout_recipients`, `bbj_winners`; reseeds main from
   backup if main hit zero. Idempotent on (pool, table, hand): a replay returns
   `already_paid` and re-drives any missing credit.
   The engine retries transient failures four times; if all fail the full
   parameter set is queued (`pending_fee_distributions`, `kind = bbj_payout`)
   and a CRITICAL `financial_alerts` row is raised carrying every parameter.
4. **Announcement.** `bbj_payout_complete` to the hitting table (ten-second
   `BBJCelebration`, seat floats, stacks); `bbj_hit_global` fanned out over the
   engine socket to every live cash table in the club or union
   (`liveCashTableIdsInClubs`); the Realtime `bbj_pools` update is the fallback.
   The client draws the club-wide card once, from `BBJHitAnnouncer` in
   `PersistentTableLayer`, gated by `shouldAnnounceBbjHit` (fresh on the
   engine's clock, never twice per session). Every recipient gets a
   `notifications` row saying what they won and where it landed.
5. **Record.** Previous Winners reads `fn_bbj_recent_hits` (ledger-backed,
   cursor paged). The lobby ticker reads `bbj_winners` (world-readable, like
   `bbj_pools`).

## Where the money is

| Pool           | Column                     | Rule                                                                                                                                     |
| -------------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Main jackpot   | `bbj_pools.main_balance`   | The only payout source.                                                                                                                  |
| Backup reserve | `bbj_pools.backup_balance` | Never paid to a player. Reseeds main only when main reaches zero (which the 85% top tier cannot do). Phase 6 makes it the Mini BBJ bank. |
| Promo          | `bbj_pools.promo_balance`  | Promo rain (`fn_bbj_promo_rain`).                                                                                                        |

Conservation: `fn_bbj_conservation_check()` (epoch-based; `healthy` is the
figure that matters), `fn_bbj_promo_bank_check()`, `fn_bbj_orphaned_payouts()`.

## The alarms

| Source                                                        | Meaning                                                                          | Action                                                                                            |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `processBBJPayout.exhausted` (critical)                       | A detected hit could not be paid after four attempts. Queued for the reconciler. | Watch the next 5-minute cycle. If the queue row exhausts (25 attempts), re-drive by hand (below). |
| `FeeReconciler.exhausted` with `kind = bbj_payout` (critical) | The reconciler gave up on a queued payout.                                       | Re-drive by hand.                                                                                 |
| `FeeReconciler.bbj_unlinkable` (warning, one open row)        | Rake rows with no hand_id; their BBJ drop cannot be reconciled.                  | Rising figures mean `logHandHistory` is failing. Steady small figures are history.                |
| `FeeReconciler.bbj_drift` (warning, one open row)             | Booked drop and banked drop disagree over the window.                            | `fn_bbj_repair_unbanked` self-heals; a persistent gap is a lost-write bug.                        |
| `bbj-reserve-empty` incident                                  | A 100% hit emptied main and the reserve was empty.                               | Fund the pool (`fn_union_fund_bbj_pool`) or accept the restart.                                   |

## Re-driving a payout by hand

Only with the parameters from the alert or the queue row, and only after
reading `bbj_payouts` for that (table, hand): if a row exists, the payout
landed and the RPC will say `already_paid`. Seated = the players still in
their chairs NOW.

```sql
SELECT * FROM bbj_atomic_payout_v2(
  '<pool_id>', '<table_id>', <hand_number>, <payout_total_percent>,
  '<loser_user_id>', '<winner_user_id>',
  ARRAY[...dealt_in_ids]::uuid[], ARRAY[...seated_now]::uuid[],
  '{"winner_hand_name":"<loser hand>","loser_hand_name":"<winner hand>","status":"completed"}'::jsonb);
```

(The name inversion is deliberate and consistent throughout: the player who
LOST the hand WINS the jackpot.) Probe it inside a transaction you roll back
first (CLAUDE.md 11.5), read the recipient rows, then run it for real. Resolve
the alert with a `resolution` note naming who was paid what.

## Probing without spending

`BEGIN; ... SELECT * FROM bbj_atomic_payout_v2(...); SELECT ... ; ROLLBACK;` is
the pattern used in the audit. Use a real table with real seats, a hand number
that does not exist (999999999), and read back seat deltas, wallet deltas,
`bbj_payout_recipients` and the pool debit before rolling back. Never DELETE a
seat row to clean up.

---

# THE JACKPOT DRILL (BBJ phase 4.1, 2026-09-07)

A Bad Beat Jackpot fires about once a fortnight. The drill lets an operator
watch the whole path in minutes instead: the celebration on the felt, the
pop-up at every sibling table, the card in the lobby, the ticker, Previous
Winners, the notifications, and real chips landing in real stacks.

**It arms a TABLE, never a deck.** The engine cannot choose anybody's cards and
nothing here changes that. What the drill injects is the VERDICT: the next
showdown at an armed table is treated as a qualifying hit, using the real
players, the real board and the real pot. Everything after that runs for real,
because it is real - which is why the drill pays actual chips and why it is
fenced the way it is.

## Before the first drill: the drill club

There is deliberately **no armable table on the platform today**, and that is
the fence working rather than a gap. `fn_bbj_arm_drill` refuses:

| refusal                              | why                                                                                                       |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| `union_pool_is_never_a_drill_target` | the union pool holds the real jackpot (107,765.76 as this was written), shared by every club in the union |
| `pool_above_drill_ceiling`           | over 1,000.00. Deep Stack Society's own pool is 24,281.22                                                 |
| `pool_is_empty_nothing_to_pay`       | a pool with nothing in it cannot demonstrate a payout                                                     |
| `already_armed`                      | one live arm per table, enforced by a partial unique index                                                |
| `not_platform_admin`                 | `fn_is_platform_admin()`                                                                                  |
| `unknown_drill_kind`                 | `p_kind` is neither `main` nor `mini`                                                                     |

A **mini** arm (`p_kind => 'mini'`) is refused for four more reasons, and every
one of them is a question `fn_bbj_mini_payout` would have asked afterwards. The
arm asks them FIRST so an arm cannot fire into a refusal - burning the one arm
you get and paying nothing:

| refusal                                   | why                                                                                    |
| ----------------------------------------- | -------------------------------------------------------------------------------------- |
| `variant_is_not_eligible_for_the_jackpot` | PLO6 and Short Deck are not in `bbj_qualifying_hands` as eligible, so they get no mini |
| `mini_is_off_for_this_pool`               | `bbj_pools.mini_enabled` is false                                                      |
| `mini_disabled_for_this_tier`             | this table's stakes tier is switched off in `bbj_mini_tiers`                           |
| `no_stakes_tier_for_this_big_blind`       | the table's big blind falls outside every row of `bbj_stakes_tiers`                    |
| `reserve_cannot_cover_a_mini_payout`      | backup minus the **parked** reserve minus this tier's amount would break the floor     |

Note what a mini arm does NOT check: the 1,000.00 ceiling. That ceiling exists
so a MAIN drill cannot pay a large share of a pool; a mini pays a flat tier
amount (250 to 1,500) that the tier table already bounds. So a pool whose main
balance is far above the ceiling can still be drilled for a mini - which is
usually the only way to drill anything on a club that has been running a while.

So a drill needs its own club with its own small pool. That is a one-time
setup and it is Dan's to approve, because it funds a pool:

1. Create a club (any name - "Drill Room" reads well in an alert), NOT attached
   to a union. A club in a union banks into the union pool and can never be
   armed.
2. Seed its pool with a few hundred chips through the platform's own funding
   path - never a hand-written balance.
3. Sit two accounts at one of its cash tables. Horses are fine and are treated
   identically (CLAUDE.md 10.5); two seats and a showdown is all the drill
   needs.

At the 1,000.00 ceiling the largest possible drill payout is about 850 - the
same order as the smallest real jackpot ever paid here (654.14), clearly
visible against a median member balance of 10,216, and 0.8% of the production
pool.

## Arming

As a platform admin:

```sql
-- the MAIN jackpot: a share of the pool
select public.fn_bbj_arm_drill('<table uuid>', 'phase 4 drill');

-- the MINI jackpot: this table's flat tier amount out of the backup reserve
select public.fn_bbj_arm_drill('<table uuid>', 'mini drill', 'mini');
```

`p_kind` defaults to `'main'`, so the two-argument call above means exactly
what it has always meant.

`{"ok": true, ...}` means the next showdown at that table is the drill. The
answer names the `bank` it is armed against (`main` or `backup`), the `balance`
of THAT bank, the `kind`, and for a mini the `tierId` it will pay. Anything
else is a refusal and says which one. An `info` row lands in `financial_alerts`
saying in words that a drill is armed and that the chips are real.

Check what is armed at any time:

```sql
select * from public.fn_bbj_drill_arms();
```

`kind` tells a mini arm from a main one, and `pool_balance_at_arm` is the
balance of the bank that arm was armed against - the main pool for a main arm,
the backup reserve for a mini.

## What to watch, and what each surface proves

Have four tables open at 375px, at least one of them a SIBLING table in the
same club, and the lobby in another tab.

| #   | surface                         | expect                                                           | what it proves                                                                                                   |
| --- | ------------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 1   | the drill table                 | the jackpot celebration, after the showdown finishes             | the engine emitted `bbj_hit` and then `bbj_payout_complete`, and the client's replay gate let a live hit through |
| 2   | a sibling table                 | the club-wide card, once                                         | the engine's socket fan-out reached tables it is not settling (phase 1)                                          |
| 3   | the lobby tab                   | the same card                                                    | the `bbj_winners` INSERT reached a player with no table socket (phase 3.1) - the half that had never worked      |
| 4   | the felt masthead               | "Playing For $X" drops to the reset pool                         | the shared ten-second poll is live (phase 3.2)                                                                   |
| 5   | the ticker                      | the new hit at the top                                           | the `bbj_winners` INSERT binding survived the publication change                                                 |
| 6   | Previous Winners                | the hand, with arena names                                       | `fn_bbj_recent_hits` and the phase-1 name fix                                                                    |
| 7   | every recipient's notifications | one row each, saying the amount and where it went                | phase 1.1 - "every recipient is told", including any who had left the table                                      |
| 8   | wallets and stacks              | seated players' stacks up; a departed recipient's club wallet up | the payout RPC placed chips where each recipient actually is                                                     |

## Afterwards, in one query

```sql
select a.fired_at, a.fired_hand_number, p.total_amount,
       (select count(*) from public.bbj_payout_recipients r where r.payout_id = p.id) as recipients,
       (select count(*) from public.notifications n
         where n.metadata->>'handNumber' = a.fired_hand_number::text) as notifications,
       (select count(*) from public.bbj_unclaimed_shares u where u.paid_at is null) as parked
  from public.bbj_drill_arms a
  left join public.bbj_payouts p
    on p.table_id = a.table_id and p.hand_number = a.fired_hand_number
 order by a.armed_at desc limit 1;
```

`recipients` should equal everyone dealt in, `notifications` should equal
`recipients`, and `parked` should be 0. A parked share is not a failure - it
means a recipient had no club wallet and their share is held for them
(phase 2.3) - but on a drill club it means the club's membership is wrong.

## Telling a drill from a jackpot, later

`poker_bbj_drills_fired_total` is counted separately from
`poker_bbj_hits_detected_total`, so **detected minus drills** is the number of
genuine bad beats this platform has ruled.

The mini has its own pair, and the subtraction must be done WITHIN a family:

    genuine main bad beats = poker_bbj_hits_detected_total      - poker_bbj_drills_fired_total
    genuine minis          = poker_bbj_mini_hits_detected_total - poker_bbj_mini_drills_fired_total

Never across one. The first cut of the mini drill incremented the MAIN's
`drills_fired` while incrementing the MINI's `hits_detected`, which made the
first line under-count by one per mini drill and go negative in any window
where minis were drilled and no main jackpot hit. Both the arming and the firing leave
a `financial_alerts` row, and `bbj_drill_arms` records who armed it, when, and
which hand consumed it. A drill is a real jackpot at a drill club - the history
is true - and these are how anyone reading it later knows why it happened.

## Why no drill has been run yet, measured 2026-09-07

Two blockers, both real, both Dan's to clear. Probed against production inside a
transaction that was rolled back, so this is read rather than assumed.

**1. Arming is admin-only and cannot be done from an agent's connection.**
`fn_bbj_arm_drill` was called for every active pool over a service connection
and returned, for each one:

```
{"ok": false, "reason": "not_platform_admin"}
```

That is the function working exactly as designed - `auth.uid()` is null on a
service connection, so there is no admin to be. It also means an agent cannot
arm a drill on Dan's behalf, and must not try: CLAUDE.md 10.84 forbids an agent
signing in as anybody. **A drill is armed by Dan, signed in, from the admin
surface.** Nothing else can do it.

**2. There is no pool that is both armable and payable.** The arm refuses a
union pool outright and any pool over the 1,000.00 ceiling; the payout refuses a
pool whose main balance is zero. Measured the same day:

| pool                                          | main       | arm               | payout                       |
| --------------------------------------------- | ---------- | ----------------- | ---------------------------- |
| `9b73034b` Midway Union, 104 cash tables      | 0.00       | under the ceiling | refused, `main_balance <= 0` |
| `a7a65cfc` Deep Stack Society, 76 cash tables | 25,853.88  | over the ceiling  | fine                         |
| `f9806a7f` the union pool                     | 108,963.08 | refused, union    | fine                         |

So a drill armed today would prove the detection and the event path and then
correctly refuse to pay, which reads like a failure and proves half of what the
drill exists for.

**What unblocks it**, and both are Dan's because both set what a pool holds:

- fund `9b73034b` with a small amount - a few hundred is enough, and its 104
  cash tables mean a qualifying hand arrives quickly - via
  `fn_union_fund_bbj_pool`; or
- raise the 1,000.00 ceiling in `fn_bbj_arm_drill` so an existing club pool
  qualifies, accepting that a drill there pays a real percentage of a real
  jackpot to real players.

An agent may not do either: moving chips into a pool to make a test possible is
spending money on a test, not correcting a defect, so 10.9's grant does not
cover it.
