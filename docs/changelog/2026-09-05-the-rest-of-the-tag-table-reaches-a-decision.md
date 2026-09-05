# The rest of the tag table reaches a decision (V41)

2026-09-05. Dan: _"there is absolutely no point to keep upgrading and
enhancing the logic of the horses if nothing reads the tags. I bet there are
1000's of tag rows that exist and the only code that touches that table is
the tagger itself."_

Measured before this change, week to 2026-09-05: 38 distinct leak tags on
249,475 review rows. Six of them reached a live decision - V40's
`PLO_STACKOFF_TAGS`, Omaha only. Three more nudged a global dial by 0.01 a
night. The rest were counted and read by nobody:

| family             | tags                                                                                                             | hands / week  | avg loss      |
| ------------------ | ---------------------------------------------------------------------------------------------------------------- | ------------- | ------------- |
| hold em stack-offs | top_pair_weak_kicker, weak_kicker_trips, straight_into_flush, nonnut_straight, underfull, nonnut_flush, coldcall | 3,423 + 4,879 | -58 to -101bb |
| river wars         | river_raise_war, river_raise_paidoff                                                                             | 8,291         | -60 to -96bb  |
| limped-pot bloat   | limped_pot_bloat                                                                                                 | 4,592         | -77.8bb       |

## What reads them now

Three loads, each `sum(tag counts) / reviewed hands`, zero under 40 reviewed
hands, computed once per decision into `StyleParams` the way V40 computes
`ploStackoffLoad`:

- **`nlhStackoffLoad`** feeds the V20 pressure cap. V20 reads ONE street (a
  raise, a hero-bet-got-raised, a second all-in); the tagged lines were the
  other shape - bet, call, bet, call. A tagged horse now reads every earlier
  barrel by this bettor, a pot-sized bet, and the tag itself as degrees of
  heat, and the heat picks the V20 tier, exactly as V40's `heat40` does in
  Omaha. Its class ceiling also drops by up to 0.06. An untagged horse is
  byte-identical. Receipt `v41_nlh_leak_read`.
- **`riverWarLoad`** feeds two places where a river raise is faced after
  hero's own bet: respect rises by up to 0.12, and a tagged horse never
  re-raises below a full house - it calls or folds on the capped equity,
  in the committed branch too. Receipt `v41_river_war_read`.
- **`limpBloatLoad`** feeds a cap that exists only in a pot nobody raised
  preflop: a tagged horse's one-pair and two-pair hands are capped against a
  bet of half the pot or more (0.40 / 0.50, less the load, plus 0.08 before
  the river). Sets and better are untouched. Receipts `v41_limp_bloat_read`
  and `v41_limp_bloat_cap`.

## The family split

`leaks` in `profiles.horse_profile` was one map pooled across variants, and
`PLO_STACKOFF_TAGS` includes `nonnut_flush_stackoff`, which the hold em
detector also emits. A horse's NLH flushes were inflating its Omaha pressure
cap. The tuner now writes `leaksOmaha` / `leaksHandsOmaha` and `leaksHoldem` /
`leaksHandsHoldem` beside the pooled map (`leakFamilyOf` files plo\*/flo8 as
Omaha, everything else as hold em); `leakLoad` reads its own family first and
falls back to the pooled map for a profile written before tonight. Every new
key is registered in `HorseDataLedger` and parsed in `resolveHorseStyle`
(the ledger test enforces both).

## Flag

`v41Leaks`, default ON, off in `full_vs_v2_legacy`. No league matchup: the
league seats horses with empty profiles, so a matchup would measure nothing.
The proof is the production receipts against `v40_leak_profile_read`, and
the tag rates themselves over the next weeks - a load that works should
shrink its own tag.

## Tests

`HorseV41LeakLoads.test.ts` (14): the profile parses; the family split keeps
NLH flushes out of the Omaha load; in three fixed spots a tagged horse and a
clean one decide differently in the direction the tag says; each receipt
fires only where its tag was earned; a tagged horse with the flag off plays
like a clean one; the legacy card switches it off.
