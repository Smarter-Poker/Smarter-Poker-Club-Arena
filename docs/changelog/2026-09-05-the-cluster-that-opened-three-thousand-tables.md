# The cluster that opened three thousand tables, and the fleet that could not fill them

2026-09-05. Dan asked why the floor was not full and why horses were not
playing four tables. Three separate things, one of them a live runaway.

## 1. A cluster was creating a table every five seconds

`NLH 0.05/0.10 Classic` (cluster `37ac7634`) held **2,994 tables** by 15:29
UTC, created between 13:01 and 15:29 - 26,721 seats holding 50 players.

Two facts had to be true together:

1. `fn_cash_cluster_tick` rule R3 ("an enabled game always has Main 1 open")
   looked up `main_index = 1 ... ORDER BY created_at LIMIT 1`, with no
   preference for a row that is alive.
2. The renumber pass at the bottom of the same function walks `v_census`, and
   `fn_cash_cluster_census` EXCLUDES closed tables - so a table that closed
   holding `main_index = 1` keeps it forever, invisible to the only pass that
   would take it away.

The cluster held TWO rows at index 1: a corpse from 21:38 the previous evening
and the live game from 22:08. R3 read the corpse, saw `lifecycle = 'closed'`,
and opened a replacement; the renumber gave that replacement the next free
index (2,986 by the end), never 1. R3 sits ABOVE the OPEN rule's
`v_live_tables < v_table_cap` check, so the nine-table cap never applied.

**It cost more than disk.** `fn_cash_cluster_census` builds its array with two
correlated subqueries per table, inside a tick holding `FOR UPDATE` on the game
row. At three thousand tables `atomic_table_buyin` and the engine's
`ClusterController` wake RPC started returning 57014 against the 8s
service_role ceiling - 241 wake failures in thirty minutes. **The runaway is
therefore also why horses could not buy in anywhere on the floor.**

Stopped at 15:29 UTC by retiring the corpse (`is_deleted = true` through the
sanctioned `app.managed_game_lifecycle` path, inside a `DO` block asserting
zero seats, zero chips, and a surviving live Main 1). Zero tables created in
the five minutes after; total frozen at 3,002.

Made structural by `20260905155032`: a `BEFORE` trigger releases `main_index`
from any cluster table that closes or is deleted, and a second refuses an
insert past the cluster's own `cap_mains + 1 (+1) + 2` ceiling - returning
NULL rather than raising, because a raise inside the tick would abort a
transaction that also carries seat moves and roster writes. The invariant is
enforced on the DATA, not inside a 33KB function that six migrations touched
in one day. `tests/a-closed-table-owns-no-index.law.test.ts`.

**Cleanup**: 2,985 empty husks closed in one transaction. The per-row
`fn_on_table_status_change` calls `fn_refresh_club_activity_counts` once per
table, which is ten closures a second against a 3,000-table cluster, so the
transaction suspended user triggers (`session_replication_role = 'replica'`)
over rows asserted seat-free and refreshed the club counts once at the end.
Result: 2,994 -> 16 tables, all 49 players and 621.53 chips still seated, zero
seats on a closed table.

## 2. The 2/5 tier had zero eligible horses, and always would

16 cash tables at big blind 5.00, 99 seats, **0 seated - not one, ever**. That
is every `No available horses ... band mid` line in the log.
`stable_hand_membership_tags.preferred_stakes` tops out at **2.00**; the
tagger never emits 5. Left open for Dan: either the tagger gains a 5 band or
those tables are retired. Nothing else can fill them.

## 3. Why nobody was playing four tables

Measured: of 364 seated horses, **270 held exactly one table**, 76 two, 17
three, and ONE four.

The seeding weight written for Dan's 2026-09-02 instruction was working and
had nothing to work with. `MAX_TABLES_BY_PERSONA` derived the ceiling from the
cash persona (grinder 4, regular 3, mixer 2, night_owl 2, weekend_heavy 3) and
`MAX_TABLES_TOURNEY_ONLY` pinned 473 of 1,000 horses at ONE. A ceiling and a
target that disagree are not two settings; they are a bug with a config file
in front of it.

Dan, 2026-09-05: _"EVERY HORSE SHOULD 100% BE ABLE TO PLAY 4 TABLES AT ONCE ...
100% OF THEM SHOULD BE PLAYING A MINIMUM OF 2 AT A TIME 33% PLAYING 3 AT A TIME
AND 33% PLAYING 4 AT A TIME."_

Now one deterministic mix over the whole fleet - 34% two, 33% three, 33% four -
applied to tourney-only horses identically, with the floor enforced in the
tagger, in the tag reader (`tagMaxTables`), and in the schema
(`max_tables >= 2`, and `sh_tourney_only_one_table` dropped). The seeding
weight gained a tier so a horse short of the FLOOR outranks one merely short
of its own ceiling. `seatsPerHorseBand` moved with it (day 2.0-3.6, night
2.0-3.0) or `seats_per_horse_out_of_band` would alert on a floor finally doing
as it was told.

**The trap inside the fix, caught after one retag.** The first version
allocated the ceiling over `tagOrder` - the same ordering `assignTags` uses for
MODE. Fleet-wide the split was a perfect 34/33/33 and the summary query looked
finished; underneath, ALL 473 cash-only horses had 2, ALL 410 tourney horses
had 3, and every horse allowed 4 was mode `both`. The cash floor drew
exclusively from the lowest ceilings. The load now draws from its own digest.
Live after the retag: 2/3/4 at 159/160/154 for cash, 169/149/155 for tourney,
208/212/214 for both. `tests/every-horse-plays-at-least-two-tables.law.test.ts`.

## What is still Dan's

**The occupancy curve caps BODIES per host by hour of day**, and it is his own
(OPORD section 11; he personally cut the night cap from 10% to 5% on
2026-09-04). At 10:44 Chicago the caps were 119 and 83 - **202 bodies out of
964 eligible**. At 18:00 they would be 385. A thin mid-morning floor is by
design, and no amount of seating logic will change it. What this PR changes is
how many SEATS those capped bodies hold: ~1.31 each before, ~3 after, so the
same curve now fills roughly 600 seats instead of 477.
