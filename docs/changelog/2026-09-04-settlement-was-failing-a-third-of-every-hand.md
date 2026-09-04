# Settlement was failing a third of every hand, for thirteen hours, silently

2026-09-04 · branch `docs/sentry-realtime-programme`

## WHAT HAPPENED

```
2026-09-03 21:30:32.450934+00   aaa_skip_noop_update installed on table_seats
2026-09-03 21:30:33.096824+00   first "seat write failed - hand write rejected whole"
```

**0.65 seconds apart.**

Hand-settlement failure rate, by hour:

|       |          |       |           |       |       |
| ----- | -------- | ----- | --------- | ----- | ----- |
| 18:00 | **0.1%** | 22:00 | 38.5%     | 03:00 | 29.8% |
| 19:00 | **0.2%** | 23:00 | 40.2%     | 06:00 | 36.1% |
| 20:00 | **0.0%** | 00:00 | **44.2%** | 08:00 | 27.4% |
| 21:00 | 19.1%    | 01:00 | 38.5%     | 10:00 | 25.0% |

**139,153 hands did not settle** — between a quarter and nearly half of every hand
dealt on the platform, for thirteen hours.

Nothing raised an alert. The failure was written to `ca_settlements.state = 'failed'`
with a full `error_detail` on every one of those 139,153 rows. The database knew,
139,153 times, and had no way to say it out loud. It was found because somebody was
looking at that table for an unrelated reason — sizing it for a retention prune.

## THE CAUSE

`aaa_skip_noop_update`, a `BEFORE UPDATE` trigger on `table_seats`, **applied straight
to production with no migration in this repo.** It returns `NULL` when
`NEW IS NOT DISTINCT FROM OLD`, which cancels the update. The `aaa_` prefix is
deliberate — triggers fire in name order, so it ran before every other trigger on
the table.

`fn_ca_settle_hand_stacks_absolute` writes each seat's absolute stack and checks that
the write landed. A seat whose stack was already correct — a player who folded without
posting, most obviously — now reported **zero rows affected**, and the function refused
the whole hand rather than settle part of it.

**The settlement function is not the bug.** Refusing a hand whose seat write did not
land is exactly what it should do; that check is the reason no money was lost here.
The trigger is what lied to it.

Proven in a transaction that rolled itself back — no chips were spent to learn this
(CLAUDE.md 11.5):

```
UPDATE public.table_seats SET stack = stack WHERE id = <a live seat>;
  before the revert:  rows_affected = 0,  suppressed 340086 -> 340087
  after  the revert:  rows_affected = 1
```

## WHAT IT COST, AND WHAT IT DID NOT

Measured across the whole window, not assumed:

|                         | Before 21:30          | During                | Verdict                             |
| ----------------------- | --------------------- | --------------------- | ----------------------------------- |
| Rake collected          | 6,614–7,264 rows/hr   | 6,268–7,219 rows/hr   | **unaffected**                      |
| VIP points              | 19,905–21,661 rows/hr | 15,785–19,034 rows/hr | **unaffected** (tracks hand volume) |
| Conservation violations | —                     | 37 in 13h             | pre-existing rate                   |

**No chips were lost, no rake was lost, no VIP points were lost.** Three reasons:

1. The settlement writes **absolute** stacks, not deltas, so a hand that failed is
   corrected by the next successful settlement on that table — which writes the
   engine's current truth over whatever the row held.
2. The refusal is whole. A partial settlement would have destroyed chips; this
   function will not do one, and that is why 139,153 failures produced only 37
   conservation drifts.
3. Rake and VIP attribution run on paths that did not depend on the seat write.

What it did cost: 139,153 hands have no settlement audit row, seat stacks lagged by
one hand until the next successful settlement on each table, and — with some irony —
a trigger installed to save writes generated a very large number of extra ones.

## WHAT SHIPPED

**1. The trigger is detached** (`20260904110252`). A revert, not a redesign: the
platform ran without it for its entire life until thirteen hours ago, so removing it
returns the database to a state known to work and touches no money path. The function
and its counter table are left in place — `ca_noop_update_stats` holds the evidence —
with a `COMMENT` on the function recording exactly what it did, so the next person to
find it does not re-attach it.

It was worth ~26k suppressed row versions an hour. It bought that by breaking a third
of all hand settlements.

**Effect, by the minute:**

```
10:48   316 settled   97 failed   23.5%
10:49   523 settled    0 failed    0.0%
10:50   483 settled    0 failed    0.0%
...
11:04   204 settled    0 failed    0.0%
```

**2. Settlement health is on a gauge** (`20260904110620`) — `fn_settlement_health()`,
`server/src/services/SettlementMetrics.ts`, and five alert rules in
`infra/monitoring/alert-rules.yml`.

The design decision that matters: **it is a five-minute window, never a lifetime
total.** The lifetime ratio read **7.7%** at a moment when the live rate was **44%**,
because three days of healthy history diluted it. A gauge computed the obvious way
would have shown this incident as a minor background defect for its entire thirteen
hours — and that dilution is part of why nobody caught it.

The failure rate is **absent, never zero**, when nothing settled in the window: no
hands is not the same as no failures, and "the platform has stopped settling entirely"
is the most serious thing this family can be looking at. `NoHandsAreSettling` alerts
on that absence separately.

Live reading after the revert: `settled=2852 failed=1 rate=0.0004` — the pre-incident
baseline, and the one remaining failure is the long-standing `seat missing or left`
class rather than the trigger.

## HOW THIS IS PREVENTED NEXT TIME

- `HandsAreFailingToSettle` fires at **2%** over 5 minutes, critical. The incident sat
  at 19% within its first hour.
- `SettlementFailuresAboveBaseline` fires at **0.5%** over 30 minutes, warning —
  because the baseline is 0.0–0.2% and a rate that merely doubles is worth knowing
  about long before it reaches a quarter of all hands.
- `SettlementMetricsBlind` fires when the collector itself goes quiet, because
  "unknown" is precisely what thirteen hours of this looked like.

## THE PART THAT IS NOT FIXED BY A GAUGE

**`aaa_skip_noop_update` was applied directly to production with no migration.** So
were `fn_skip_noop_update` and `ca_noop_update_stats` — none of the three exists in
this repo, and `scripts/ci/supabase-schema-manifest.json` does not know about them. A
Midway master reset rebuilt from these files would not have had the trigger, which in
this one case would have been a mercy, but the general form of that is how a hardening
gets silently lost.

Nobody reviewed this change. There was no PR, no test, and no rollback plan, and it
broke a third of the platform 0.65 seconds after it landed. The estate already has the
rule that would have caught it — RULE 2, migrations only, never raw `execute_sql` for
schema changes. It was not followed, and nothing enforced it.

Two related items, raised not fixed:

- **164 unresolved rows in `financial_alerts`**, including criticals that have nothing
  to do with this incident: `FeeReconciler.satellite_conservation`
  (`SATELLITE_CONSERVATION: 1 completed satellite broke conservation`),
  `drift_incident:fn_ca_supply_snapshot` (`-1296.53 chips`), and
  `fn_ca_quick_reconcile:frozen_pool` (`-10,700 chips`). The alerting table works;
  what is missing is anyone being told. That is the same shape of gap as this
  incident, one layer up.
- **`fn_tournament_money_conservation`: "Tournament paid out money it never
  collected"**, 25 unresolved since 2026-09-03 20:55.
