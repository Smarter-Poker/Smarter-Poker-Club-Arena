# The mini bar is per variant, and the panel tells the main jackpot's own story

BBJ programme, 2026-09-12. Two things: a rule Dan set, and three defects found
while implementing it.

## Dan's rule (2026-09-12)

> "PLO5 NEEDS TO BE OR FLO5 NEEDS TO BE QUAD 10'S OR BETTER FOR MINI BBJ
> PINEAPPLE QUAD 2222'S"

| game            | mini bar was            | mini bar is now          |
| --------------- | ----------------------- | ------------------------ |
| **PLO5 / FLO5** | any quads               | **Quad Tens or better**  |
| **Pineapple**   | any quads (by fallback) | **Quad Deuces** (stated) |
| everything else | unchanged               | unchanged                |

PLO5/FLO5 **tightens**: quad nines no longer pays the mini there. Five hole
cards make quads common, which is the reason for the bar. Pineapple's effect is
unchanged - every quad still clears it - but it is now a stated rule rather
than a fall-through nobody chose.

**The bar stopped being a family guess.** The mini derived its bar from the
MAIN rule's `handRank`: `full_house` meant hold'em, anything else meant "any
quads". That is a two-value guess standing in for a per-game decision. Now a
variant may carry `miniMinQuadRank` and `miniBarLabel`, and where it does they
replace the family default. Adding a third game is a config line, not another
branch, and **the number and the words sit together** so a retuned bar cannot
leave its caption behind.

Both `RakeConfig.ts` copies carry it identically - the engine's and the
client's - which `tests/one-qualifying-rule-for-one-jackpot.law.test.ts`
requires and checked.

## Three defects the change surfaced

### 1. FLO5 and FLO4 did not exist, while the labels advertised them

`BBJ_QUALIFYING_HANDS` had `nlh, flh, plo4, plo, plo8, flo8, plo_hilo, plo5,
plo6, short_deck, pineapple`. **No `flo4`. No `flo5`.** And the labels have
always read "PLO4 / FLO4" and "PLO5 / FLO5".

The engine's BBJ detectors look this table up by the **raw** variant - only the
client calls `normalizeVariantKey`. So an FLO5 table would have taken
`detectMiniBBJHit`'s "variant not covered" branch and paid **no mini at all**,
while `getRakeConfig`'s `|| BBJ_QUALIFYING_HANDS.nlh` fallback judged its MAIN
bar by **hold'em rules** - Ace-in-the-hole and both-cards-must-play on a
five-card Omaha game. That is the Pineapple defect exactly, and `flh`, `flo8`,
`plo` and `plo_hilo` are all in that table for precisely this reason.

Caught by a test asserting FLO5 behaves like PLO5, which failed. **No such
table exists in production** - the live variants are nlh, plo4, plo5, plo6,
plo8, short_deck, pineapple, flh and flo8 - so this closes a trap rather than
repairing a loss. Both aliases added, both copies.

### 2. The panel told a club its jackpot hits every 0.2 days

`fn_bbj_analytics` computed `hit_count`, `avg_days_between_hits` and
`days_since_last_hit` over **every** row in `bbj_winners`, and since phase 6
that table holds two jackpots. Measured:

| pool               | hits | mini | main | panel showed | main only    |
| ------------------ | ---: | ---: | ---: | ------------ | ------------ |
| Deep Stack Society |   18 |   14 |    4 | every 0.22 d | every 1.15 d |
| Midway Union       |   14 |    7 |    7 | every 3.94 d | every 8.10 d |
| Club JAQK          |   24 |    0 |   24 | every 1.09 d | every 1.09 d |

Five times too optimistic on one pool, twice on another, and exactly right on
the third - which is the one with no minis. A figure correct only where the
feature it ignores is absent is not a rounding problem; it is the wrong
question answered confidently. `last_hit_at` had the same flaw: Midway Union's
panel said 2.95 days when the **main** jackpot had last paid eight days before
that.

Migration `20260912040247` adds `main_hit_count`, `main_paid_all_time`,
`main_avg_days_between_hits`, `main_last_hit_at`, `main_days_since_last_hit`.
The blended columns are **unchanged** - redefining `hit_count` would silently
move every other reader's number - and the panel now prints "Main Hits (All
Time)" and "Last Main Hit", falling back to the blended figure only for a
cached older row.

`CREATE OR REPLACE` cannot change a RETURNS TABLE, so the function is dropped
and recreated **inside one transaction**: nothing outside it can see the drop,
and the grants (`authenticated`, `service_role`; **not** `anon`) are re-applied
and then asserted in the same transaction, read from the live catalogue first
rather than assumed.

### 3. The empty refusal state cited a 7-day denominator for a 30-day claim

Mine, from phase 3: _"No Hand Was Refused In 30 Days. Across N Qualifying Hands
In The Last 7 Days."_ Two windows in one sentence - a denominator that does not
belong to its numerator. `hands_30d` was added in the same migration and the
sentence now uses one window.

## Verified

- **9 engine cases** (`server/src/config/theMiniBarIsPerVariant.test.ts`): PLO5
  quad nines refused, quad tens paid with label `Quad Tens Or Better` and rule
  `ranked_quads`, quad aces paid, FLO5 identical to PLO5, Pineapple quad deuces
  paid, **PLO4 and NLH untouched** on their old rules.
- The near-miss detector was given the **same** bar in the same edit. If those
  two drift, a hand the payout refused is reported as refused for a rule the
  payout never applied - worse than no near miss, because it reads as an
  explanation.
- Client **19,446 tests**, both typechecks clean, and the two config copies
  still identical.

## A note on the laws

Three laws went red on this change and every one was right to: the new keys
needed short labels, needed a block in the qualifying-hands strip, and the
mini-rule union had to stay identical across both halves. They were updated in
the same commit as the behaviour they pin, per CLAUDE.md 5.8 - not weakened.

## Follow-up, same day: four surfaces still stated the old rule

The rule change landed in the engine and the config, and **four player- and
operator-facing surfaces went on telling people the old one**: "any quads
losing to bigger quads or better in Omaha" - false for PLO5/FLO5 (Quad Tens)
and imprecise for Pineapple (Quad Deuces).

- `BBJRulesPanel` - the jackpot page's Mini tab
- `BBJMiniPanel` - what an operator reads while deciding whether to run it
- `BBJBasicPanel` - the popup's rules paragraph
- `BBJQualifyingHands` - fixed in the original commit

Each now names the per-game bars. A money rule misstated on the page whose job
is to state it is not a copy problem.

**And a law so the fifth one fails CI instead of shipping.** I found these four
by grepping, which finds what exists today and nothing about tomorrow.
`tests/the-mini-is-seen-and-discoverable.law.test.ts` now refuses any blanket
"any quads losing to bigger quads" claim across the six mini surfaces, and
requires the three paragraphs to name the PLO5/FLO5 and Pineapple bars
explicitly. It strips comments before matching, so the notes explaining the old
wording stay readable without failing the law that describes them.

## A rule change reaches the two halves at different speeds

Worth writing down, because Dan will set another bar one day and this is not
obvious from either repo.

The **client** publishes minutes after merge: measured today, `main`
`240b3394b2` was serving from `ca-static.smarter.poker` almost immediately, and
the PLO5 "Quad Tens Or Better" string was in the published `RakeConfig` chunk.

The **engine** does not. An engine-affecting merge is classified by
`stage-engine-release.yml`, which sends one exact-SHA event to
`auto-deploy-hetzner.yml`, and that waits in its break gate to cut over inside
the hourly `:55` maintenance break (CLAUDE.md 13). Verified today: the engine
was serving `d68cc549`, which does **not** contain `miniMinQuadRank`, while
`Engine Release 96c00643dd` - which does, along with the `flo5` alias - was
staged and in progress, waiting for that gate.

So for up to about an hour after a mini-rule merge, **the page states the new
bar and the engine still applies the old one.** Today that direction is safe:
the engine pays MORE minis than the page promises (any quads rather than Quad
Tens), so nobody is shortchanged and nobody is told they won something they did
not. A rule change in the other direction - one that LOOSENS the engine before
the page says so, or tightens the page while the engine still refuses - would
put a player in front of a promise the payout declines.

**If a future bar moves the other way, land the client text in a separate,
later merge than the engine rule**, so the page never promises something the
engine will not pay. Nothing enforces this ordering today; it is a judgement
the next author has to make, which is why it is written here rather than
assumed.
