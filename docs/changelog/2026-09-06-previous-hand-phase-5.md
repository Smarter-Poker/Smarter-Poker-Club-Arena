# 2026-09-06 - Previous Hand build plan, Phase 5 of 7: find it, keep it, take it with you

Plan: `docs/PREVIOUS-HAND-REPLAYER-BUILD-PLAN.md`. Builds on Phase 4
(`30702e1af` and `a386f758b`, live): one replayer everywhere, and a share link
that carries the whole hand.

Three things a hand history has to do that this one could not: let you FIND a
hand, let you KEEP what you thought about it, and let you TAKE it somewhere
else.

## Find it

The archive had four chips and no search. The table's panel had neither, so
the only way to reach a hand you remembered was to scroll.

Both surfaces now run ONE predicate, `src/lib/handSearch.ts`, over a subject
built from the model. That is deliberate and it is the same argument as the one
reconstruction: two surfaces that each decide what "went to showdown" means
will eventually disagree, and the player is the one who finds out. Every term is
defined once:

| term       | what it means, once                                          |
| ---------- | ------------------------------------------------------------ |
| showdown   | the model has showdown rows - cards were turned over         |
| all-in     | a row with the `all_in` verb belongs to the VIEWER           |
| won / lost | the viewer's own NET, not the pot                            |
| big pot    | at least 100 big blinds, which is what the chip always meant |

The free-text box matches the hand number (with or without a `#`), any
player's name - so "the one against KingFish" works - a tag, or a word from
your own note. The archive gains Showdown, All In and Noted beside the chips it
had; the panel gains the box.

Two small refusals worth naming. A hand with no big blind on record is not a
"big pot" rather than dividing by zero and letting everything through. And a
search that matches nothing says "No Hands Here Match That Search" instead of
the panel's empty-history copy - telling a seated player they have no hands
when they are looking at a filter is the mistake Phase 1 fixed for spectators.

## Keep it

`ca_hand_notes`: one row per player per hand, holding a note and up to twelve
tags.

**The note is the player's own and only theirs.** It is a private record of how
somebody else plays, so the privacy is Postgres's rather than the client's: RLS
on all four commands against `auth.uid()`, `WITH CHECK` on both writes so a row
cannot be inserted onto another id, and the grant is to `authenticated` alone -
`anon` has nothing. `HandNotesService` takes no user id anywhere, because a
service that cannot name a user can only ever read its own rows.

Verified against production inside a transaction that rolled itself back
(CLAUDE.md 11.5): player A writes a note, player B reads zero rows, B's attempt
to insert onto A's id is refused, an empty tag is refused, a thirteenth tag is
refused. The probe ended in `RAISE EXCEPTION`, which is the success case, and
`ca_hand_notes` holds no rows.

Sizes are the database's too: 2,000 characters and 12 tags of 24, as CHECK
constraints. The per-tag rule is an IMMUTABLE function rather than an inline
check because Postgres refuses a subquery in a CHECK (`0A000`), and reading
every element of an array needs one.

The editor never says Saved until the write landed. A failure leaves the text
on screen and says "Not Saved" - a note that exists only in a browser tab is
worse than no note, because the player stops thinking about it.

## Take it with you

`src/utils/pokerStarsExport.ts` writes the PokerStars text format, which is the
one PokerTracker 4 and Hand2Note parse. Club Arena's existing export is ours -
`Club Arena Hand #N`, our verbs - and no tracker can read a line of it.

Reading the actual output, rather than only the tests, caught four things that
each produce a file that looks right and imports wrongly:

1. **A raise is measured against the BET LEVEL, not the raiser's own
   increment.** Over a $2 big blind, a raise to $5 is `raises $3 to $5`.
   Writing the increment gives `raises $5 to $5`, which a tracker reads as a
   raise to ten dollars.
2. **The small blind is posted before the big blind**, whatever the seat order.
   The engine writes them in seat order, so a hand whose big blind sat in a
   lower seat posted them backwards in the file.
3. **A seat's cards are shown once.** The engine writes a `show` row AND the
   model carries a showdown row; printing both put the same hand in the file
   twice, which reads as two showdowns.
4. **"folded before Flop"** is the format's wording. The felt's own street
   label is "PreFlop", and `folded on the PreFlop` is not a line any parser
   knows.

**What it refuses to write, and why that is the feature.** A tracker's numbers
are only worth having if they are the table's numbers, so this never invents
one:

- a hand with **no starting stacks** on record - the format has a mandatory
  `($X in chips)` on every seat;
- a **bomb pot** - antes and no blinds, and every tracker derives position and
  most preflop statistics from who posted the blinds;
- a **run-it-twice** hand - one pot across two or three boards, where the
  format has one, so it would import with the right money against the wrong
  showdown;
- **Crazy Pineapple**, which has no name in the format at all.

Of the 38-hand production corpus, 21 export faithfully and 17 are refused with
their reason. The surface says how many it left out rather than handing over a
file that is quietly short.

**Validated against the format, not against a tracker.** The grammar is pinned
line by line in `tests/unit/handSearchAndExport.test.ts` against real hands.
Nobody here has run PokerTracker on the output, and the file says so; if an
importer rejects something, that pin is where to correct it.

## Pins

`tests/unit/handSearchAndExport.test.ts`, 27 of them, over the same anonymised
corpus of 38 real production hands the share-link differ uses: every search
term including the ones that must NOT match, the subject built off the model on
every hand, the four format corrections above, the refusals with their reasons,
and every accepted hand written and re-read without a `10` where a `T` belongs
or a bare number where money belongs.
