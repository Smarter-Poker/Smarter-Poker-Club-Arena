# The variant map was wrong twice, and the discard street was measurable all along

Date: 2026-08-23
Author: cowork-variants
Scope: closes the two gaps the previous audit left open, and fixes a defect I
introduced in the change that was supposed to fix the first of them.

## 1. I fixed the variant map and it was still wrong

The original was `game_type.includes('PLO') ? 'PLO4' : 'NLH'` — every hand in
the estate shared as one of two things. My correction earlier today added PLO5
and PLO6 and shipped in PR #379.

It was still wrong for **three of the eight variants actually running**:

| Stored `game_variant` | Hands, 3 days to 2026-08-23 | Shared as, after my "fix"      |
| --------------------- | --------------------------- | ------------------------------ |
| `nlh`                 | 218,040                     | NLH ✓                          |
| `plo4`                | 73,166                      | PLO4 ✓                         |
| `plo5`                | 42,100                      | PLO5 ✓                         |
| `short_deck`          | 22,180                      | **NLH** ✗                      |
| `plo6`                | 21,175                      | PLO6 ✓                         |
| `plo8`                | 15,212                      | **PLO4** ✗ (it contains "PLO") |
| `ofc_pineapple`       | 13,860                      | **NLH** ✗                      |
| `pineapple`           | 13,825                      | **NLH** ✗                      |

**Both times the mistake was the same one: writing the mapping without reading
the catalogue.** I criticised the original for asserting a variant it could not
know, then did a smaller version of it an hour later. One `select game_variant,
count(*) group by 1` — the query at the top of this file — would have prevented
both.

`ShareableHand['variant']` was itself too narrow to express the answer: a union
of four for a catalogue of eight. It is now the real eight. Encoded values ride
inside a base64 payload (`btoa(parts.join('~'))`), so multi-word labels
round-trip.

`tests/share-variant-and-discard-street.test.ts` asserts **every one of the
eight**, plus the two ordering traps: PLO8 must be tested before the PLO
catch-all, and OFC before PINEAPPLE, since each contains the other. Sabotage
tested by restoring the original rule order — it fails.

## 2. The discard street was measurable; I had said it wasn't

The previous audit recorded `pineapple_discard` actions being dropped by the
adapter's street filter as a known gap, on the grounds that establishing the
street ordering timed out against a 10 GB table.

That was true of the query I ran (`actions::text LIKE '%pineapple_discard%'`,
an unindexed full scan) and not true of the question. Filtering on
`game_variant = 'pineapple'` with a recent-window bound answers it in one pass:

    hands_with_discard   31
    discard_after_preflop 31
    discard_before_flop   31
    discard_after_flop     0
    discard_after_turn     0

Unanimous, no counterexample. `pineapple_discard` sits **after preflop, before
the flop**, and is now a first-class street in both the adapter's ordering and
the panel's labels ("Discard"). 27,685 pineapple hands in three days had every
discard silently missing from the replay and from the exported hand text.

**Lesson: "the query timed out" is a fact about the query, not about the
question.** Bounding it by a column the schema is actually organised around
turned an impossible check into a one-second one.

## 3. Figures that read bigger than they are

The summary bar and CSV export operate on the hands **loaded** — 25 by default
— while reading as lifetime totals. "Biggest Pot" is the kind of number a
player repeats, and it meant "the biggest of the 25 on screen".

Not fixed by computing lifetime aggregates: that is a 5.1M-row scan per page
view, and the honest cheap answer is to say what the number covers. The summary
now carries "Across The N Hands Loaded, Load More For A Fuller Picture", and the
export toast says "Exported N Loaded Hands" instead of "Hand history exported!".

## 4. Verification

tsc clean. 3,300 tests / 267 files pass, 5 skipped. Seven CI gates run locally,
all pass. PR #379 confirmed merged and serving production before this branch was
cut.
