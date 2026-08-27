# 2026-08-27 — Second pass on the jackpot: proving it, and the rules it was not keeping

Dan, after the first pass: _"this sounds like a real issue, keep auditing,
improving, building and enhancing this until its perfect and working."_

## The payout path is now proven, without spending a chip

The first audit could not close this: there has been no real jackpot since
2026-08-19, so the money path had never been observed end to end under current
code. `bbj_atomic_payout_v2` was called against production inside a transaction
that aborts, per CLAUDE.md §11.5 — what you want from the probe is the message,
not the side effects.

```
applied=t  already=f
total=80993.61  bad_beat=40496.80  hand_winner=20248.40  table=20248.41  per=6749.47
recipients=5  sum=80993.61
bbj_winners_rows=1
main 80993.61 -> 18178.97      debited main only, then reseeded from backup
```

Rolled back clean: 29 payouts before, 29 after, `hit_count` unchanged at 45. The
50/25/25 split, the table share reaching **every** dealt-in player, the
main-only clamp, the backup reseed and the `bbj_winners` write are all real and
all correct. A second probe against a real `hand_history` row confirmed
`bbj_payouts.hand_id` now resolves to that row.

## Two rules we published and did not enforce

`BBJ_RULES.excludeDoubleBoard` and `BBJ_RULES.onlyFirstRunout` existed in
exactly two places: the constant, and the rules panel that **tells players they
apply**. No code read either.

- **excludeDoubleBoard** is enforced now. A double-board bomb pot deals two
  boards for one pot, so a beat on one of them is not the hand the jackpot is
  for — and until today such a hand could pay, which made the rules page wrong
  rather than the engine.
- **onlyFirstRunout** turns out to hold by construction: `SHOWDOWN` fires once
  per hand and _before_ the extra runouts, so the results are already board
  one's, and settlement passes board one's cards to match. Pinned in a test so
  nobody re-derives it, or "fixes" it by adding a second emit.

## A chopped pot could refuse a real bad beat

Settlement passed `currentHandWinnerIds[0]` and the detector took one winner.
On a split pot exactly one was checked against "the winner must hold quads or
better" — so if the **other** held the quads, a genuine bad beat was refused and
nothing recorded that a jackpot had even been considered. All winners are
evaluated now and the rule applies to the strongest, mirroring what the loser
side has done since 2026-08-18.

## Short deck was being scored as if it were hold'em

`bestFive` fell through to the standard search, and the note in the file said
that was fine "because short deck is not BBJ-eligible". True of the jackpot and
irrelevant to everything else — the same evaluator names the made hand in the
table's own Previous Hand rundown, and production holds **41,153 short-deck
hands**.

With 36 cards a **flush beats a full house**, and the lowest straight is
**A-6-7-8-9**. So a short-deck player holding a flush against a full house saw
the full house drawn as the winning hand — the hand that lost the money — and
the wheel was called a high card. Both rules are ported from the engine's own
evaluator (`PokerEngine.evaluate5Cards`), because the engine decides the pot and
this only draws it. Two implementations of one ruleset is already one too many;
two that _disagree_ would show a player a hand that lost.

## The dead end is gone

24 of the 29 jackpots have no hand row, and tapping one produced a single grey
sentence. But `bbj_winners` still holds both hand names, both display names and
the pool at the moment it hit; `bbj_payouts` holds the split;
`bbj_payout_recipients` holds every player paid. Only the street-by-street
action is missing.

`fn_bbj_hand_detail` returns `handAvailable: false` with all of that instead of
NULL, and the client renders a summary card naming the beat, the hand that beat
it, the pool, and every payout — plus one honest line about what was not kept.
NULL is still returned when the payout id does not exist, because that is a
genuine nothing.

## The money path cannot leave version control again

`scripts/ci/check-bbj-functions-match-production.mjs` prints the normalised
fingerprint of every watched BBJ function as the **repo** defines it, applying
migrations in filename order so the last definition wins — which is what a
rebuild produces. All five match production exactly today, and it exits
non-zero if a watched function is defined in no migration at all, which is the
state the two payout functions were in this morning.

Two normalisations, both narrow and both necessary: comments and whitespace
carry no behaviour; and `timestamptz` is canonicalised to `timestamp with time
zone` **in the signature only**, because `pg_get_functiondef` rewrites parameter
types but prints a plpgsql body verbatim — applying it to the body makes a
matching function look different, which is a false negative worth not
re-introducing.

## Two tests I got wrong before the code

Worth recording, because both were the test asserting something that could not
happen rather than the code being broken:

- The forced-money fixture called a straddle for the full amount when the small
  blind is already live, so its pot was one blind too high.
- The short-deck fixture asked for a hand where a flush and a full house are
  both available to one player. With two hole cards they compete for the same
  board slots, so that is nearly unconstructible — which is also _why_ the swap
  rarely changes the five one player plays. It decides which of **two** players
  won, so that is what the test now asserts.

## Still open, recorded rather than quietly carried

1. `bbj_payouts.hand_id` is populated but not a foreign key. `hand_history` rows
   are pruned: RESTRICT would break the pruner on a jackpot hand, SET NULL would
   erase the evidence. The prune exemption keeps those rows alive; a constraint
   can follow once it has run without incident.
2. `runStep` continues after a failed step, so a failed `hand_history` write
   still leaves the payout with a NULL `hand_id`. The prune fix removes the
   common cause of an orphan; this failure mode remains.
