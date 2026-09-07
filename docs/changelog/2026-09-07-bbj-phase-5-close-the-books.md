# BBJ phase 5 of 6 — close the books

2026-09-07. Branch `agent/cowork-bbj-audit/phase-5-close-the-books`.

Phase 5 is the accounting phase of the Bad Beat Jackpot programme: prove the
money adds up, shut the doors nobody should be able to open, and make every
signal on this surface say what it actually knows. Seven migrations, all
applied to production and all with their assertions passing.

The through-line, and it is the same sentence seven times: **a number reported
without its explanation is an alarm that gets muted.** Every item below is one
of those, and one of them was mine, made an hour earlier in this same phase.

---

## 5.1 / 5.2 — no browser role may write the jackpot

`20260907161706_no_browser_role_may_write_the_jackpot.sql`

INSERT / UPDATE / DELETE / TRUNCATE / REFERENCES / TRIGGER revoked from `anon`
and `authenticated` across ten `bbj_*` tables, with a general assertion that a
browser write grant is allowed only where a browser write POLICY exists behind
it.

The first attempt was refused by its own assertion, correctly:
`bbj_notify_thresholds` legitimately grants writes to `authenticated`, because
the phase-3.4 operator panel writes it under an admin policy. The rule was
restated rather than the exception carved out.

Verified after: every table reads `anon: SELECT / authenticated: SELECT`, except
`bbj_notify_thresholds` (`DELETE,INSERT,SELECT,UPDATE` for `authenticated`,
policy-backed) and `bbj_threshold_crossings` (`authenticated: SELECT`).

---

## 5.2 — the promo bank check can say "explained"

`20260907161937_the_promo_bank_check_can_say_explained.sql`

`fn_bbj_promo_bank_check` had been reporting `{"over_swept": 6705.21,
"reconciles": false}` into a warning alert, hourly. "Over-swept" on a money
surface reads as chips leaving a bank they never entered.

They did not. 49,714 contribution rows from 2026-03-03..07 carry NULL
main/backup/promo portions — the columns did not exist yet — so their promo
money is real and counts as zero on the "entered" side. At the rate the rows
that DO record a split actually show (25.4667%), that era carried 10,465.96 of
promo against a 6,705.21 gap: fully covered, with 3,760.75 of headroom, and in
the safe direction.

The portions are deliberately **not** backfilled. Inventing a split nobody
recorded is editing history (10.9). The check gained a third outcome instead —
`reconciles` / `explained_by_pre_triple_bank` / `unexplained` — and now returns
`reconciles: true, unexplained: 0`.

`financial_alerts` row `38c47b54` resolved with the full reasoning.

**And a correction to that.** Reviewing it later in the same phase, that row had
a resolution note and a `resolved_at` timestamp while `resolved` was still
`false` — handled to anyone reading it, open to anyone filtering on the flag —
and I had reported it as resolved on the strength of the note. Corrected, with
the correction written into the row.

---

## 5.3 — the lifetime gap is forty hits the payout table never saw

`20260907163403_the_lifetime_gap_is_forty_hits_the_payout_table_never_saw.sql`
`20260907163639_a_pre_ledger_bucket_must_not_be_able_to_grow.sql`

`fn_bbj_conservation_check` had reported a lifetime gap of 73,367.70 against a
2026-08-25 baseline of 2,572.59 — a drift of **70,795.11**, open and
investigated for thirteen days, with a `GLOBAL_SETTLEMENT_FREEZE` placed on all
three clubs for it and a baseline note saying that closing it meant "crediting
or writing off ~74k of real player money on an inference."

It is not an inference. Per pool, from rows, read twice four seconds apart under
live play with both reads identical:

| pool                    | contributions − payouts − sweeps − balances                            |
| ----------------------- | ---------------------------------------------------------------------- |
| `0867a7fd` retired club | 159,981.85 − 74,301.10 − 28,742.48 − 56,938.27 restored out = **0.00** |
| `a7a65cfc` active club  | 49,186.79 − 0.00 − 12,284.12 − 37,860.15 held = **−957.48**            |
| `f9806a7f` union        | **74,323.80**                                                          |

The retired club pool balances to the cent once its 56,938.27 restoration is
counted as its outflow. The whole gap is the union pool — and the union pool has
an answer:

```
bbj_contributions   first row  2026-03-03
bbj_payouts         first row  2026-07-22
```

The union pool has been paying jackpots since March. Its own counter says it has
paid 172,740.21; the payout table can see 100,990.90. The difference —
**71,749.31 across 40 hits** (`hit_count` 45, payout rows 5) — is four months of
real jackpots paid to real winners, recorded by the counter that was there and
by nothing the check reads. That is 10.9's own doctrine: prefer the witness that
was there.

Against it, 1,000.00 of opening seed sits in a bank with no inflow row and pulls
the other way.

```
drift from baseline                     70,795.11
less paid before the payout table     − 71,749.31
plus the opening seed                 +  1,000.00
─────────────────────────────────────────────────
UNEXPLAINED                                 45.80
```

**45.80.** Nine hundredths of one percent of the drift, on 474,414.68 of inflow
across 1.07 million contribution rows.

Nothing is credited, written off, or rebaselined — the baseline row says DO NOT
REBASELINE after an agent did exactly that on 08-31 and had to revert it, and
`gap` / `baseline_gap` / `drift_from_baseline` still read 73,367.70 / 2,572.59 /
70,795.11. The residue is _remembered_ in `lifetime_residue` against the row's
existing 1.00 tolerance, so it stays visible and stays owed an explanation.

### and the same trap one level up

The second migration exists because the first one left it. Read the arithmetic
of a _future_ payout that bumps `total_paid_out` and writes no row: gap rises,
`paid_before_the_payout_table` rises by the same amount, `unexplained` does not
move. The bucket built to explain a historical blind spot would have silently
absorbed a live one.

So the 71,749.31 is pinned as `pre_ledger_payouts`, and
`paid_without_a_payout_row_since` must be zero for `lifetime_healthy` to be
true. The epoch journal would also catch it as `unexplained_main`; two readers
for a money path is the right number.

Both `healthy` and `lifetime_healthy` are true for the first time since
2026-08-25.

---

## 5.4 — nothing can see table-share farming yet, and it says so

`20260907170551_nothing_can_see_table_share_farming_yet_and_it_says_so.sql`

Farming a table share means seating several accounts you control at one table so
a jackpot pays you several dealt-in shares of a fixed 25%. It does not enlarge
the pot; it enlarges your fraction at the honest players' expense.

Measured over the platform's entire history — 29 payouts, 131 distinct
recipients:

```
recipients who are horses                    131 of 131
recipients with any IP in action_audit_logs    0
```

`detect_multi_account_ips` groups `action_audit_logs` by IP. Every jackpot
recipient this platform has ever had is a horse; a horse has no browser, so no
IP, so no row. Join jackpot recipients to that detector and you get an empty set
— which reads exactly like a clean bill of health. It is not clean, it is
untested.

**Horses are players (10.5)**, so the answer is not a horse-shaped exception.
The device bond does not exist for a player with no device, and the day a human
is paid a table share is the day this check has something to say.

**The bond I built and rejected is the more useful finding.** The obvious
substitute is the agent graph — two recipients under one agent. Built, and its
own assertion aborted the migration: **20 of the 29 payouts flagged**. Of course
they were. A club has a handful of agents and hundreds of players, so two
players at a table sharing an agent is the ordinary shape of every club here.
Shipping it would have put a CRITICAL on two thirds of all jackpots — the exact
defect 5.5 spent the afternoon undoing. The agent count is reported as coverage
and never as a finding, and what would make it usable (a measured per-agent
table-occupancy baseline) is named in the function so nobody rediscovers it.

`fn_bbj_table_share_farming(p_days)` has four outcomes, and `clean` is
deliberately false when coverage is zero. It returns `cannot_tell` today, and
the migration asserts that, so the day the answer changes somebody reads it
rather than assuming.

---

## 5.5 — an alarm asks the healer whether it has had its chance

`20260907165636_an_alarm_asks_the_healer_whether_it_has_had_its_chance.sql`

`fn_rake_bbj_audit` raised **24 CRITICAL money alerts in seven days**. Every one
was `I7_raked_hand_never_banked` and nothing else. Every one was wrong.

Six hands were pulled from the two most recent alerts and followed. All six have
a `rake_records` row, source `atomic_distribute_rake`, banked at **:52:00** —
`rake-repair-unbanked-hourly` doing its job, 32 to 50 minutes after the hand.

The check gave that healer a fifteen-minute literal:

```sql
v_heal_grace timestamptz := now() - interval '15 minutes';
```

with a comment above it reading "must outlast the healers' own grace + a cycle,
or the alarm reports the net's patience as a failure." The comment is right and
the number is wrong. The audit runs at `:38`; its healer runs at `:52`. **Every
hand that failed to bank between the last repair and the audit's cutoff —
thirty-one minutes of every hour — was reported as a critical money violation
and banked fourteen minutes later.** The BBJ half of the same function never
fired once, because its healer runs every fifteen minutes and fits inside the
same constant: one grace, two healers, two cadences.

Fixed by asking rather than guessing. Each self-healing check now reads its own
healer's last successful completion out of `cron.job_run_details` and flags only
hands that healer has seen and failed to fix, minus ten minutes for the healer's
own five-minute skip plus margin. If `cron` cannot be read the grace falls back
to two hours and `grace_source` says `fallback` rather than claiming a precision
it does not have. And `rake-repair-unbanked-hourly` moves from `52 * * * *` to
`2,17,32,47 * * * *`, matching its BBJ sibling — worst case from 60 minutes to
15, with every run clear of the `:55`–`:00` freeze and of the `:38` audit.

Verified: both checks report `grace_source: cron`, graces of 16:35:02 and
16:42:01 from the healers' real last runs, zero violations.

### what this does not fix, and it is real

The false alarm is fixed at its cause. The thing it was falsely alarming _about_
is not.

Over 36 hours, **74 hands and 172.99 chips of rake** were banked by the repairer
rather than by the engine — about 49 hands and 115 chips a day. For every one,
`hand_history` was written and then nothing: no `rake_records`, no
`bbj_contributions`, no `pending_fee_distributions` claim. The engine does not
fail the rake step, it never reaches it.

No chips are destroyed. What is destroyed is the attribution:
`fn_rake_repair_unbanked` calls `atomic_distribute_rake` with `p_contributions
=> NULL` because nothing on disk holds the eligible-contribution map once the
engine is gone, and all six sampled hands have zero `rake_attributions` rows. So
roughly 115 chips of rake basis a day earns nobody VIP points, agent commission
or rakeback.

It is not invented here (10.9 test 1). Two candidate fixes, both with a real
cost, recorded in the migration header and **for Dan**:

- **(a)** write-ahead the `pending_fee_distributions` claim before the first
  attempt, as phase 2.1 already does for jackpot payouts. Complete fix. Costs
  ~103,000 extra round trips a day on 51,733 raked hands, on an engine that is
  one core — the same trade phase 4.1 refused for the drill claim.
- **(b)** carry the contribution map on the `hand_history` row already being
  written one step earlier. Zero extra round trips; costs a jsonb column on a
  3.6 GB table taking 221,000 rows a day.

Recommendation: **(b)**. It puts the map where the witness already is, and the
storage is bounded by the retention policy that already prunes horse-only hands
at seven days.

---

## 5.6 — the check stops reading a column four functions can move

`20260907170147_the_check_stops_reading_a_column_four_functions_can_move.sql`

Phase 5.6 was written down as "retire the legacy `bbj_pools.pool_amount`: one
writer, no readers left." Both halves were wrong, and the second half was wrong
because of something I did an hour earlier.

Read from `pg_proc`: **four** functions write it — `record_rake`,
`fn_union_promo_send`, `fn_resolve_bbj_pool`, `fn_complete_club_opening_setup`.
The six other functions that mention `pool_amount` are about
`bbj_winners.pool_amount_at_hit` or a local alias; a grep would have called all
six readers of this column and none of them is.

And "no readers left" stopped being true at `20260907163403`, when 5.3 taught
the conservation check to read `sum(pool_amount)` as the opening seed. **That
was the mistake and this migration is the correction.** A money verdict must not
stand on a figure four functions — one of them on the rake path — can move
without anybody deciding to. 10.86 rule 4, for the third time in one afternoon.

What the 1,000 actually is: pool `a7a65cfc` carries `pool_amount = 1000.00` and
its `main_balance` is 981.59 above what its own contribution rows explain, with
no chip movement near 1,000 anywhere around the pool's creation. A club opening
seeds the jackpot's main bank and the seed arrives with no contribution row. So
`opening_seeds` is pinned at 1,000.00 on the baseline row, remembered rather
than derived, and a _new_ seed now shows as `moved_since_resolution` and takes
`lifetime_healthy` false — which is correct: chips entering a jackpot bank with
no contribution row is something a person should look at once, and then record.

The column is deliberately **not dropped**. It is the only surviving record of
that seed, and deleting a settled record to tidy a number is Dan's alone (10.9).
It gets a `COMMENT` saying what it is, that it is not a bank, and that a money
check read it for one hour and stopped.

---

## Open after phase 5

- **The lost rake attribution** (5.5 above) — ~49 hands a day, ~115 chips of
  basis, two costed options and a recommendation, needs Dan's call.
- **45.80** of genuinely unexplained lifetime residue, now pinned and visible
  instead of hiding 71,749.31 of paid jackpots.
- **Phase 4.2/4.3**, the live drill, still blocked: it needs Dan signed in and a
  drill club whose pool is under the 1,000 ceiling.
- **PR #3404** (the phase-3 threshold panel) still unmerged on `CSS Beat E2E`.
- **Phase 6 of 6** — the Mini BBJ funded by the backup reserve, with a formula
  that differs between hold'em and PLO. Reserved for last at Dan's instruction.
