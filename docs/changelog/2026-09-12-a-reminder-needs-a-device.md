# A reminder needs a device to reach (2026-09-12)

## What was wrong

`public.prepare_tournament_reminders(integer)` selected every registrant of
every tournament starting inside fifteen minutes and wrote one `push_outbox`
row each. It never asked whether the recipient had a device.

Measured on production, seven days to 2026-09-12 05:00Z:

|                                                                                                 |                                                                      |
| ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| tournament-reminder rows written                                                                | 15,900                                                               |
| share of ALL `push_outbox` volume                                                               | 94.9% (15,900 of 16,751)                                             |
| distinct recipients                                                                             | 935                                                                  |
| recipients with an active push subscription                                                     | 0                                                                    |
| rows whose recipient had EVER held a `push_subscriptions` row at the moment the row was written | 0                                                                    |
| delivered                                                                                       | 0 - every row `status='skipped'`, `failure_reason='no_subscription'` |

## What was NOT wrong

**The dispatcher.** `pages/api/cron/push-dispatch.js` (World Hub) sets
`skipped` / `no_subscription` when a recipient has no active subscription, and
`src/lib/push/push-deliver.js` does the same inline. That is the only correct
thing to do with a row addressed to nobody. Fixing the enqueue removes the
skips; the skip itself was never the defect.

**Idempotency.** There were ZERO duplicates. Every
`(event, tournament, recipient)` group held exactly one row, and the `:45`/`:58`
clustering is just the recurring hourly schedule.
`tournament_reminder_receipts` plus the BEFORE INSERT claim
`trg_claim_tournament_reminder` already give exactly one row per
`(tournament, recipient, scheduled_start_at, stage)` - in twelve hours they
suppressed 10,707 claims and admitted 328. Nothing here adds a second
mechanism, and the guard is pinned by the law test so nothing removes it either.

Also ruled out with data and not re-chased: transport/VAPID mismatch,
quiet-hours and per-type preferences, and the zombie sweep (its 54
deactivations are spread over three weeks with per-device reasons such as
`expired_410`, written by the dispatcher on a genuine 410 Gone).

## The fix

One predicate, in the candidate `WHERE` of the enqueue:

```sql
AND EXISTS (SELECT 1 FROM public.push_subscriptions s
  WHERE s.user_id = tp.user_id AND s.is_active)
```

and three things that follow from it:

1. the same predicate in the `next_due_at` report, so the function does not
   announce work it has correctly decided never to do;
2. the same question asked at the table by `trg_claim_tournament_reminder`,
   because a predicate living in one function's `WHERE` clause is a convention
   and the next caller walks round it. **It claims no receipt** - a receipt is
   permanent, and claiming one would mean a player who turns notifications on
   four minutes before the event never gets the reminder they just asked for.
   The candidate predicate is stateless: the minute a device appears, the
   registrant re-enters the candidate set on the next tick;
3. `push_subscriptions_user_active_idx` declared in the repo. It was live and in
   no migration, so a rebuild from `supabase/migrations` would have produced the
   predicate without the index that makes it free. `CREATE INDEX IF NOT EXISTS`,
   a no-op against production.

### Latent starvation, closed by the same line

The candidate loop is `ORDER BY t.start_time, t.id, tp.user_id LIMIT 300`. At
05:10Z there were **1,266 registrant rows across the upcoming schedule, every
one of them unreachable**, competing for those 300 slots. A registrant with a
device and a high UUID could be sorted out of her own reminder by recipients who
could never have received one. Filtering on reachability empties the budget of
everything undeliverable, so it is spent only on people it can reach.

## REACHABILITY, NEVER SPECIES (CLAUDE.md 10.5)

Every one of the 935 recipients was a horse, so "filter out the horses"
describes exactly the same 15,900 rows and is the obvious shortcut. It is the
`is_horse` trap in its original shape - the one that cost 39 tournaments their
whole rake attribution on 2026-08-27 - and it is wrong in both directions: it
would keep queueing for a HUMAN with no device, and it would refuse a horse that
has one.

Proven read-only against production. Reference instant 07:20Z, inside the 15m
window of the 07:30Z event, receipts guard dropped so the candidate set is
visible:

|                                                            |                             |
| ---------------------------------------------------------- | --------------------------- |
| candidates before the predicate                            | 43                          |
| admitted by the predicate today                            | 0                           |
| admitted with ONE simulated device on ONE horse registrant | 1                           |
| who                                                        | `brickcity` (is_horse=true) |

And the predicate evaluated verbatim against real rows: `danimal5022` (human,
has devices) admitted, `kingfish` (human, has devices) admitted, `brickcity`
(horse, no device) refused. Nothing in it reads `profiles`.

`tests/a-reminder-needs-a-device.law.test.ts` fails if either routine ever
mentions `is_horse`, `is_bot` or `is_house`.

## Cost

None. `EXPLAIN (COSTS OFF)` on the new candidate query resolves the EXISTS with
`Index Only Scan using push_subscriptions_user_active_idx`.

## The thing this was hiding, and why it now has a detector

Push is not dead. Its entire audience is **two users** - `danimal5022` and
`kingfish`, both human, four active subscriptions between them - and it has been
decaying as subscriptions expire on 410 and nobody re-subscribes:

```
2026-08-31  248 sent      2026-09-05   17      2026-09-09   10
2026-09-01   78           2026-09-06   24      2026-09-10    8
2026-09-02   49           2026-09-07   16      2026-09-11    4
2026-09-03   44           2026-09-08   15      2026-09-12    1 (to 05:00Z)
2026-09-04   23
```

That decay was invisible underneath 15,900 horse-addressed skips. The World Hub
side of this work (separate PR) stops counting `no_subscription` as a delivery
failure wherever push health is computed, and adds the detector for the audience
collapsing - because the failure nobody would currently notice is not a broken
send, it is the last device going quiet.

## How this was verified

**Executed, not reasoned about.** `scripts/dev/probe-tournament-reminders.sh`
stands up an ephemeral PostgreSQL 17, applies the real migration files and calls
the real routines. No production writes. It was 43 checks; it is 54, and every
one of the original 43 now runs against the definitions this PR ships:

```
{"checks":54,"postgres":"17","legacyLockFailureReproduced":true,
 "playerLockIndependent":true,"productionWrites":false}
```

The ten new ones, in the harness's own words:

- A registrant with no device is not even a candidate (`accounted === 0`)
- and no row reaches the queue for them (`queued === 0`)
- Refusing an unreachable registrant claims no receipt
- Enrolling a device inside the window still earns the reminder
- A retired subscription is not a device
- Fixture: this reachable registrant is a horse
- **A horse with a device is queued exactly like anybody else**
- **A human with no device is refused by the very same predicate**
- Any caller inserting an undeliverable reminder is refused at the table
- and that refusal claims no receipt either
- The migration declares the partial index its predicate rides on

`accounted` and `queued` are asserted as a PAIR on purpose. `accounted` counts
loop iterations and `queued` counts rows that survived the trigger, so the two
separate the halves of the fix. Measured: with only `queued` asserted, deleting
the candidate predicate leaves it at 0 - the backstop catches the row - and the
check goes green over a fully restored defect. Three deliberate-failure runs
pin which half is which:

| mutation                    | harness says                                                             |
| --------------------------- | ------------------------------------------------------------------------ |
| candidate predicate deleted | `A registrant with no device is not even a candidate`                    |
| trigger gate deleted        | `Any caller inserting an undeliverable reminder is refused at the table` |
| both deleted                | `A registrant with no device is not even a candidate`                    |

`tests/a-reminder-needs-a-device.law.test.ts` (8 assertions) covers the same
ground statically, and four mutations were run against it: swapping the
predicate for `NOT EXISTS (... profiles ... is_horse)` reds two assertions,
deleting it from the candidate loop reds one, moving the trigger gate below the
receipt claim reds one, deleting the index declaration reds one.

**One environment fix came with it.** `probe-tournament-reminders.sh` could not
run at all on macOS with PostgreSQL 17 - the postmaster aborts at startup with
`postmaster became multithreaded during startup`. One line, `export LC_ALL=C`,
with the reason beside it.

## Schema drift: what the brief expected, and what is actually true

The brief for this work said
`20260909195446_tournament_reminders_own_durable_receipts_without_player_writes`
was applied to production with **no .sql file in either repo**, and asked for a
byte-exact backfill. I wrote one, verified it against
`schema_migrations.statements` (11,774 bytes, md5
`3532a5369a377eefe0fa23a95ea71485`) - and then found the file already on
`origin/main`, byte-identical, added by
`6e9de72fec fix(realtime): commit reminder receipts without locking players (#4012)`
on 2026-09-09. **So the backfill was deleted rather than shipped.** Nothing was
missing.

**Why it looked missing, and the part worth keeping:** the canonical checkout at
`~/Documents/club-arena` is **735 commits behind `origin/main`** (and 1 ahead,
a local commit from 2026-09-06). Every "absent from the repo" conclusion drawn
from that tree is unreliable, and this one was. It is CLAUDE.md 10.8.1 exactly -
confirm a thing against current `origin/main`, never a local tree - and the
concrete cost here was a first look that went to `check_upcoming_tournament_pushes`
as the 2026-08-28 migration defines it, rather than to the function that has
actually been running since 2026-09-09.

**Flagged, not fixed** (not this PR's lane), and different from the brief in
both directions:

- The transport migration is **not** missing from `schema_migrations`. It is
  there as `20260908003810_push_subscriptions_carry_a_transport_so_a_native_device_toke`
  (1,325 bytes), and `push_subscriptions.transport text NOT NULL DEFAULT
'webpush'` is live. The version `20260908003626` named in the brief is not in
  `schema_migrations` at all.
- What IS wrong is a **version mismatch**: `origin/main` carries the same change
  as `supabase/migrations/20260908003626_...` (3,013 bytes), whose SQL is
  byte-identical to the applied statements once its comment header is removed.
  The file says `003626`, the database recorded `003810`. Harmless to re-apply
  (`ADD COLUMN IF NOT EXISTS`, `DROP CONSTRAINT IF EXISTS`), but the two
  ledgers do not agree.
- And PR #3599 shipped an **empty reserved skeleton** beside it -
  `20260908003616_push_subscriptions_carry_a_transport_so_a_native_device_toke.sql`,
  555 bytes, still saying `-- your change here`. A version reserved, not used,
  and committed anyway.
- Both are instances of a much larger backlog rather than anything special: 605
  migrations were applied between 2026-09-07 and 2026-09-10, and `origin/main`
  carries a small fraction of them. That is
  `scripts/ci/check-applied-migrations-are-recorded.mjs`'s job, and it reports
  rather than blocks for exactly this reason.
