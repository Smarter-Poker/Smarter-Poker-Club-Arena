# A Diamond Figure Is Real Or It Is Unknown

Status: Client Fixes Merged. One Migration Is Written, Proven And Handed To The
Owner, Not Applied. `cash_games_enabled` And `tournaments_enabled` Remain
False.

Two defects in the Diamond Arena, both of the same kind: a number on the screen
that nobody had measured. Neither was a gap waiting to be built. Both were
surfaces confidently reporting something untrue.

## One: The Active Count Could Only Ever Read Zero

The Diamond Arena card on the home carousel has an ACTIVE tab. It read 0. It
was always going to read 0.

The figure came from `fn_batch_club_realtime_active_counts`, which reaches its
seats like this:

```sql
JOIN public.club_members cm ON cm.club_id = requested.club_id
 AND (cm.status IS NULL OR cm.status IN ('active','approved'))
JOIN public.table_seats ts ON ts.user_id = cm.user_id
```

That is exactly right for a chip club, where membership is the roster. The
Diamond Arena is not a chip club. Membership there is an entitlement: the arena
holds ONE `club_members` row and its status is `automatic`. The join matched
nobody, so the count was not a measurement that happened to come back zero. It
was an arithmetic certainty, for every player, on every load, however many
people were sitting down.

Read off production on 2026-09-20, all three at once:

- `club_members` for the arena: one row, status `automatic`;
- `clubs.member_count`: 0, so the `Math.min(activePlayers, memberCount)` clamp
  above it was clamping against a ceiling that means nothing for a club nobody
  is a row in;
- the live RPC: `active=0, cash=0, event=0` - while the arena carried
  **17 live tables**.

The lobby printed the same zero for a different reason. `get_club_home` returns
early for a diamonds arena at its line 26 with
`{found, access_only, arena_context}` and carries no `players_playing` key at
all, so `ClubHomePage` left the figure null and `ClubIdentityCard` rendered
null as the string `0`.

And `lobbyFigureCache` then filed that zero as "the last known figure" and
served it back on the next visit, so a later read that genuinely could not
answer found a confident zero already waiting for it.

All three fold "I could not tell" into "nobody is playing". CLAUDE.md 10.86
rule 1 forbids that by name.

### What Changed

The count now comes from live seats. `get_club_players_playing` counts
`DISTINCT` users holding a seat at the tables a lobby can see, joins no
`club_members` at all, and returns NULL for a club it cannot resolve - so it
already answers an entitlement arena honestly, and it already distinguishes
"nobody" from "could not tell". It is the same RPC the lobby's realtime refresh
has used for chip clubs since September. What was missing for the arena was
anybody asking it.

**This needed no migration.** The function, its grants (`anon`,
`authenticated`) and the public read policy on `table_seats` were all verified
read-only on 2026-09-20. The figure a player sees is a real one from today.

A count now has three answers instead of two, defined once in
`src/lib/countFigure.ts`:

|                 | means                 | prints        |
| --------------- | --------------------- | ------------- |
| a number        | the figure            | itself        |
| null / absent   | not yet asked         | `0`           |
| `COUNT_UNKNOWN` | asked, could not tell | `Unavailable` |

The middle row is deliberate. Dan's lobby rule is "THEY SHOULD HAVE 0'S UNTIL
THE CARD LOADS", and a first paint has not failed at anything. The distinction
between "still waiting" and "already refused" is the caller's to make and is
never inferred from a null, because a component that guesses between those two
is the defect being replaced.

`Unavailable` is the word the freeroll clock beside it already uses and the
word `ArenaWalletRow` uses for a balance it could not fetch. Unknown has one
name across the lobby, so a player learns it once.

The figure cache no longer stores a zero, and no longer serves one. Both
halves were necessary: refusing it on the way in does nothing for the browsers
that already have `{"arena:diamond":{"active":"0"}}` sitting in localStorage,
which is every browser that has opened the carousel. A card that knows the
figure is zero still prints `0` - that is the empty-cache fallback, unchanged -
but it prints it because nothing is cached, not because the cache claims to
have known it.

The arena is also no longer clamped against `member_count`, and no longer
gated on having one.

## Two: Diamond Hands Will Contaminate Chip Statistics

This one has not happened yet. It is scheduled to happen on the day the cash
switch opens.

`fn_project_hand_side_effects_after_post_commit_20260908` runs four projections
after a hand commits. Projections 1, 2 and 3 each gate on `v_diamond` and keep
Diamond hands out of club-member state, legacy `player_stats` and positional
profit. Projection 3 says why in its own comment: "Positional profit has no
asset dimension."

Projection 4 has no gate. It writes `ca_hand_player_idx` and
`ca_hand_player_stat`, and neither table carries a club or an asset column -
`ca_hand_player_stat` has 28 columns and not one of them records which currency
any of it is in. Every reader over it takes only `p_user`.

So the first Diamond cash hand ever played adds its `profit`, `won_amt`, `net`
and `rake_paid` to that player's chip totals. Not a display bug: the
distinction is lost at WRITE time, so no later read and no later repair can
take the two apart again.

### What Changed, And What Did Not

The repair has two halves and only one of them can ship in a pull request.

**Shipped.** `src/services/statsScope.ts` makes the asset dimension explicit on
every stats read in the client. A read names the asset it is about; a scope the
database cannot yet separate is refused outright rather than answered with a
chip total wearing a Diamond label. A chip read calls the unscoped RPC and that
is exact rather than approximate - `ca_hand_player_stat` holds only chip rows,
because Diamond cash has never been open, so the unscoped answer IS the chip
answer today.

That is a fact with an expiry date, so it has been given a reader.
`tests/chip-and-diamond-figures-never-sum.law.test.ts` pins
`STATS_RPCS_ARE_SCOPED` to the newest definition of the projection: land the
migration without flipping the client and it goes red; flip the client without
the migration and it goes red. Neither half can land alone and the figures
cannot go quietly wrong in between.

**Handed over, not applied.** The migration is written, proven and left on a
branch that was never pushed. The full text, the exact predicate for each of
the seven readers, and the reason it is split that way are in
`docs/runbooks/diamond-stats-asset-dimension-2026-09-20.md`.

It turned out smaller than it looked. Five of the seven readers never touch
`ca_hand_player_stat` at all - they read `ca_hand_facts` and
`ca_hand_transfers`, and **both already carry `club_id`**, so they need a
predicate and no new column. Only `ca_player_stats_overview_v2` and
`ca_player_stats_pulse` read the two tables that lack the dimension.

It labels rather than skips. Projections 1 to 3 drop Diamond hands because
their aggregates have nowhere to put an asset; this table is per-hand and can
carry one, so a Diamond player keeps a full statistical history instead of
having it thrown away to protect a chip total.

## How It Was Verified

Every claim about the database above was read from production read-only: the
RPC definitions via `pg_get_functiondef`, the arena's `club_members` rows,
`clubs.member_count`, the live counts, `ca_hand_player_stat`'s columns, all
seven reader signatures, the grants and the `table_seats` policy.

The SQL was proven on an isolated PostgreSQL 17.11 cluster that
`tests/sql/run-diamond-stats-asset-dimension.py` starts in a temporary
directory and throws away. It asserts the defect before it asserts the fix -
one chip hand and one Diamond hand summing to a single 257.00 that nothing can
take apart - because a regression that only ever passes proves nothing about
the bug it claims to fix.

That fixture earned its keep immediately. It caught a real flaw in the
migration as first written: `CREATE OR REPLACE FUNCTION` with an extra
defaulted parameter does not replace a function, it adds an **overload**, and
every existing one-argument call then fails with "function is not unique".
Applied as written, that would have taken every stats panel in the app down the
moment the migration committed, with the client still passing the old argument
list. The old signature is dropped first now, and the runbook says so in its
own heading.

## Laws Added

- `tests/a-diamond-figure-is-real-or-it-is-unknown.law.test.ts` - no Diamond
  count is derived from `club_members`, the count comes from a live-seat read,
  an unreadable figure renders as an unknown rather than a zero, and the figure
  cache neither stores nor serves a zero as something it knew.
- `tests/chip-and-diamond-figures-never-sum.law.test.ts` - every stats read
  carries a scope, a scope the database cannot separate is refused, and the
  client flag and the projection are pinned to each other.
