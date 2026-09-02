# 2026-09-02 - The seeder runs every thirty seconds, not every hour

**Dan's question:** "why do we only have a hand full of games running in the
midway union and zero cash games running in deep stack society?"

Deep Stack's "zero" was the lobby truncating live tables away behind 1,003
empty ones (#2696). Midway's "handful" was real, and it was not a shortage of
horses or of tables: 392 cash-lane horses and 576 seats, with 476 of the seats
empty and only 22 horse seatings an hour. Three defects in `HorseFleetManager`,
all measured on the live engine (`docker logs club-arena-engine`), compounded:

## 1. The 30-second cycle was taking 47 minutes

```
18:08:35 [HorseFleet] Seeding cycle: 1000 tables found, 1000 total horses.
18:55:53 [HorseFleet] Seated 80 horses across tables
19:00:46 [HorseFleet] Seeding cycle: 1000 tables found ...   (still running at 19:50)
```

`pruneHorseWaitlist` ran once PER TABLE inside the seeding loop - a SELECT on
`table_waitlist` for each of 1,131 open cash tables, sequentially, on a
database answering in seconds (1,110 `supabase_timeout` in two hours). The
`seeding` guard silently dropped every 30-second tick that arrived while the
previous cycle ran, so nothing said the cadence had collapsed. Between cycles
the floor only drained: the session rotator kept standing horses up and
nothing sat them back down, which is exactly the decay the hand-packing
migrations (`midway_pack_the_micro_floor_*`, `the_micro_floor_refills_after_the_rotator_drains_it`)
were written to paper over.

Now: one floor-wide read of live waitlist rows and one batched UPDATE before
the loop (horses do not queue at all any more, so "prune to target" was already
"clear every horse row"). The cycle stamps its own duration and the number of
ticks it cost, and warns when either is wrong.

## 2. Every union horse was sized a zero buy-in

`computeHorseBuyIn` and both bankroll gates keyed the roll on
`${table.club_id}:${horse}`. For a Midway Union table `table.club_id` is the
union's own club row (`fade0000-...`), and no wallet is ever debited there -
`fn_seat_club_for_user` pays a union seat from a membership in one of the
union's MEMBER clubs (`union_clubs`: Club JAQK, SHARK CLUB). 261 of the 584
Midway horses hold no row in the union club at all, and no Deep Stack horse
does, so for all of them the roll read as `?? 0`, `bankrollBuyIn` capped to
zero, `seat_refused_share_below_min` fired, and the seat they had been picked
for was skipped for the cycle. The log said so, in the only way it could:

```
[HorseFleet] bankroll gate skipped for 84954 horse/table pairs - no membership row for that club.
```

Now the roll, the buy-in and the aggregate-exposure check are all keyed on the
club that will actually PAY (`resolveSeatClub`, the engine's copy of
`fn_seat_club_for_user`: a seat already held in the same union wins, else a
stable pick among qualifying memberships), and that club is SENT to
`atomic_table_buyin` as `p_club_id` so the database debits the wallet the
engine reasoned about rather than hashing its own choice. The seat read now
carries `club_id` and `joined_at` for the held-seat rule, and the bankroll
loader also loads the union member clubs, which own no tables of their own
and so were never loaded.

## 3. Candidates were drawn from the whole fleet

Dan, 2026-09-02, verbatim: "FREE THEM TO PLAY OPENLY INSIDE THE DEEP STACK
SOCIETY ONLY. THEY HAVE NO AFFILIATION OR ARE A PART OF THE MIDWAY UNION."

The candidate filter never asked whether a horse could sit at a table's club.
Deep Stack horses were candidates for Midway seats and Midway horses for Deep
Stack seats; each such pick consumed one of the table's seat slots for the
cycle and then died at the zero buy-in above. A horse is now a candidate only
where a membership of its own can pay (`union_clubs` read fresh each cycle,
fail-closed like the other reads; an unreadable membership map fails OPEN and
lets the database decide, exactly as the bankroll gate does). The excluded
pairs are counted and logged.

## Not changed

- `MAX_TABLES_PER_CONFIG` and the `[SHARK, JAQK]` round-robin. Table supply
  was not the constraint - 476 empty seats were.
- Deep Stack's 1,003 empty cash tables. Nothing maintains them (unique names,
  so surplus retirement never applies); whether they stay is Dan's call.
- Membership status: only `active` / `approved` rows are read, which is what
  `fn_seat_club_for_user` pays from. Every horse membership is one of the two.

## Tests

`HorseBankrollGateClubs.test.ts` gains nine pins, all of which fail against the
previous source and pass against this one (verified by swapping the file);
`HorseAggregateExposure.test.ts` widens its seat-select pin to "reads stack"
rather than an exact column list. Server suite 327 files / 3,644 tests green,
`tsc --noEmit` exit 0.

## Verify after deploy (DB-visible, never the health endpoint)

```sql
select t.club_id, count(*) from table_seats s join tables t on t.id=s.table_id
 join profiles p on p.id=s.user_id
 where s.joined_at > now()-interval '30 min' and t.tournament_id is null and p.is_horse
 group by 1;
```

Midway (`fade0000-...`) was 22/hour before. The engine log should show
`[HorseFleet] Seeding cycle took Ns` every ~30-60s and no `84954 horse/table
pairs` line.
