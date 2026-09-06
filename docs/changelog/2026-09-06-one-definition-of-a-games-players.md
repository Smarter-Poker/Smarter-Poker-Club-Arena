# One definition of a game's players and tables (2026-09-06)

Open on the Table Stakes handoff since 2026-09-05, with the honest note that
the three derivations "agree today only because I repaired the population that
made them differ". This makes them agree by construction.

## The three answers

`fn_cash_cluster_census` is authoritative. It is what `fn_cash_cluster_tick`
reads to decide what the game IS: how many tables it has, which one is Main 1,
when a feeder opens and when one breaks. A read path that disagrees with it is
showing the player a different game from the one the controller is running.

|                          | `is_deleted` | `status IN (...)` | `lifecycle <> 'closed'` |
| ------------------------ | ------------ | ----------------- | ----------------------- |
| `fn_cash_cluster_census` | yes          | yes               | yes                     |
| `get_club_home` players  | **no**       | **no**            | yes                     |
| `get_club_home` tables   | **no**       | yes               | yes                     |
| `fn_cash_game_lobby`     | yes          | **no**            | yes                     |

The worst is `get_club_home`, which disagreed **with itself**: its player count
filtered neither `is_deleted` nor `status`, while its table count filtered
`status`. A seat on a table that this same function did not count as a table
was still counted as a player - so the lobby could read "7 players, 1 table"
for a game whose second table had just been closed or deleted. That is the
shape of Dan's original complaint: fifty players showing, one person sitting.

## What changed

All three carry the census predicate verbatim:

```sql
coalesce(is_deleted, false) = false
AND status IN ('waiting', 'running', 'active')
AND lifecycle <> 'closed'
```

Both functions were re-emitted from their **live** bodies, read from
`pg_get_functiondef` at 16:31 CDT, as the `fn_cash_clusters_tick_all` header
asks - so this cannot silently revert somebody else's in-flight work. Nothing
else in either function is touched.

## Proof

Rolled back first (psql, `BEGIN ... ROLLBACK`), comparing every enabled game
before and after:

```
games  players_changed  tables_changed  old_total  new_total
  108                0               0        343        343
```

**Nothing changed, and that is the point.** The counts were correct today
because the board is currently clean; the migration removes the way they can
diverge tomorrow. The lobby RPC was smoke-tested in the same transaction and
still returns an object.

The migration also asserts, at apply time and over **every** enabled game, that
the club-home table count equals `array_length(fn_cash_cluster_census(...))`,
so it aborts rather than shipping if the two ever disagree again.

## Pinned

`tests/one-definition-of-a-games-players.law.test.ts` pins the predicate inside
each re-emitted function body - windows bounded by the `$function$` delimiters,
never by the file (the header prose and the VERIFY block mention the same
strings) and never by a byte count.
