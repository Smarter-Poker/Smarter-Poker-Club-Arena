# Phase 3 of 6 — multi-day does not exist, and the guard that says so covered half of it

2026-09-02. This phase was scoped to audit whether chips and prize money follow
a survivor across a flight boundary. There are no flights. The finding is the
absence, and the work turned out to be the guard.

## What is actually there

Measured against production rather than inferred from the schema:

```
parent_tournament_id ........ 0 rows, ever
survivors_advance_to ........ 0
flight_end_chips_snapshot ... 0
flight_number ............... 0
day_number > 1 .............. 0
total_days > 1 .............. 0
```

Nothing in the client, the engine or the database writes any of those five
columns. The only two functions that even mention them are
`fn_generate_recurring_home_games` — a local `v_day_number` for day-of-week, on
a different table entirely — and `fn_uncollected_entry_check`, which reads them
for the day-2 exemption I wrote in Phase 2.

**815 events carry `is_xmtt`, and that is not a multi-day flag.** It is set as
`is_xmtt: !!schedule.union_id`. It means UNION event. I had been reading it as
multi-day, and it is not.

So no chips cross a flight boundary and no money crosses one, because there is
no boundary. There is nothing to reconcile and nobody to pay.

## The 2026-08-26 work was right, and I verified it rather than trusting it

Someone had already found that "Multi-Day MTT" was a working toggle over a
feature that does not exist: it set the flag, painted a badge on the lobby
card, and changed nothing about how the event ran — which played down to one
winner in a single session while the lobby promised otherwise. They replaced
the toggle with "NOT AVAILABLE YET" and added
`trg_tournaments_refuse_unbuilt_multi_day`.

Confirmed live, in a transaction that was rolled back:

```
is_multi_day = true ... REFUSED, SQLSTATE 0A000
total_days   = 3 ...... REFUSED, SQLSTATE 0A000
```

**My first attempt to verify it was contaminated, and that is worth recording.**
I probed a COMPLETED tournament, where the lifecycle lock — "this tournament
cannot be modified after a player has registered" — refused the write _first_.
A guard I had not actually exercised looked like it was working, and I nearly
wrote that down. Only a row with no registrants can test this one.

## What was wrong: half a guard

The same probe, on the same row, in the same transaction:

```
day_number = 2 .................. NOT GUARDED
parent_tournament_id = ... ...... NOT GUARDED
survivors_advance_to = ... ...... NOT GUARDED
flight_number = 2 ............... NOT GUARDED
flight_end_chips_snapshot = ... . NOT GUARDED
```

The trigger fired on `UPDATE OF is_multi_day, total_days` — the two columns
that paint the **lobby badge** — and left open the five that would actually
**structure** a flight. The badge is not the danger. A half-built flight is: an
event with a parent and a day number, no badge to warn anybody, and nothing on
the platform that advances a survivor or moves a pool between days.

**And it reached into my own work.** `fn_uncollected_entry_check` exempts a
seat from the was-this-entry-paid-for question when its event looks like a day
past the first. Setting `day_number = 2` — which nothing refused — would have
switched that exemption on and excused seats from the check, for a Day 2 that
does not exist.

A guard over half a feature is not half a guard. It is a gate on the front door
of a building with five open windows, and the label on the front door is what
makes everyone believe the building is locked.

Widened in `20260902052302`: all seven columns, on the function **and** in the
trigger's `UPDATE OF` list — a trigger that does not name a column never fires
on an update touching only that column, so the body testing it would have been
dead code.

## And a correction to Phase 2's own code

`fn_uncollected_entry_check` computed `multiday := is_xmtt OR is_multi_day`.
Since `is_xmtt` means union event, that stated something false about 815 live
rows to every future reader.

**It was never wrong in effect**, and this says so rather than dressing a
tidy-up as a bug fix: the exemption is an `AND`, its other half is
`day_number > 1 OR parent_tournament_id IS NOT NULL`, and both are zero
everywhere. The exemption has never fired and no seat has ever been excused by
it. What was wrong is what the code said. Corrected in `20260902052604` to read
`day_number` and `parent_tournament_id` only, with a note that it is now
unreachable by construction — kept rather than deleted, because it is the
correct rule for the day Day 2 is built and deleting it would leave whoever
builds it needing to remember.

## The risk this carried, checked rather than reasoned about

The widened trigger fires `BEFORE INSERT` on a table the platform writes
constantly. A non-null default on any of the five new columns would have broken
tournament creation everywhere. The defaults are safe on paper — `day_number` 1,
`total_days` 1, `is_multi_day` false, NULL for the rest — but the proof is the
live rate:

```
applied 05:23:02  ->  newest tournament created 05:23:25, 23 seconds later
36 tournaments created in the five minutes after, 65 registrations in three
```

## Evidence

Function bodies verified against `pg_proc.prosrc` by md5, not assumed:

```
fn_tournaments_refuse_unbuilt_multi_day   428b31045fc54a32e6207a6c15200cf5   1700 bytes
fn_uncollected_entry_check                a0100e602a1042d2cded3d9f184b956b   8111 bytes
```

The migration proves all seven columns refuse with `0A000` on the way in, and
refuses to land if any one of them does not. 8 new pins in
`MultiDayIsRefusedUntilItIsBuilt.law.test.ts`, registered in `docs/LAWS.md`
(registry now 75 assertions). A negative control confirms the law discriminates:
narrowing the trigger back to its original two columns makes it fail.

## A mistake I made twice in one session

Both this migration and the previous one asserted that a name was _absent_ from
a function body — and both first drafts refused themselves, because the bare
word also appears in the prose explaining why the column was removed. An
absence assertion has to match the **code form** of the name (`t.is_xmtt`,
`interval '30 days'`), never the bare word. The same class as a test that reads
formatting instead of behaviour.

## When Day 2 is built

Delete the trigger, its function, the law test and its registry row in one
commit, and delete the "unreachable by construction" note in
`fn_uncollected_entry_check` — the exemption becomes live and correct. Say so in
the pull request. A law that outlives its reason is how a repo ends up with two
laws demanding opposite things.
