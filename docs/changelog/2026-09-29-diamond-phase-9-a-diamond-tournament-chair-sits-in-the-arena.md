# Diamond Phase 9: A Diamond Tournament Chair Sits In The Arena

September 29, 2026. Phase 9 of the Diamond Arena build programme. The satellites rehearsal noticed that every Diamond tournament chair it wrote carried a club other than the Diamond Arena. This change proves that was a real launch blocker and removes it. Both arena switches stay closed. No real entry was written against a real wallet. Nothing is priced.

## What Was Wrong

When a transaction commits, the deferred seat guard (`zzz_diamond_seat_keeps_custody`) checks every live Diamond chair against the Diamonds held for it, and it looks those up under the chair's own club. A tournament chair needs a live funded entry (P0812). A cash chair needs its seat custody. The arena holds all Diamond custody.

The chair's club is set by the stamp trigger from `fn_seat_club_for_user`, which only knew club memberships. The Diamond Arena has no membership rows by design, because every player is in it automatically. So the resolver gave a Diamond chair the player's chip club, or no club at all:

- A player with no chip club (349 of 361 player accounts today) got no club on a launch chair or a seat-first chair. Every Diamond tournament launch, every Diamond Spin seat and every heads-up seat-first seat would have been refused at commit with P0812.
- A player with a chip club (12 of 361) got that chip club on every Diamond chair, cash included. The cash chair would have been refused at commit too.

The before-insert guard compares against the table's club, so it passed. Only the commit-time guard compares against the chair's club. A rolled-back rehearsal never reaches commit, which is why no Phase 8 or Phase 9 rehearsal saw this.

The proof: a rolled-back rehearsal launched a plain Diamond MTT through the real doors and forced the commit after the first seat assignment. The chair had no club, its entry was held by the arena, and the commit was refused with "A Diamond Tournament Seat Must Hold Its Funded Entry" (P0812).

## The Database

Migration `a_diamond_tournament_chair_sits_in_the_arena` (applied as `20260929180000`; the recorded text is the repo file):

- `fn_seat_club_for_user` now gives the table's own club for a table whose club plays in Diamonds (`clubs.asset = 'diamonds'`, the same test the Diamond seat guards use). This is checked before any membership lookup. Every door that writes a Diamond chair gets its club from this resolver, either directly or through the stamp trigger: the launch seat assignment, late registration and a satellite seat into a running target, the seat-first door (Spins and heads-up sit-and-go), table balancing, the rebuy, the multi-day stage seat and the Diamond cash door. A Diamond chair now sits in the arena, which is the club its Diamonds are held by.
- The change to this chip function is made in place: the live md5 is pinned, the anchor is found exactly once and the reverse substitution is proved. The resolver keeps its owner, grants, settings and security. Its md5 is now `821ddcdf4478a6cc6355499fd15e2b32`.
- As it applied, the migration kept a session-only copy of the old text and compared the old and new answers for every live chair in one read (1,569 chairs, none of them Diamond). Every chip chair kept its answer.
- It asserts that no seat has ever been written at a Diamond table, so there was nothing to repair. It also asserts that both switches are still closed, the Diamond identity is whole and no watched guard moved.

## The Rehearsal

The migration and its fixture ran as one rolled-back transaction on production. Every deferred constraint was forced at each point where a real transaction would commit:

- A plain Diamond MTT: three entries and the engine's launch protocol. All 3 chairs were in the arena with a live entry. The old resolver would have given all 3 no club.
- A heads-up Diamond sit-and-go, seat-first: 2 chairs bought through the seat-first door, both in the arena.
- A Diamond Spin: 3 seat-first chairs, the draw and the launch. All 3 chairs were in the arena.
- A Diamond satellite settled while its Diamond target was running: 2 qualifiers were dealt into the running target, and all 5 target chairs were in the arena.
- Read only: a real player with a chip club resolves to the arena at a Diamond table (the old resolver gave their chip club). All 1,446 live chip chairs kept their answer after the rehearsal's writes. The Diamond identity did not move.

A chip tournament was not launched in the rehearsal. Every chip entry needs a real chip wallet, the only standalone chip club is the busy house board, and a union club would have put the rehearsal on live union accounting rows. The chip side is proved instead by the pinned substitution and by the old-against-new comparison over every live chip chair, both in the rehearsal and at apply.

Law: a-diamond-tournament-chair-sits-in-the-arena.
