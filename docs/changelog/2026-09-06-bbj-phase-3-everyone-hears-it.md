# 2026-09-06 - BBJ build plan, Phase 3 of 6: everyone hears it

Plan of record: `docs/BBJ-BUILD-PLAN.md`. Runbook: `docs/BBJ-RUNBOOK.md`.
Follows phase 2 (`2026-09-06-bbj-phase-2-a-hit-is-never-lost.md`).

Phase 2 made sure a detected jackpot is always PAID. This phase is about
everyone finding out - and about the cost the old way of finding out was
charging every player, on every screen, all day.

## The number this phase is really about

`bbj_pools` was in the Realtime publication and **six** surfaces subscribed to
it: the felt, the lobby header, the ticker, the wallet widget, the union
dashboard and the jackpot page. Every raked hand contributes to the pool, so
every raked hand is an UPDATE on that row.

Measured on production 2026-09-06: **40,219 updates in twenty-four hours** -
one every 2.1 seconds, around the clock. Decoded by the WAL reader, filtered
per subscriber, pushed to every open tab, visible or not. The stream was
already known to run a minute behind at peak; ClubHomePage's occupancy poll
exists in this repo precisely because of that.

All of it to keep current a figure a player glances at, and to carry a signal -
"the jackpot has been hit" - that fires about once a fortnight.

## 3.1 The hit announces itself from its own ledger row

`bbj_winners` gets exactly one row per jackpot, written by
`bbj_atomic_payout_v2` INSIDE the same transaction as the debit and the
credits. The row exists if and only if a jackpot was paid, and it carries who
won, how much, which table and which hand.

`src/lib/bbjHitFeed.ts` subscribes to that INSERT and emits `BBJ_HIT_GLOBAL`.
One row per hit replaces 40,219 row updates a day, and the announcement stops
being an inference.

What it replaces was indirect in three separate ways:

- `payload.old` carries ONLY the primary key (default replica identity), so the
  "previous" hit count was **always 0**. The real gate was a module variable
  that reset on every page load - which is what Dan reported twice: "this old
  bad beat jackpot comes up every single time you log in, and it's the same
  one."
- Having noticed the counter move, it still had to go and ASK who won, because
  a counter says nothing about a hit.
- When that lookup failed it emitted a fallback carrying `tableId: ''`, and
  `BBJHitAnnouncer` drops a payload with no table id on its first line. **The
  fallback was dead code**: the case it existed for was the case where nothing
  was announced at all. The new fallback uses the row's own fields, which are
  real.

Scoped by POOL, not by club, deliberately: a union banks one jackpot for all of
its clubs, so a `club_id` filter would silently stop a union player hearing a
hit at a sister club - which is the whole point of a union-wide jackpot.

**The lobby now hears it.** Dan: "everyone currently playing in the club or
union get a pop up on screen." The engine fans its socket announcement out to
every live table, but a player standing in the lobby has no table socket, so
until today they learned about a jackpot by watching a counter, or not at all.

The engine socket path stays as the fast path. Both producers emit;
`shouldAnnounceBbjHit` de-duplicates on the hit's own identity, so whichever
arrives first announces and the other is dropped.

**Which side is "the winner" was read, not assumed.** The column names read
backwards. Verified against production hand #1007239: `bbj_winners.winner_*`
is the BAD BEAT holder (four of a kind, 892.44, the 50% share) and matches
`fn_bbj_recent_hits.bad_beat_*`; `loser_*` is the player who won the pot and
takes 25%. The card says "X Won $Y", and X is the bad-beat holder.

The same comparison found something else worth writing down: for that one hit,
`fn_bbj_recent_hits` names the player `buf_pam` while
`bbj_winners.winner_display_name` says `AlaskaAlex`. The function returns the
ARENA name - the name the rest of the platform shows - and the column holds
whatever was current when the row was written. The feed therefore enriches from
the function and falls back to the column, and the mismatch itself is the
open horse-name defect this programme has been carrying since the audit.

## 3.2 One poll, shared, and nothing while the tab is hidden

`src/lib/bbjPoolFeed.ts` polls `fn_bbj_pool_for_club` once per **club** every
ten seconds and hands the figure to every surface that asked. Six subscribers
on one club now share one timer and one request.

- **A hidden tab costs nothing.** Realtime pushed to a backgrounded tab exactly
  as hard as to a visible one; a poll simply does not run. Coming back to the
  tab reads immediately rather than waiting out the interval.
- **It never publishes a figure it did not read.** A failed read leaves the
  last known jackpot on screen. Publishing 0 would tell every player at every
  table of that club that the jackpot is empty, and that is a lie about money.
- **The union rule stays server-side.** `fn_bbj_pool_for_club` already resolves
  it; the six surfaces had re-implemented that scope between them, and the
  wallet's version was wrong on a path nobody had walked (a non-member in a
  union club's lobby bound to that club's RETIRED pool row - a figure that was
  right at mount and then frozen for ever).

Ten seconds is derived, not picked: the pool moves every ~2.1s, so any interval
shows a figure that is behind by design. Ten keeps the felt within about five
hands of the truth for one request per club, against 40,219 pushed updates a
day per subscriber.

**One deliberate trade, written down:** the wallet widget's BACKUP bank figure
is no longer live to the second. The poll carries the main balance - the number
that moves on its own - and the backup bank only moves when an operator funds
the pool or moves chips between banks, which the widget's existing refresh
already covers.

## 3.3 What this table is playing for

A card room prints the jackpot on the placard, beside the stakes that fund it.
Until now the only way to see it at the felt was to open the jackpot widget,
even though the drop comes off every raked pot at that table.

`Playing For $X` on the masthead, in the club's gold, under the game style -
and rendered only when there IS one. A club with no jackpot prints nothing
rather than "Playing For $0.00", which would read as a promise of nothing on a
table that is quietly taking a drop.

## Pins that moved with their mechanism

Four existing tests guarded behaviour this phase deliberately replaced, and
CLAUDE.md 5.8 says the pin moves in the same commit rather than being deleted:

| pin                                           | where it lived                 | where it lives now                                                |
| --------------------------------------------- | ------------------------------ | ----------------------------------------------------------------- |
| a jackpot that paid always announces (3 pins) | TablePage's hit_count path     | `lib/bbjHitFeed`                                                  |
| the wallet binds the jackpot by pool id       | its own `bbj_pools` filter     | there is no subscription to mis-scope; it follows the shared feed |
| every display read leaves a trace             | TablePage reporter keys        | `bbjPoolFeed.read_failed`, `bbjHitFeed.*`                         |
| TablePage produces BBJ_HIT_GLOBAL 3 times     | two of those were the old path | 1 (the socket), plus the feed                                     |

The discarded-error ratchet also caught a real one in the new code on its first
run: the table-name lookup in `bbjHitFeed` read `{ data }` and dropped the
error. Bound and reported. The guard was right.

## What is NOT in this commit

`bbj_pools` is still in the Realtime publication. Dropping it is the point of
3.2, and it lands in a SEPARATE migration once this bundle is live - a player
whose tab still holds the previous bundle is still subscribing, and taking the
table out from under them before their client stops asking would freeze their
figure with no way to know it. The publication drop is the last step of this
phase, not the first.

## 3.4 The jackpot says when it crosses a number the club chose

A jackpot grows a few chips a hand and is hit about once a fortnight. Between
those two facts sits the only marketing the feature has ever needed: the moment
it passes a number that makes a player want to sit down. Nobody was told - a
player had to happen to be looking at a screen that showed the figure.

A club sets its own thresholds (`bbj_notify_thresholds`), every active member of
that club is told once when the pool crosses one, and the threshold re-arms
when the jackpot is next hit. Keyed by CLUB and not by pool: a union banks one
jackpot for all of its clubs, so pool-keyed thresholds would let one club's
operator decide when another club's members get told.

Three things it deliberately does not do:

- **It never runs on the money path.** The obvious implementation is a trigger
  on `bbj_pools` and it is the wrong one - that row is updated inside the
  transaction taking a player's rake, 40,219 times a day. A fan-out that can be
  slow, or fail, has no business in there. This is a periodic reader of a
  balance that has already been committed, and the worst a failure can do is
  delay a message.
- **It does not fire twice for one crossing.** A balance parked one chip above
  the number would otherwise notify every member every five minutes for a
  fortnight, and the first thing anybody would do is turn notifications off.
- **It does not skip the horses.** CLAUDE.md 10.5, and this is exactly the
  shape that law was written about - a fan-out where somebody reaches for
  `AND NOT is_horse` because "a horse has no browser". A horse is a member and
  is told, through the same path the payout notification already uses.

### The probe found a deadlock, on the first attempt

Run inside a self-aborting transaction against production (CLAUDE.md 11.5, an
error IS the success case), and it did not get as far as the assertions:

```
40P01: deadlock detected
while locking tuple (74,6) in relation "profiles"
SELECT 1 FROM ONLY public.profiles x WHERE id = $1 FOR KEY SHARE OF x
```

`notifications.user_id` references `profiles.id`, so a bulk insert of one row
per member takes a per-profile `FOR KEY SHARE` lock - up to 418 of them - **in
whatever order `club_members` happened to return**. Any concurrent writer
touching the same profiles in a different order deadlocks with it. That is not
a rare race on a live database: it happened on the first attempt, against
ordinary afternoon traffic.

Fixed at the cause rather than wrapped in a retry (10.11): the fan-out is
ordered by `user_id`, a total order every writer can agree on without
coordinating. The arbitrary order was never a decision anybody made; it was the
absence of one. Each threshold's work is now also caught separately, so one
club's failure cannot cost the others theirs - and because the crossing row
rolls back with the fan-out, a failed announcement leaves the threshold ARMED
rather than recorded as announced to nobody.

Re-probed, and rolled back:

```
418 members - balance 23,113.14
run 1: {"crossings": 1, "notified": 418, "failed": 0}
run 2: {"crossings": 0, "notified": 0,   "failed": 0}
title: "The Bad Beat Jackpot Just Passed $11,556.57"
```

Zero residue afterwards: no thresholds, no crossings, no notifications.

The grants on both new tables are named at birth rather than inherited - phase
2 shipped exactly that latent hazard on `bbj_unclaimed_shares` (Supabase grants
ALL to `anon` and `authenticated` on every new public table) and had to come
back for it a day later.
