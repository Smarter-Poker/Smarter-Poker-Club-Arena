# Action and Madness are one game per blind category, and the database holds them to it

2026-09-05. Migration
`supabase/migrations/20260906004318_action_and_madness_are_one_game_per_blind_category.sql`,
applied to production 2026-09-06 00:47:23 UTC. Law
`tests/actionAndMadnessAreOnePerBand.law.test.ts`.

## What Dan asked for

Verbatim:

> "WE NEED TO CONSOLIDATE 'ACTION' AND 'MADNESS' TO ONE GAME PER BLIND
> CATEGORY. ONE MICRO, ONE SMALL, ONE MID, AND ONE HIGH PER GAME TYPE.
> 'CLASSIC' SHOULD HAVE ALL THE GAME SAME STAKES IT HAS."

## What was there, read rather than assumed

Measured 2026-09-05 17:40 CDT. Action and Madness carried 31 games each,
every one of them created through the New Cash Game flow on 2026-09-04
between 16:14 and 16:51. Grouped by (club, style, variant, band) the micro
band held two or three games at once and every other band held one - because
0.10/0.25 and 0.25/0.50 are BOTH micro under the engine's own definition, and
nothing on the create path knew that. Twelve groups were duplicated.

Not one of the duplicates had a human seated. Every occupant was a horse, and
the migration asserts that before it changes anything: a human on a game this
would disable raises and aborts the whole transaction rather than moving the
board underneath somebody.

## The four bands were already in the code

`stakeBandForBigBlind` (`server/src/services/HorseBehavior.ts`) has always read
micro <= 0.5, low <= 2, mid <= 6, high above - exactly Dan's micro, small, mid,
high, with "small" spelled `low` in the source. The migration gives that rule
an IMMUTABLE SQL twin, `public.fn_cash_stake_band(numeric)`, so a unique index
can be built on it and the shape becomes something the schema enforces rather
than something an operator remembers.

The law test pins both sides against ONE table of big blinds - 0.02, 0.25, 0.5,
0.51, 1, 2, 2.01, 5, 6, 6.01, 10, 20, 50 - and it parses the CASE arms out of
the migration text rather than restating them, so a threshold edited in the SQL
without its twin fails there. That drift is not cosmetic: a 0.50 game the fleet
calls micro would occupy the database's `low` rung, and the duplicate the index
exists to refuse would be allowed straight back in.

## Which twelve were retired, and why those twelve

The survivor of each duplicated group is chosen in this order:

1. the band's canonical rung - micro 0.25/0.50, low 1.00/2.00, mid 2.00/5.00,
   high 5.00/10.00;
2. then the game with the most players seated right now;
3. then the one with the most live tables;
4. then the oldest.

So a player already sitting is never the reason a game is retired, and the
surviving ladder reads the same rung in every variant.

Every one of the twelve losers was a 0.10/0.25 game beaten by its 0.25/0.50
sibling on rung alone:

| style   | variants retired at 0.10/0.25    |
| ------- | -------------------------------- |
| action  | nlh, plo4, plo5, plo6, flh, flo8 |
| madness | nlh, plo4, plo5, plo6, flh, flo8 |

## What retiring means

`enabled = false` and `closed_at = now()`. Nothing else.

No table was closed by this migration and no chip moved. `fn_cash_cluster_tick`
already closes an EMPTY table belonging to a disabled game
(`table_closed_disabled`), the fleet does not seat a new horse on one
(`HorseDisabledGames`, 2026-09-05), and anybody seated finishes their hand,
stands up through the ordinary door and takes their stack with them. A retired
game keeps its id and its whole history; it simply stops being offered.

## Where it stands now

Enabled Action/Madness games went from 52 to 40. Per style: micro 9 (all of
them 0.25/0.50), low 7, mid 4, high 0.

Classic is untouched - 87 games across 55 keys and 13 stake levels. The index
is partial and its predicate names only `'action'` and `'madness'`; the law
asserts that `'classic'` does not appear in it.

## The gaps are Dan's call, and he made it

Most variants have no mid rung and none has a high rung. Dan decided on
2026-09-05, with those numbers in front of him, NOT to fill them: a ladder with
holes is a ladder, and inventing rungs nobody asked for is how the duplicates
happened in the first place. What the shape being law buys is that a rung added
later cannot be added twice.

## The first apply deadlocked

The first attempt put everything in one transaction, as the production DDL
policy (CLAUDE.md section 2) requires. It deadlocked against the cluster
controller: the tick writes `cash_games.last_tick_at` on about 120 rows every
five seconds, and a plain `CREATE UNIQUE INDEX` wants a lock those writes will
not give up. The transaction rolled back whole - nothing applied, nothing half
applied.

The file that shipped is therefore two steps. The function, the data change and
the trigger stay in ONE transaction, because they are what the schema-cache
reload rule is actually about. The index is built `CONCURRENTLY` afterwards,
outside any transaction, which takes no blocking lock and cannot deadlock with
the tick. It is created second on purpose: by the time it builds, the data it
must not reject has already been consolidated. If it ever fails it leaves an
INVALID index behind, and the migration's final assertion says so in one
sentence, naming the single statement to repeat.

## The sentence a human reads

The index is the guarantee. `zz_one_game_per_blind_category` is the sentence:
a BEFORE INSERT OR UPDATE trigger that names the game already holding the rung.

```
ONE_GAME_PER_BLIND_CATEGORY: this club already runs NLH 0.25/0.50 Action
(0.25/0.50) as its Action micro game. Close it before opening another.
```

with a HINT saying Classic is unrestricted. A bare unique-violation on an
expression index tells an operator nothing about which game to close.
