# One movement, one leg - and a board that can go green

2026-09-09

The drift board opened this session with eight findings and no criticals. Six
of them turned out to share two causes, and the second cause is the more
important one: **nothing on this platform could close an incident.**

## The settlement was writing every commission down twice

Round 2 of the union settlement cascade ran at 10:06 UTC and moved 20,377.49
of commission from two club treasuries into 28 agent wallets. The journal
recorded 40,754.98.

It wrote a named leg for each payment by hand - period, row count, idempotency
key. It also left both balance writes to journal themselves, and neither
trigger had been told who the counterparty was, so each payment arrived a
second time as an anonymous pair through `settlement_suspense`. Every agent
wallet and both treasuries read double in a per-account replay.

The reason the stand-down did not work is small and had been there a long
time. Every journal writer on the platform obeys one clause:

```sql
IF current_setting('app.ledger_autoskip_<table>', true) = '1' THEN
  RETURN NEW;
END IF;
```

`fn_club_members_ledger_writer` - the writer for `club_members.chip_balance`,
the busiest balance column on the platform - never had it. So a caller that
correctly suppressed the `clubs` trigger and wrote its own named leg still got
a twin from the other side. `promo_apply_playthrough` and `fn_ca_alarm_drill`
had both been setting that flag and being ignored.

**Fixed:** the writer learned the clause; rounds 2 and 3 set it around every
balance write, immediately before and cleared immediately after, so a
`CONTINUE` out of a loop iteration cannot leave a later statement silently
unjournalled. Proved in a rolled-back probe: stood down, 0 legs; declared, 1
leg, `club_treasury -> player_wallet / commission`, 0 suspense.

**The record already written:** 56 cancelling legs, one per side of each of
the 28 payments, keyed per pair. The journal is hash-chained, so a wrong row
is answered, never removed. All 28 agents now read exactly what moved.

The same defect was live in `fn_pay_player_chips`, the shared door every
rakeback path goes through. It has always resolved which club it is crediting;
it now says so. On 2026-09-07 that door put 231,046.71 of rakeback into the
journal anonymously.

## A chip that kept no name is a finding, not a note

`settlement_suspense` is the counterparty a trigger uses when nobody said who
the other side was. The only thing watching it was a daily info note measuring
the _flow_ - and flow nets to zero the moment a movement passes straight
through, which is the exact shape of this bug.

`fn_ca_undeclared_leg_check` asks the balance question instead, per account:
after everything that touched suspense in the window, including the
corrections that cancel a twin, is any account left holding chips that were
never given a name? A declared movement never appears. A cancelled twin nets
to zero. What is left is only undeclared money, named by the column that wrote
it. It is in the conservation sweep and it read clean at install.

## A board nobody can empty is a board nobody reads

This is the part worth keeping.

Every detector here can raise an incident and none of them could close one.
The conservation sweep had been folding the same two findings since
2026-09-02 - 92 and 89 occurrences - and would have kept folding them long
after the thing they found was fixed. `fn_bbj_reconcile` was worse: it raises
under a fresh key every hour, so its incidents could never even fold, and left
alone it accumulates one open row per pool per hour forever. That is how a
board reaches 3,402 open incidents.

The measurement that raised a finding is the only thing qualified to say it is
gone, and a detector that runs on a schedule already says so by not raising it
again. `ca_detector_runs` records when each detector completed;
`fn_ca_resolve_cleared_incidents` closes what two consecutive runs have
declined to raise, writing a `verified:` reference naming both runs.

**Two runs, never one.** A check that times out or errors raises a `sweepfail`
incident under a different key, and that must never be mistaken for the
finding having cleared.

**Who may be on the list:** only a detector whose raise condition reads the
whole standing state. `fn_ca_quick_reconcile` is deliberately absent - it looks
at a ten minute window, so its silence means the window moved on, not that
anything was fixed, and auto-closing its criticals would bury real unanswered
money.

It closed the ratchet and both jackpot findings within minutes of being
installed, each with the evidence attached.

## A meter that changed its basis was calling it growth

At 10:21:44 the jackpot meter changed what it measures - from a per-interval
residue, which could only climb, to a cumulative figure since the pool opened,
which comes back on its own. The very first reading on the new basis was
compared against the last reading on the old one, 0.65 against 0.50 and 0.49
against 0.30, and the meter called that growth.

Nothing had grown. Every reading since has been 0.00, including runs covering
206.95 of drops, 52.66 of sweeps and 700.00 of payouts.

The ledger replay already carries `basis_version` for exactly this reason. The
jackpot meter does now too: a reading records its basis, and a reading taken
on a different basis from the one before it is recorded but never called
growth. A write failure still raises on its own, because that is a fact rather
than a comparison.

## The money

**1.40 to the runner-up of a 10x spin.** `1 Chip Deep Stack Spin PLO5` drew a
10x multiplier, so the event held exactly 10.00 for prizes, and the recorded
ladder pays 80/20 - 8.00 and 2.00. Three paths paid it, each reading a
different pool: the engine paid first place 3.00, the whole _unspun_ pool; the
reconciler paid second place 0.60, correctly 20 percent but of the unspun
3.00; the spin back-pay topped first place toward the whole 10.00 draw and the
escrow, already 0.60 lighter, capped it at 6.40.

First place took 9.40 where the ladder promised 8.00. Second place took 0.60
where the ladder promised 2.00. The event conserved perfectly - 10.00 in,
10.00 out. It was split wrong.

Both code paths were already fixed on 2026-09-08, two days after this event
settled, and of the 318 completed spins whose ladder pays more than one place
this is the only one that split wrong. So the ruling under 10.9 is only about
the money: second place is paid the 1.40 the ladder promised, funded by an
overlay from the union bank that took this event's rake. First place keeps
their 1.40 - they were credited in good faith by the platform's own settlement
path, and this platform does not reach into a player's wallet to correct its
own arithmetic.

First place's obligation is brought from the 10.00 the pre-fix back-pay
asserted down to the 9.40 actually paid, which closes the phantom 0.60 the
platform believed it still owed and would have gone on trying to pay out of an
empty escrow. Not to the ladder's 8.00: a CHECK constraint forbids
`amount_paid` above `amount_owed`, and that invariant is right - the column is
a ceiling the platform has committed to, never a number below what a player
has already been handed.

**Platform-wide there are now zero unpaid tournament obligations.**

## A player with chips and no chair

`fn_tournament_chip_conservation_check` had been reporting seven running
events as a single number each - "drift -296,000" - which tells an operator
that chips are missing and nothing about where. The check is sound: 47 of the
54 running events balance to the chip, including a 200-player free buy at
2,630,000 exactly.

Measuring the seven showed what the number was hiding. In three of them the
missing chips are, to the chip, the last recorded stacks of players who are
still alive on the roster and hold no open seat at any table:

| event                  | drift    | stranded        |
| ---------------------- | -------- | --------------- |
| Midday Free Buy        | -296,000 | 296,000 (exact) |
| Prime Time Main Event  | -420,000 | 370,000         |
| $100 Freeroll 12:00 PM | -180,000 | 5,000           |
| Early Bird Freeroll    | -40,000  | 2,500           |

Those players are stuck: in the event, holding chips, at no table, unable to
be dealt a hand. `fn_ca_stranded_tournament_players` gives that its own name
and number in the sweep - eight players holding 673,500 chips across four
events as of today.

## Three criticals arrived mid-session, and one of them was a rate

Two criticals landed at 11:21 while this work was in flight, both from one
event: hand #8689238 on Union Morning Classic table 5 was refused by the
atomic settlement contract because seat 4 had been vacated thirteen seconds
earlier - at 11:21:16 to 11:21:18 the balancer marked six of seven seats left
as it broke the table, and the engine then tried to commit a hand for one of
those players. The contract rejected the write whole and rolled it back before
any money step. The player was moved, not stranded, and the event holds
190,000 chips at its seats against 190,000 put in play, exact.

The class behind it is larger than the one incident: **1,226 hand commits
refused across 312 tables in two days** - 572 stack mismatches, 382 expired
lease proofs, 203 duplicate commits, 47 seats the balancer had already
vacated. Every one is a refusal, so no chips move; what is lost is the hand.
That is a `ServerTableEngine` problem on the poker host, not a function here,
and the fault on this side was the shape of the reporting: each distinct
refusal was promoted to its own critical on the money board, so a standing
rate arrived as a stream of one-off criticals nobody could act on or close.
`fn_ca_hand_commit_refusals` measures it as a rate with its reasons in it.

## One window is noise

`fn_ca_trial_balance_watch` compared a single hour-long window and filed
anything over 100 chips. It filed two notices today - `table_stack` -608.39
and `player_wallets` +511.79, which very nearly cancel, because they are two
sides of the same handful of buy-ins caught on the boundary. `created_at` is
the transaction start, so a movement that opened before the window and
committed inside it has its leg outside and its balance change inside. On a
table taking twenty thousand legs an hour that is certain every window.

The third meter this session with that fault. It keeps its window and learns
the other half of the rule the jackpot meter already uses: only a difference
that persists in the **same direction across two consecutive readings** is a
finding.

Exercising it immediately found a fault in the fix. `fn_ca_trial_balance`
returns a NULL difference for every account whenever the window does not span
two account snapshots, which is most of the time. Recording that emptiness as
a reading would put a blank predecessor in front of the next real one, so two
genuine readings could never be adjacent and the rule would have made the
watch **blind rather than quiet** - the worst outcome for a detector and
exactly the fault this session exists to end. A run that measured nothing now
records nothing. `ca_detector_runs.ran_at` also defaulted to `now()`, the
transaction start, so two runs in one transaction were stamped at the same
instant; it is `clock_timestamp()` now.

## Left open on purpose

- **`fn_ca_conservation_sweep:fn_tournament_chip_conservation_check`** - the
  largest event, `$100 Freeroll 6:00 AM`, is 2,868,800 short with both its
  survivors seated, and that is NOT stranded players. Unexplained, and said so
  rather than folded into a story that fits three of the seven.
- **`fn_ca_conservation_sweep:fn_chip_integrity_report`** - six swallowed
  ledger writes inside the 48-hour window, all of them between 21:48 on 09-07
  and 02:55:08 on 09-08. Migration `20260908025846` made a journal failure
  abort the movement that caused it at 02:58:46 that morning, three minutes
  after the last of them, and `ca_ledger_write_failures` has recorded nothing
  since, through more than thirty maintenance freezes. The window ages out on
  its own and the resolver closes the incident when it does.
- **`fn_ca_hand_commit_refusals`** - the refusal rate itself is real and
  unfixed. It lives in `ServerTableEngine` on the poker host, so no migration
  here can close it; it is now measured rather than announced.

## Closed with evidence

- `fn_ca_ratchet_watch` - undeclared money paths went 88 to 86 and the ratchet
  tightened its own line to 86. Closed by two clean runs.
- Both `fn_bbj_reconcile` pool findings - closed by two clean readings on the
  new basis.
- Both `fn_ca_quick_reconcile:suspense_flow` notes - today's 41,474.98 was
  round 2 journalling twice; yesterday's 5.45 was one leg whose own
  description records `category tournament_buyin and counterparty
prize_liability rejected` plus 0.45 of jackpot bank writes, all before that
  morning's fix.
- `audit:resolution_law_backfill_review` - the backlog of resolutions written
  before the law fell from 118 to 24, and all 24 were read. Every one names a
  concrete cause. One, from source `selftest`, says only "no real drift",
  which is what a self test is.
