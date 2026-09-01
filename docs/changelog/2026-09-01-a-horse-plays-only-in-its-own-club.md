# 2026-09-01 — A horse plays only in the club it belongs to

Dan: _"IT CAN NOT, WANDER... THEY ARE LIMITED TO ONLY THE CLUB THEY ARE APART OF!"_

## What was actually broken, and what was not

**Cash was already safe**, and not by anything in this file. `atomic_table_buyin`
debits `club_members.chip_balance`, so a horse with no membership row in the
table's club cannot buy in at all. Measured on the live floor at the time of
this change: 94 seated horses, **zero** of them in a club they were not a
member of.

**Tournaments were not.** `registerHorses` selected every `is_horse` profile on
the platform and never looked at the club hosting the tournament, so any horse
could be entered into any club's event.

Measured: a 416-account population built for the standalone club Deep Stack
Society took **729 seats in Midway Union's tournaments within seven hours** —
327 in running freerolls, plus paid entries at 1, 2, 3, 5, 10, 15, 20, 25, 50
and 100 chips — while never being a member of that club. A standalone club's
population wandering into a union's schedule is exactly the isolation this
breaks, and paid entries mean chips followed them out.

## The rule

Membership is the rule a human is already held to: you cannot enter a club's
tournament without joining the club. The fleet is now held to the same one.
The tournament's own `club_id` is read, that club's members are paged in, and a
non-member is dropped from the candidate pool.

## Fails open, like every other gate here

An unreadable membership page leaves `clubMemberIds` null and the pool
untouched. A partial read is not an empty club, and refusing to register on a
failed read would silently starve every event on the platform — the shape of the
bug that emptied the cash floor for forty minutes on 2026-08-31.

Checked before shipping that no board is starved by the rule: Shark holds 584
horse members, JAQK 580, Midway 323, Deep Stack 416 — every one of them more
than an event needs.

## Pins

`server/src/services/HorsesStayInTheirClub.test.ts`, 5 assertions. Four
mutations applied and observed failing: the guard counting without dropping;
failing closed on an incomplete read; the filter removed entirely; the
membership read unpaged so a large club truncates.

server 3377/301 green, client 10936/789 green, both tsc clean.
