# server/src/services/aDeadReadIsNotAnEmptyRoom.law.test.ts

The HorseSessionRotator's one read of the room embeds `tables` from
`table_seats`, and on 2026-09-09 two migrations added composite foreign keys
between those tables, so PostgREST refused the unqualified embed (PGRST201,
HTTP 300) and every page failed into a bare `return`. The whole departure side
of the fleet - session ends, the lone stand, tournament leaves, seat changes,
top-ups, breaks, and the human release rule that is the only thing which opens
a seat for a waiting person - stopped for three and a half hours with nothing
logged. The law pins the embed naming its foreign key by name, so a migration
in another lane can never make it ambiguous again, and pins the failed read
being reported and warned about before the pass is declined (CLAUDE.md 10.86:
"I could not tell" is its own outcome). It also pins the seat-change memo
being pruned against the room each pass, because the door's budget is per stay
and a memo keyed on the game alone denied a rejoining horse a button a human
gets (10.5).
