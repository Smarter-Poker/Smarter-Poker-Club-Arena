# Crazy Pineapple - the card you threw is yours alone (Phase 4 of 4)

**2026-09-01.** The last phase. Two things: the replay can finally show you
which card you discarded, and the felt stops naming the wrong game.

## The handoff's own instruction would have leaked every discard

Phase 4's spec said to persist the discarded card in `hand_history` - "the
`players`/`actions` JSONB, or `hole_cards` - decide and document". I checked
the policy before deciding:

```sql
hand_history_authenticated_select
  USING (players @> jsonb_build_array(jsonb_build_object('userId', auth.uid())))
```

**Any player who was in a hand can read the whole row.** Every other seat's
entry included. That is safe today only because the engine writes cards there
exclusively for hands that were SHOWN - measured over 785 hands containing a
fold, a folded player's cards were stored zero times.

A discarded card is never shown. Not on the discard, not at showdown. Putting
it in `hand_history` would have published every player's discard to every
opponent at that table, permanently, through a policy that looks correct. That
is the same shape as the god-mode vulnerability that created
`table_hole_cards` in the first place.

So it does not go there.

## Where it goes instead

`hand_discards`, a new table that copies `table_hole_cards`' proven shape:
keyed `(table_id, hand_number, user_id)`, RLS `auth.uid() = user_id`, no write
path from a browser at all, and retention that mirrors `hand_history`'s - a
hand with a human in it is kept forever, so a human's discard is kept forever.

Proven, not assumed:

| check | result |
| --- | --- |
| two players, one hand, player 1 reads | 1 row, their own |
| the same, player 2 reads | 1 row, their own |
| `anon` reads | permission denied for table |
| `authenticated` writes | no grant, refused |

The card reaches that table on a **private event**. `PINEAPPLE_DISCARDED`
carries the card and is consumed by the engine; the public `player_action`
event still carries a seat and the word `discard` and nothing card-shaped.
This is exactly the split `CARDS_DEALT` already uses, and the handler has no
`hub.emitEvent` in it - pinned, so it cannot grow one.

The client reads it **without naming a user**:

```ts
supabase.from('hand_discards').select(...).in('table_id', ...).in('hand_number', ...)
```

Asking for "every discard in these hands" returns exactly the caller's own,
because the policy is what filters. The privacy of the variant's one private
card is enforced by Postgres, not by a method remembering to pass the right
id - which is the difference between a rule and a habit. `mapHandHistoryRow`
resolves the owner through the row's SEAT rather than a viewer id, because
that file already records what a per-viewer argument cost it once.

## The felt was naming the wrong game

The `pineapple` variant has always dealt CRAZY Pineapple: the discard comes
after the flop. In plain Pineapple you throw a card before it - a different
game with different strategy, and the one every surface was announcing.
`lobbyEntries` already knew, in a comment: "all of them NAMED Pineapple".

Every surface a player READS now says Crazy Pineapple - lobby, filters,
waitlist, hand history, share, tournament cards, table config.

**The variant KEY is untouched.** `pineapple` is written into millions of
`hand_history` rows, ~120 live table rows, every horse profile and every lobby
filter. Renaming a key to fix a label is how a rename becomes an outage. The
~120 live `tables.name` rows are a separate, player-visible data change and
are Dan's call; he chose code labels only for this pass.

## Pinned

Two new pins (57 -> 59), one of them the security boundary itself. Two
existing pins MOVED, not weakened: `share-variant-and-discard-street` and
`HandHistoryAdapter` asserted the label, and the label was the thing that was
wrong.
