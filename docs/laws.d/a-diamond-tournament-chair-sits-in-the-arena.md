# tests/a-diamond-tournament-chair-sits-in-the-arena.law.test.ts

Every live Diamond chair must be covered by Diamonds the arena holds for it.
The deferred seat guard checks that at commit: a tournament chair needs a
live funded entry held by the chair's own club (P0812), and a cash chair
needs its seat custody held by the same club. The arena holds all Diamond
custody, so a Diamond chair's club must be the arena.

The chair's club is not chosen by the door that writes the chair. The stamp
trigger sets it from fn_seat_club_for_user, and that resolver only knew club
memberships. The Diamond Arena has no membership rows by design (every
account with a profile is in it automatically), so the resolver gave a
Diamond chair the player's chip club, or no club at all. Every Diamond
tournament launch and every Spin seat would have been refused at commit. A
rolled-back rehearsal proved it on 2026-09-29: a plain Diamond MTT launched
through the real doors and was refused with P0812 at the seat assignment's
commit.

The law holds the fix in place: a table whose club plays in Diamonds seats
every player in that club. The check uses the same predicate the Diamond seat
guards use (clubs.asset = 'diamonds') and comes before any membership lookup.
The change to this chip function is made in place, with its live md5 pinned,
the anchor found exactly once and the reverse substitution proved. It also
proves, on the live chairs as it applies, that every chip chair keeps the
answer it had. It opens no switch and writes no row.
