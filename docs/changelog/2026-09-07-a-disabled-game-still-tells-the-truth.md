# A disabled game still tells the truth about itself

2026-09-07, found while answering "is the feeder functionality 100% complete".
The answer turned out to be no, and this was the thing standing in the way.

## The check that found it, and the check that missed it

An earlier pass of this audit asked whether any cluster had gone stale, using
`WHERE state = 'open'`. `cash_games.state` has never held that value - it is
`live` or `dormant` - so the query matched nothing and reported a clean zero.
A wrong literal is a silent pass, which is the same failure shape as everything
else found today.

Asking the right question found three games in `state = 'live'`, `enabled`
false, with **zero non-closed tables and zero seated players**, last ticked
2026-09-06 at 00:52, 01:27 and 02:31. Stranded for thirty-eight hours.

## Why they could never recover

Section 7 of `fn_cash_cluster_tick` works out whether a game is live or dormant
from whether anybody is sitting in it, and then writes it down only if the game
is enabled:

```sql
v_new_state := CASE WHEN v_seated_total = 0 AND ... THEN 'dormant' ELSE 'live' END;
IF g.enabled AND g.state IS DISTINCT FROM v_new_state THEN
```

`enabled` is the host's switch for whether a game may **open tables**. It has
nothing to do with whether `state` is accurate. Coupling them means a game
disabled while live can never be corrected - and then the selector closes the
door behind it:

```sql
WHERE g.must_move AND (g.enabled OR EXISTS (non-closed table))
```

Once the last table closes, the game is neither enabled nor holding a table, so
it is not admitted at all. **The cleanup needs the tick, and the tick is exactly
what it can no longer get.**

## How bad, honestly

Not player-facing. `get_club_home` builds its lobby rows FROM `tables` and
collapses a cluster to its Main 1 row, so a game with no tables paints nothing.
Nobody saw them.

What they are is three rows that say `live` and are not, sitting there for the
next person who reads `cash_games.state` and believes it. That person was very
nearly me, twice in one afternoon.

## The fix

The state write is no longer gated on `enabled`. A disabled game with nobody
seated goes dormant on its next tick - which happens while it still has tables
and is therefore still selectable, so the dead end never forms. A disabled game
that somehow still holds players stays `live`, truthfully, until they leave. The
selector needed no change.

The three already stranded are corrected in the same migration, and it asserts
that none is left. After: 0 stranded, 0 clusters live without a Main 1, states
73 live / 77 dormant.

## The pattern this makes five of, today

One flag governing two unrelated things, with the truth as the casualty:

- `loading` on Club Data, raised by a foreground read and cleared by whoever was
  newest, so a background poll stranded it;
- `playersLoading`, the same shape one tab over;
- the event-loop histogram, read by two samplers where only one held the guard;
- `seat_change_used_at`, spent by the request and returned by only one of the
  two paths that cancel it;
- and now `state`, correct in the tick's head and forbidden to reach the row.

Every one of them was a flag with two writers and one owner, and in every case
the reader was told something false with complete confidence.

## Files

- `supabase/migrations/20260907173251_a_disabled_game_still_tells_the_truth_about_itself.sql`
  (applied and recorded on production, version `20260907173251`)
