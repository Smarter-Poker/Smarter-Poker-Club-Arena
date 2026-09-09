# The flip had no hand

2026-09-08. Migration `20260908151633_the_flip_had_no_hand.sql`.

## What was wrong

Nine diamond rules carry a `flip_after` date on which they stop logging and
start refusing: 2026-09-14, 2026-09-22, 2026-10-08. A week of work went into
making those dates safe — the flip forecast, the cap headroom report, the VIP cap
fix, the settlement of 759 expiring horse rewards. All of it answering one
question: _what will this refuse on the day it arms?_

**Nothing arms them.** `fn_ca_diamond_rule_flip` is the only thing that sets mode
to `refuse`. Measured on production:

```
cron jobs calling it .......... 0
database functions calling it . 0
application callers ........... none
```

The four `ca-diamond-*` cron jobs are snapshot, trial balance, and prune
history. So `flip_after` was a date on which nothing happened. Nine rules would
have stayed in `log` mode for ever, three dates would have passed unremarked, and
every instrument built to make the transition safe was reporting on a transition
that would never occur.

**The safety apparatus is what hid it.** Everyone, me included, kept checking
whether the flip was _safe_. Nobody checked whether it was _connected_. This is
the estate's signature failure — a guard that reads as armed while being
unreachable — and CLAUDE.md's engine-restart handoff records three more of
exactly this shape.

## What changed

**A hand.** `fn_ca_diamond_rule_flip_due()`, on a daily pg*cron tick beside the
four `ca-diamond-*`jobs already running this subsystem's work. It is not a
repair job (10.12): it repairs nothing and compensates for nothing. Its schedule
\_is* the product —`flip_after` is a date, and a date needs something that
notices it. It decides nothing either: arming was decided when each rule was
written (rulings 13–20, with dates). It executes recorded intent.

It is strictly more conservative than a human doing it by hand. It passes all
three of `fn_ca_diamond_rule_flip`'s existing gates — date reached, zero non-info
incidents in `clean_days_required`, and some function must actually consult the
rule — plus **a fourth this migration adds: the forecast must report zero
would-refuse since the rule's configuration last changed.** The forecast stops
being a report somebody might read and becomes the gate.

A rule it cannot arm is **reported**, not skipped, so "blocked" and "nothing to
do" never read the same.

**The forecast learns when the configuration changed.** It counts incidents over
a time window, and a rule's configuration can change _inside_ that window —
making everything before the change evidence about a rule that no longer exists
in that form.

Today that misread harmlessly: it said `DR7:user_over_daily_cap` would refuse
4,549, all of which predate the 14:33 cap fix, with zero since. **The dangerous
direction is the reverse.** Lower a cap and the forecast reads "SAFE TO ARM" for
24 hours on evidence gathered under the old, looser setting — and it is now wired
to something that acts on it. It reports `since_config` and `config_at` beside
the window total, and the gate reads the former.

**`updated_at` is actually maintained.** Both config tables carried the column
and neither had a trigger, so it recorded whatever the last writer happened to
set. My own cap change at 14:33 left it reading 05:05. An epoch the configuration
does not update is worse than none, because the forecast now trusts it.

**One front door.** There are 28 `fn_ca_diamond_*` / `fn_ca_mint_*` reporting
functions. A person has to know which to read, in what order, and what a bad
answer looks like in each — which is how "nothing arms the rules" survived a week
of daily review. `fn_ca_diamond_health()` returns twelve areas, each with
`ok`/`attention`/`critical` and a sentence. Its first row is whether the flip has
a hand.

## Three mistakes this migration made and caught

Worth recording, because each is the same defect it exists to fix:

1. **The dry run reported "every gate passes" after checking only the new gate.**
   All nine rules read as ready to arm while the real flip would have refused
   every one on its date — and the health report counts blocked rows, so it would
   have called the subsystem healthy on the strength of a check it had not run.
2. **The `updated_at` assertion compared before against after inside one
   transaction.** `now()` is transaction time and does not advance, so it
   compared a value the same transaction had just stamped against itself and
   always failed. It tests equality with `now()` instead.
3. **The final NOTICE said "none critical" as a fixed string** while asserting
   nothing of the kind — a claim with no reader behind it, in the migration whose
   whole subject is claims with no reader behind them. It counts them now.

A fourth was avoided rather than made: the first `evaluation coverage` row
reported `critical` for 5,861 failures that had all stopped three minutes before
the fix landed that morning. An alarm that stays red for a day after its cause is
fixed is an alarm somebody mutes — and that row is the one saying whether the
others can be trusted. It distinguishes a live gap from a stopped one.

## Verified live

```
area                  status      detail
rule arming           ok          ca-diamond-rule-flip-daily is scheduled and active
rules overdue         ok          No rule is past its arming date and still stuck
money identity        ok          players + float = register, exactly
deploy gate           ok          The snapshot explains every movement
trial balance         ok          Every reconciling account balances
per-user caps         ok          No user-day in fourteen days exceeds its cap
VIP caps              ok          No cap gives a VIP less than a standard player
unclaimed rewards     attention   19 earned rewards unclaimed and will expire
horses are players    ok          No horse is classified as test equipment
budget plans          attention   3 budget lines are fiction (Dan's to set)
unreachable money     ok          Nothing stranded
evaluation coverage   attention   5,861 in 24h but none for 02:44; appears fixed
```

The dry-run sweep reports all nine rules with a reason: eight blocked on their
date, and `DR13:concentration_or_velocity` blocked by the new forecast gate —
six movements since its configuration changed.

## What this found within hours of existing

`unclaimed rewards: 19`. Those accumulated in the two and a half hours after the
759 were settled — roughly seven an hour. **The root cause is live and building a
new backlog**, exactly as the settlement's own header said it would until the
engine claims on its own cadence. That is the next fix, and it is engine-side.
