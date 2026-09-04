# The money alerts nobody was told about

2026-09-04 · branch `docs/sentry-realtime-programme`

The settlement outage found earlier today was a database that knew something
139,153 times and had no way to say it out loud. This is the same failure one
layer up, and it had been running far longer.

## WHAT WAS THERE

```
1,345  unresolved rows in financial_alerts
  656  distinct conditions          (2.1 copies of each - the table does not deduplicate)
  154  alerts ABOUT alerts          (drift_incident:financial_alerts:*)
   95  distinct sources
oldest  2026-08-20 - fifteen days unlooked-at
```

Every reconciler, guard and sweep on the platform writes there. The table works
perfectly. Nothing has ever reported that it has contents.

## THE LOUDEST ALERTS IN IT WERE FALSE

`Tournament.winner_prize_credit_failed` says, in as many words, _"N chips owed
to `<user>` were never paid"_, at severity critical. There were five unresolved.
**All five had already been paid:**

| alert raised   | paid at  | gap    | prize |
| -------------- | -------- | ------ | ----- |
| 09-04 11:29:04 | 11:29:13 | **9s** | 10    |
| 09-04 11:29:02 | 11:29:11 | **9s** | 3     |
| 09-03 19:20:24 | 19:20:33 | **9s** | 19    |
| 09-03 19:20:21 | 19:38:35 | 18m    | 190   |
| 09-02 20:21:52 | 20:52:01 | 30m    | 3.8   |

Every one has a `tournament_payouts` row with `paid_at` set, a matching
`chip_ledger` credit, and the exact amount. The mechanism: the engine's direct
credit hits the `service_role` statement timeout (`canceling statement due to
statement timeout`), retries three times, gives up, and raises a critical alert
asserting the player was never paid. The reconciler then pays them, correctly
and idempotently, seconds later. Nothing goes back to close the alert.

Widened across the whole table: of 71 unresolved alerts that carry both a
`tournament_id` and a `user_id`, **69 show the money has since landed.** The
two that do not are `Satellite.seat_origin_unknown`, which is not about a
payment.

**So the backlog is not a pile of unpaid players. It is a pile of recoveries
nobody recorded** — and it is deep enough to hide a real one. That is the
actual danger, and it is why this is worth fixing rather than clearing.

All five payees were horses. Under §10.5 that changes nothing about whether
they get paid, and they were paid the same as anyone.

## THE COLUMN THE RULES REQUIRE HAS NEVER EXISTED

`CLAUDE.md` §10.9, in both repos, says a settlement is finished when four
things exist, one of them being _"the `financial_alerts` row resolved with a
`resolution` note saying what was accepted and why"_.

`financial_alerts` has no `resolution` column. It has `resolved`, `resolved_at`
and `resolved_by uuid` — nowhere to put prose. **Every agent instructed to
write a resolution note has had nowhere to write it.** That is not the whole
reason 1,345 rows are open, but resolving one _properly_ was literally
impossible as documented, and a rule that cannot be followed stops being
followed.

Added as `text`, with a comment recording why.

## WHAT SHIPPED

**1. `fn_resolve_settled_prize_alerts()` + a 15-minute cron** (`20260904182824`)

Closes only the class where the alert asserts non-payment and the payment
provably happened: a `tournament_payouts` row for that exact tournament and
user, `paid_at` set, **and an amount equal to the prize the alert named** — a
payout for a different amount is not evidence that _this_ obligation was met.
It writes a resolution naming the evidence. Closed 5.

It carries its own greed check: the migration aborts if the resolver ever closes
more than 50 rows, because it is scoped to one narrow provable class and a large
number would mean its predicate had gone wrong. A resolver that quietly empties
the table is worse than a backlog.

**2. `fn_financial_alert_health()` + four alert rules**

The backlog on a gauge, **aged**. Age is the load-bearing dimension and gets its
own gauge and its own alert: a critical raised a minute ago is the system
working exactly as designed; the same alert still open a day later is nobody
listening. Only the second is worth waking someone for, so `MoneyAlertsGoingUnread`
fires on `stale_critical`, not on the raw count.

`distinct_conditions` is exposed separately because the table does not
deduplicate — if the row count climbs and the condition count does not, it is
repeating itself rather than finding new problems.

**3. `ca_declared_money_triggers` + `fn_undeclared_money_triggers()`** (`20260904182847`)

The answer to the other half of this morning. `aaa_skip_noop_update` was
attached to `table_seats` with no migration, no PR, no test and no review, and
broke a third of all hand settlements 0.65 seconds later.

RULE 2 already forbade it. Nothing enforced it — and the existing guard
structurally could not: `check-applied-migrations-are-recorded.mjs` compares
`supabase_migrations.schema_migrations` against the files in this repo, and **an
object created by raw `execute_sql` never writes a row there at all.** It asks
"does every applied migration have a file", and for an object that was never a
migration the answer is vacuously yes. The hole is not that somebody broke the
rule; it is that breaking the rule left no trace anywhere anything looked.

So: a declared inventory of every trigger on the nine tables that move money or
seats — `table_seats`, `club_members`, `club_wallets`, `union_wallets`,
`wallets`, `chip_ledger`, `tournaments`, `tournament_players`, `ca_settlements`
— seeded with the current **106**, and a function reporting anything live that
is not in it. `poker_money_undeclared_triggers > 0` pages within two minutes.

Seeded _after_ the rogue trigger was removed, so the baseline is the reviewed
state; the migration asserts `aaa_skip_noop_update` is not in it.

It is an **inventory, not a block.** A BEFORE trigger that can refuse a schema
change on these tables is a worse failure mode than the one it prevents — the
same reasoning `ca_seat_stack_exits` used in §11.5. Make it loud, not
impossible.

**Declaring a new trigger is one INSERT in the migration that creates it.** That
is the point: the declaration _is_ the review trail, and a migration that adds a
trigger without declaring it lights the gauge within a minute of being applied.

## VERIFICATION

```
auto_resolved_prize_alerts   5
declared_money_triggers    106
undeclared_money_triggers    0
alert_backlog              1,344 unresolved / 556 critical / 483 stale
                             652 conditions / oldest 364.6h / 154 meta
```

`server`: `tsc --noEmit` clean, service suite green. The collector's tests
assert both directions, including the one that matters most: when the
undeclared-trigger query _fails_, the gauge is **absent rather than 0** —
because zero undeclared triggers is the all-clear, and reporting an all-clear
the collector has not earned is exactly the lie that let a rogue trigger run for
thirteen hours.

## WHAT WAS DELIBERATELY NOT DONE

**The other ~1,300 rows are left open.** Most are probably stale in the same
way. "Probably" is not evidence, and §10.9 reserves rewriting a settled record
to make a number look tidy to Dan alone. They are now visible, aged, on a gauge
— which is the honest state, and better than a clean number that means nothing.

Two classes were specifically excluded from auto-resolution even though they
match on a payout row:

- **`fn_settle_tournament_obligation`** — _"Refused 0.09 to `<user>`: the prize
  pool of 1500.00 has already paid 1500.00"_. The guard behaved correctly, but a
  player is still short a rounding residual the pool cannot fund. That is a real
  question, not a resolved one.
- **`Tournament.guarantee_not_met`** — an advertised guarantee that was not met.
  §10.9 puts guarantees with Dan.

## STILL OPEN, AND WORTH A DECISION

Read from the backlog, not fixed:

- **Guarantee shortfalls, ~1,256 chips.** Three events _"advertised a
  guaranteed prize, crowned the field, and paid nobody anything"_ (75, 80, 100),
  and four that paid less than advertised (460, 350, 175, 16). All show
  `overlay_funded: false`. Honouring an advertised guarantee on a past event is
  arguably a promise already made to players; setting what a guarantee means is
  Dan's under §10.9. **This needs his call.**
- **`fn_ca_supply_snapshot`: ledger imbalance drift 9,901,483 chips**, and
  `fn_ca_quick_reconcile:frozen_pool` at 979,900. Large enough that they are
  either a real accounting break or a broken measure, and either answer matters.
- **`FeeReconciler.double_paid_obligation`: 32 obligations settled by more than
  one repair path, 1,001 chips paid twice.** Under §10.9 rule 3 the overpay is
  absorbed and never clawed back — but two repair paths racing each other is a
  defect that will do it again.
- **`fn_money_check_health`: "`fn_uncollected_entry_check` has never run. It is
  expected every 60 minutes, and until it does its silence means nothing."** A
  monitor that has never executed, reporting healthy by saying nothing. The same
  shape as everything else here.
- **Three alert groups in `infra/monitoring/alert-rules.yml` have no rules at
  all** — `cron-health`, `postgres-health`, `vercel-health` parse as `null`.
  Pre-existing on `main`, not introduced here. An empty alert group is a heading
  that alerts on nothing, and `postgres-health` being one of them is pointed,
  given the day.
