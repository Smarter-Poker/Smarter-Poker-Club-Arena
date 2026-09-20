# The Diamond games pay what they advertise

2026-09-20. Branch `feat/diamond-one-setting-super-guarantee`.

Dan, 2026-09-19, three instructions and then a complaint:

> ALL "UPGRADED GAMES" NEED TO SAY "SUPER + GAME TITLE". THEY MUST ALL PAY A
> MINIMUM OF 1:1 VALUE EVEN IF THEY LOSE AND DON'T CASH OUT. THAT SHOULD BE
> DISPLAYED BEFORE THEY EVEN START THE GAME.

> I DON'T THINK USERS SHOULD SELECT DIFFICULTY, IT NEEDS TO BE ONE SETTING THAT
> IS ALREADY BUILT INTO THE PAYOUT AND MATH, ALL GAMES PAYOUT BASED ON "ONE
> COMBINED" DIFFICULTY LEVEL. REDESIGN AND RE AUDIT THIS ALGORYTHM.

> DO A DEEP DIVE ONLINE AND SEE HOW OTHER CRASH, OR CROSS THE ROAD GAMES, PINKO
> AND MINES ARE DISPLAYED ANIMATED AND SHOWN, AND MAKE ANY AND ALL IMPROVEMENT,
> ENHANCEMENTS AND UPGRADES TO OURS AS THEY ARE NEEDED.

> I JUST PLAYED 20 PLINKO GAMES, AND NEVER ONCE MADE MORE THEN THE 21 ON A 2500
> DIAMOND SPIN... AND NEVER ONCE HIT A 5X 10X OR 20X SMH. YOU NEED TO GO THROUGH
> AND EVALUATE THE "FAIRNESS" OF EACH AND EVERY GAME AND INSURE THEY ARE ALL
> CALIBRATED SUCCESSFULLY.

The last one turned out to be the important one, and it was not a bug report
about randomness. **The maths was right and the calibration was broken.** What
follows is the audit, then what changed.

---

## 1. The Plinko complaint, measured

Every Plinko table on this platform returns exactly 0.80 of the stake. That is
checked in SQL before a table can be activated (`fn_plinko_table_audit` refuses
a `spec_rtp` other than `0.800000`) and in
`tests/the-games-never-pay-more-than-they-take-in.law.test.ts`. That part was
never in question and is unchanged.

The board has sixteen rows, so a drop lands in slot k with probability
C(16,k)/65536. On the **Steady** table Dan played:

| Per drop | Steady |
| --- | --- |
| P(pays 5x or better) | 0.418% (1 drop in 239) |
| P(pays 10x or better) | 0.052% (1 in 1,927) |
| P(pays the 20x top) | 0.0031% (1 in 32,768) |
| Standard deviation | 0.615 of the drop |

A 2,500-diamond award at one to five diamonds a drop is **500 to 2,500 drops**.
The mean of that many independent drops is 0.80 with a standard deviation of
0.0275 (at 500) or 0.0123 (at 2,500). So:

| Steady, drops per game | sd of the game's return | sigmas from 0.80 to a 2x day |
| --- | --- | --- |
| 10 | 0.1946 | 6.2 |
| 25 | 0.1231 | 9.7 |
| 100 | 0.0615 | 19.5 |
| **500** (5 diamonds a drop) | **0.0275** | **43.6** |
| **2,500** (1 diamond a drop) | **0.0123** | **97.5** |

A 43-sigma event does not happen. **At 500 drops the game could not return more
than about 21 chips on a 2,500-diamond entry, and 20 such games could not
contain a 20x drop** (expected count: 20 x 500 x 0.0031% = 0.3, and hitting one
among 10,000 drops is a coin flip he lost). Dan's twenty games are exactly what
this table plus that drop count predicts. Nothing was rigged; the game was
arithmetically incapable of the outcome it advertised.

The deeper problem is structural: **splitting a fixed entry into more drops
cannot change the expected return, it only destroys the variance that makes a
prize reachable.** A per-drop choice of 1 to 100 diamonds was therefore a choice
between a game that could pay and a game that could not, offered to a player
with no way to know that. That is the "difficulty" Dan was right to remove.

## 2. What the four games are, and what each one now pays

One setting per game, built into the payout, with no player choice. The server
refuses anything else for a new round.

| Game | The one setting | The design |
| --- | --- | --- |
| Diamond Plinko | Ten drops of a tenth of the entry, on one table per stake kind | `fn_plinko_bonus_run` refuses any other split: "Plinko Plays Ten Drops. Refresh Before You Play" |
| Diamond Crash | No setting to pick; auto cash-out stays optional | P(point >= x) = (0.8B - L)/(xB - L) |
| Donkey Cross | Twelve streets, 1.10x to 20.00x | P(reach street n) = (0.8B - L)/(prize_n - L) |
| Diamond Mines | Six mines in twenty-five tiles | prize_k = L + (0.8B - L) x C(25,k)/C(19,k) |

B is the funded stake in chips, L the guaranteed minimum. Every one of those
identities carries expectation exactly 0.8B at **every** stopping point, which
is why no stopping strategy beats any other and why the floor can be raised
without changing the house edge: raising L moves value from the tail into the
loss, it does not create or destroy any.

### The two Plinko tables

Both return exactly 0.800000, both top out at exactly 20.00x, and on both every
slot pays something. Nobody chooses between them: `fn_plinko_table_version(boost)`
does, from the stake kind.

**Diamond (version 5), ordinary awards.** Slots, outer to centre:
20x, 20x, 20x, 12x, 5x, 0.60x, 0.35x, 0.15x, 0.08x.

**Super (version 4), Super awards.** 20x, 20x, 15x, 7.5x, 1.75x, 0.64x, 0.56x,
0.53x, 0.52x. Its lowest slot is 0.52x, above the 0.50x that is the player's
original spin on a doubled stake, so **a Super batch clears its 1:1 guarantee
through the multipliers themselves** and the floor top-up is a belt on a pair of
braces.

Steady, Bold and Moonshot are deactivated. Their settled batches and replays
still read and still verify; no new round can name them.

### What a game now looks like, exactly

Computed by convolving the seventeen-slot distribution ten times in integer
arithmetic (no simulation, no sampling), so these are the true probabilities:

| Over one ten-drop game | Steady (old) | **Diamond (live)** | **Super (live)** |
| --- | --- | --- | --- |
| Sees a drop paying 5x or better | 4.1% | **55.0%** | 19.3% |
| Sees a drop paying 10x or better | 0.5% | **19.3%** | 4.1% |
| Sees the 20x top | 0.03% | **4.10%** | 0.52% |
| Returns at least the entry | 12.7% | **28.0%** | 19.5% |
| Returns at least twice the entry | 0.06% | **6.79%** | 3.45% |
| Returns at least three times | 0.00% | **1.43%** | 0.19% |
| Median game | 0.79x | 0.68x | 0.66x |
| 90th percentile | 1.03x | **1.87x** | 1.36x |
| 99th percentile | 1.39x | **3.17x** | 2.50x |
| Worst game | 0.00x | 0.08x | **0.52x** |
| Mean | 0.80x | 0.80x | 0.80x |

The edge is identical. What changed is that the advertised prizes are now
reachable inside a single game: **a 20x lands in one game in twenty-four rather
than one in three thousand, and a doubling day happens once in fifteen games
rather than once in seventeen hundred.**

### The guarantee, and what it costs

`fn_diamond_bonus_minimum(bet, boost)`: an ordinary award keeps a tenth of its
stake on any loss; a **Super award keeps half its doubled stake, which is
exactly the spin the player paid for.** So a Super game pays at least 1:1 of the
original spin however it ends, and the page says so before Start.

That is not free, and it should be said plainly: at a fixed 0.80 return, money
promised to the loss cannot also be in the tail. On a Super game the at-risk
half of the stake returns 60%, so:

| Super game | Consequence of the 1:1 floor |
| --- | --- |
| Super Crash | P(crash before 1.01x) is about 41%; P(reaching 2x) is 20% |
| Super Donkey Cross | Street 1 survives 50% of the time |
| Super Diamond Mines | The first gem pays 0.895B, which is 1.79x the original spin |
| Super Plinko | Every slot pays; the top is still 20x but 5x is 1 drop in 47 |

That is the honest trade for "never lose your spin", and it is why the Super
table is deliberately flatter than the Diamond one. RTP stays 0.80 everywhere:
it is an owner rule enforced in SQL (the Plinko activation gate refuses any
other figure, and the wheel refuses to spin on a prize table whose `spec_rtp`
is not `0.800000`), and this change does not touch it.

## 3. Fairness: every game's sealed draw, measured against its closed form

The unit tests prove the **design** is exact. They cannot prove the **draw**
reaches it, because the draw lives in Postgres. So
`tests/sql/diamond-bonus-fairness-audit.sql` now draws tens of thousands of real
outcomes through the real installed functions and measures them. It is read
only, its seeds are fixed (so it can never flake), and the local runner and the
required `accounting_postgres` CI job both execute it.

| Game | Drawn | Checked against |
| --- | --- | --- |
| Plinko, both live tables | 32,768 drops each | Pearson chi-square against C(16,k)/65536 (16 df, refused above 52.4); realised return within 0.06 of 0.80; the count of 5x+ and 20x drops within four standard deviations of expectation, and non-zero |
| Crash | 32,768 rounds at each of six targets, plus 8,192 floor checks | P(point >= x) = (0.8B - L)/(xB - L) within four standard errors; no point below 1.00x |
| Donkey Cross | 32,768 rolls at each of twelve streets | P(reach street n) = (0.8B - L)/(prize_n - L) within four standard errors |
| Diamond Mines | 4,096 boards (98,304 shuffle draws) | every cell hides a mine with probability 6/25, chi-square over 25 cells (24 df, refused above 66.6); every board exactly six distinct cells in 0..24; every prize on its closed form to 1e-6 |
| The wheel | 32,768 spins | the twelve outcomes at their stated weights, chi-square (11 df, refused above 43.8); the four game awards total 40% within four standard deviations |

Reading the production draw paths line by line alongside that, four things are
worth recording because they are what "legit" actually rests on:

- **The server seed is drawn before the player's seed is known.** Every game
  commits `gen_random_bytes(32)` and publishes only its SHA-256; the receipt
  hands back the seed, and the page re-derives every outcome in the browser
  ("Verify Every Drop").
- **Plinko's bits are the bits.** `get_bit(hash, 0..15)` in SQL is
  `byte0 | byte1 << 8` in the client, and the slot is the popcount. There is no
  table lookup between the hash and the prize.
- **The Mines shuffle rejects rather than folds.** Fisher-Yates over 25 cells
  drawing a fresh 32-bit value and discarding any above `floor(2^32/i)*i`, so
  there is no modulo bias. The chi-square above is what proves it empirically.
- **One roll decides a whole road.** Donkey Cross draws a single 48-bit value
  and compares it to each street's survival threshold, so the ladder cannot be
  re-rolled mid-round and a replay reproduces it exactly.

`tests/the-games-never-pay-more-than-they-take-in.law.test.ts` now pins the
calibration as well as the edge: exact 0.80 on both tables in integer
arithmetic, no dead slot, the Super floor below the Super table's worst slot,
the reachability figures above as lower bounds, the whole-game distribution, the
p99 at or above 2x, the guarantee rule across all 2,476 entries and both stake
kinds, one mode per game, and the same constants read back out of the migration
text so the client mirror and the SQL cannot drift. Run against the three closed
tables, **Steady fails five of those assertions** — the law bites on the exact
game Dan played.

## 4. What changed in the product

- **Super, not Upgraded.** `src/utils/diamondGameTitles.ts` is the one source:
  Super Plinko, Super Crash, Super Donkey Cross, Super Diamond Mines. The word
  "Upgraded" is gone from every surface. The wheel's UPGRADE segment keeps its
  own name, because that is the prize that opens the second wheel, not a game.
  The crossing game is now **Donkey Cross** everywhere, including its route page
  name and the operator screens.
- **The guarantee is shown before Start.** `fn_wheel_bonus_state` returns the
  award's own `guarantee`, `minimum_payout_chips`, `mode` and `plinko_table`;
  `parseBonusGuarantee` refuses a quote that disagrees with the rule the client
  knows, so the figure on the screen is the figure the server will pay. Every
  game console carries a `Guaranteed` bay, gold on a Super award, and the setup
  panel carries the sentence.
- **No difficulty anywhere.** The Plinko risk chooser, the Plinko drop-value
  chooser, the road difficulty and the mine-count picker are removed from the
  pages and refused by the server. A round sealed under an old setting keeps it
  and still replays.
- **`payout_version` 3** marks a round sealed with the Super floor, so a receipt
  states which contract it was settled under without a new column.
- **Presentation.** Plinko buckets now carry a colour scale monotone in the
  multiplier, bounce when a ball lands, flash the pegs each ball strikes
  (including in the ten-drop batch, which previously revealed nothing) and pulse
  on a 5x-or-better landing. Crash pins its axes, prints a tabular-numeral hero
  ticker that warms as it climbs, draws the auto cash-out and the guaranteed
  floor as labelled lines, and keeps a colour-coded history strip. Donkey Cross
  prints every street's multiplier and chip prize, tints the lanes ahead as the
  hazard rises, and shows the cash-out value. Diamond Mines shows Total Profit
  and Profit On Next Tile, flips a picked tile to its gem, and cascades the whole
  board open at the end. All of it collapses under `prefers-reduced-motion` and
  scales with the player's animation speed.

## 5. Files

- `supabase/migrations/20260919220610_diamond_bonus_games_have_one_setting_and_super_guarantees_the_entry.sql`
  (md5 preimage guards on eleven signatures, then the two tables, the boosted
  minimum, the one setting per game and the ten-drop rule)
- `tests/sql/diamond-one-setting-super-guarantee.sql`,
  `tests/sql/diamond-bonus-fairness-audit.sql`, both wired into
  `scripts/dev/test-accounting-delivery.sh`
- `tests/the-games-never-pay-more-than-they-take-in.law.test.ts` (+877 lines, no
  assertion deleted)
- `src/utils/diamondGameTitles.ts`, `diamondBonusPayout.ts`,
  `bonusGameBudget.ts`, `diamondChoiceMath.ts`,
  `src/services/WheelBonusEntryService.ts`, the four game pages, the four scenes
- `scripts/ci/classify-ci-changes.mjs`: a change to an e2e helper fixture did not
  admit the job that runs the spec consuming it, and a change to
  `tests/sql/diamond-one-setting-super-guarantee.sql` did not admit the only job
  that executes it. Both fixed by directory rather than by name, and pinned from
  disk in `tests/unit/diamondGamesCiRouting.test.ts`, so the next fixture is
  covered without anybody remembering.

## 6. What is deliberately not fixed

The 0.80 return is an owner rule and stays. A player's median Plinko game is
still a loss (0.68x on the Diamond table), because a 0.80 game's median has to
be. What the recalibration buys is that the advertised prize is now reachable
inside one game rather than a statistical impossibility, and that a Super award
can no longer cost the player the spin they paid for.
