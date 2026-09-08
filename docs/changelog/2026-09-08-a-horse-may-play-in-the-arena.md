# Phase 5.4 (the provable part): a horse may play in the Diamond Arena

2026-09-08. `supabase/migrations/20260908114533_a_horse_may_play_in_the_arena.sql`.

Found while probing the arena doors: seating a horse in the Diamond Arena was
refused with `AUTOMATED_PLAYER_HOUSE_BOARD_ONLY: Automated Players Cannot Enter
A User-Created Club`.

The guard is right and stays - horses belong on house boards, not in somebody's
private club. What was wrong is how it decided what a house board IS:

```sql
SELECT p_club_id = ANY (ARRAY[ four hard-coded uuids ]);
```

**A list of uuids cannot know about a club that did not exist when it was
written.** The Diamond Arena is the platform's own room - the house board by
definition - and it was locked out of its own category by a constant. Ruling 16
says horses play in the arena and are funded from the house; CLAUDE.md 10.5 says
a horse is treated exactly as a human is. Today a human could join the arena and
a horse could not, which is an exclusion by design and the precise thing 10.5
forbids.

The rule is derived now: a house board is the platform club (`clubs.is_platform`)
or one of the four legacy boards that predate that flag. The list survives only
because those four are ordinary chip clubs that nothing marks; it is debt, named
as debt, and it deletes itself the day they carry a flag. The derived half needs
no maintenance.

## Proved, not assumed

There is no ordinary player-owned club on this database - five clubs exist: one
union, one platform, three legacy boards - so the negative case could not be
proved against existing data. The rolled-back probe therefore created a real
ordinary club and watched the guard refuse a horse, and creating it also
re-proved that a CHIP club still receives its 100,000 opening bank after the
5.1 guard. Horse joined the arena; ordinary club refused it; chip club got its
grant.

## What is deliberately not here

Rake to `ca_diamond_house` and guarantees from the house
(`fn_apply_prize_guarantee`, which knows no `house` bank type) are live CHIP
money paths used by real tournaments every hour. There is no diamond table or
tournament to exercise a diamond branch against, so anything written there could
only be reasoned about, never probed - an unprovable branch in a money path is
what CLAUDE.md 10.86 is about. They land with the first table, against something
measurable. The platform club's `bbj_pools` row is gated by the roadmap itself
on chip roadmap 4.2 and 4.3, which have not landed.
