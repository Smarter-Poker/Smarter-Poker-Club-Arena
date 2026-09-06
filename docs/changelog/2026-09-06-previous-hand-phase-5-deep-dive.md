# 2026-09-06 - Phase 5 deep dive: eleven defects, and the two ways they hid

Phase 5 (`66fa232a4`, live) shipped search, notes and a tracker-grade export.
The suite was green, `tsc` and prettier were clean, the bundle was confirmed in
the bytes players are served, and the RLS was probed against production. This
is what a deep dive found anyway.

Every one of the eleven fell into one of two blind spots, and both are worth
naming because they are not specific to this phase.

**A test pins a SHAPE, and a fabricated fact has the same shape as a real one.**
The header pin read
`/- \d{4}\/\d{2}\/\d{2} \d{1,2}:\d{2}:\d{2} ET$/` and passed on all 21 exported
hands. The corpus is anonymised and carries **no `played_at` at all**, so every
one of those stamps was the second the test ran. A regex cannot tell today from
the day the hand was dealt.

**An ABSENCE has nothing to assert against.** The table's panel searched with a
subject built without notes, so two branches of the shared predicate were dead
on that surface. There was no wrong value to catch - only a field nobody passed.

## The export: five more format defects, found by reading the output

The same method that found four before it shipped. Generate the corpus, read
the file.

1. **The summary carried positions the format has no grammar for.** PokerStars
   writes `(button)`, `(small blind)` and `(big blind)`, and for every other
   seat nothing. This wrote the felt's own labels straight through - `(utg)`,
   `(mp)`, `(co)`, `(hj)`, and `(sb)`/`(bb)` in our spelling. **101 of the
   corpus's summary lines**, on every one of the 21 exportable hands. The blinds
   are now read from who POSTED them, which is the record's own witness, and
   heads-up correctly writes `(button) (small blind)`.

2. **`showed and lost`, with the cards missing** - while the very same cards sat
   three lines above in the `*** SHOW DOWN ***` block. The format is
   `showed [9d Th 5c 6h Jc] and lost with pair`. A parser reads the old line as
   a showdown with an unknown holding, which is worse than no showdown at all,
   because the tracker records it as fact. Six lines in the corpus. A seat with
   no cards on record did not show, and now says `mucked`.

3. **The uncalled bet was returned AFTER the showdown.** It happens at the end
   of the last betting round: the last caller is short, the surplus goes back,
   and only then do the cards turn over. This engine files the return with stage
   `showdown` - the same fact Phase 4 found when the wire had no showdown slot -
   and the writer emitted that street after the `*** SHOW DOWN ***` header. Ten
   lines. A reader rebuilding the pot street by street had the wrong number in
   the middle at the moment of the showdown.

4. **A hand with no time was stamped with today.** `stamp()` fell back to
   `new Date()`, so a whole file could carry the same second - a session the
   player never sat in. It is a refusal now, with its reason, because a date is
   exactly the fiction this module's own docstring forbids: it looks precisely
   like data.

5. **The `ET` label sat on the exporter's own clock.** `getHours()` is the
   browser's hour whatever the label says, so the same hand exported in London
   and in Chicago carried two different times and neither was Eastern. Converted
   through `America/New_York` now, so the label is true.

**And the table size, which was a constant.** `9-max` on every hand. Measured
against the fleet, that is wrong for most of it: 64,759 three-handed tables,
63,808 nine-handed, 39,459 heads-up, plus 6, 7 and 8. Every heads-up and
three-handed hand imported as full ring, and a tracker's heads-up statistics are
a different game. `hand_history` does not carry the size, so
`fetchTableNames` - a query that already runs, once per page - now selects
`max_players` beside the name. A recycled table row yields nothing and the
writer falls back to the floor the seats themselves prove; it also refuses to
write a table SMALLER than its highest occupied seat, because `6-max` above a
`Seat 7:` line is a table that cannot exist.

## The notes: three ways a note could be lost without a word

A save is an UPSERT. It replaces whatever row is there. Every one of these is
the editor being unable to tell a fact from the absence of an answer.

- **It could never say "Saved".** The page hands the note back down after a save
  as a new object in a new Map; the reset effect was keyed on that object's
  IDENTITY, so it re-ran and set the state back to idle before the word could be
  read. The file's own header says its first principle is that it never says
  Saved until it is. It never said it at all. The same effect wiped text a
  player was mid-way through typing whenever the page's map changed for any
  other reason. Keyed on the hand and compared by CONTENT now.

- **A note the page had not loaded opened blank.** The map came from
  `listMine(limit = 500)` - the caller's newest N - so an older note was simply
  not in it: the hand read as un-noted, the Noted chip skipped it, a note search
  could not find words the player had written, and a save wrote over a note they
  could not see. Replaced with `listFor(handIds)`, which answers for exactly the
  hands on screen however old their notes are. The editor also asks for the row
  itself when the page had nothing, because it is the one thing here that can
  overwrite.

- **An unreadable row looked like an empty one.** `getOne` returned null both
  for "there is no note" and for "I could not find out". It returns `{ ok, note }`
  now, and a row that could not be read disables Save and says so, rather than
  offering to replace what may be there.

## The panel: it could search a tag and not show one

Its own placeholder said "Find A Hand: Number, Opponent Or Tag". It never loaded
a note, so a player typed a tag they had written themselves and was told **"No
Hands Here Match That Search"** - a confident wrong answer about their own data,
and exactly the drift between two surfaces that running ONE predicate exists to
prevent. Running one predicate is only half of it; both surfaces have to feed it
the same facts.

The panel now loads the viewer's notes for the hands it holds, and its expanded
hand carries the **same editor the archive has** - it could find a tagged hand
before it could show the tag, or let you write one without leaving the felt.
`useTableKeyboard` already declines to read the keyboard while a TEXTAREA has
it, so the table's hotkeys are unaffected.

## Two of the search's own terms had no control

The plan's Phase 5 line reads "hand number, opponent, tag or note text; won /
lost / showdown / all-in / big pots / noted; **variant and date range**".
`HandQuery` has understood `variant`, `from` and `to` from the first commit,
`handMatchesQuery` implements all three, and the pins cover them - and nothing
on the page rendered a control for the last two. A player could not reach them.
Two terms of a shipped predicate, unreachable, under a green suite: the same
blind spot as the panel's notes, which is that a test proves a function works
and says nothing about whether anybody can call it.

The archive now carries a game menu and two dates beside the search box. The
menu lists only the variants the loaded hands actually contain - a filter that
offers a game the player has not played can only disappoint - and it reads the
MODEL's own `gameVariant`, which is the field the predicate compares, rather
than the service row's upper-cased `game_type`.

## Also

- `filterBySubjects` was exported and called only by its own test. Both surfaces
  use it now, which is what it was written for and removes the open-coded copy
  each of them carried.
- `listMine` is gone rather than left as a method nothing calls.
- The archive's empty state said "Choose Another Filter" to a player who had
  typed a search - pointing them at the chips, which are not what hid the hand.
- The file's docstring sent the next agent to `tests/unit/pokerStarsExport.test.ts`,
  which does not exist.

## Not changed, and why

`fn_ca_hand_tags_ok` and `fn_ca_hand_notes_touch` have no pinned `search_path`.
Both are SECURITY INVOKER and reference only `pg_catalog` builtins, and 955 of
the 1,627 invoker functions in `public` are the same way - this is the
database's convention, not a Phase 5 anomaly. Pinning them means a migration,
and a migration means a ~28-second PostgREST schema reload against production
(CLAUDE.md section 2). Not worth it for a lint-grade item on two functions that
cannot be hijacked from where they are called. Written down so the next sweep
does not re-derive it.

## Verified

Live schema read back from production: `ca_hand_notes` carries four RLS policies
on `auth.uid()` with `WITH CHECK` on both writes, grants to `authenticated`
alone (`anon` has none), the three CHECK constraints, both indexes, the touch
trigger, and 0 rows. Migration `20260906092329` is recorded as applied.

Every new pin was run against the SHIPPED code first and fails there: 4 of the 6
note pins, the both-surfaces pin, and each of the format pins. A pin that passes
before the fix is not pinning anything.

`tests/unit/handSearchAndExport.test.ts` 27 -> 35;
`tests/unit/handNotesAreNeverLostQuietly.test.tsx` is new, 6 pins.
