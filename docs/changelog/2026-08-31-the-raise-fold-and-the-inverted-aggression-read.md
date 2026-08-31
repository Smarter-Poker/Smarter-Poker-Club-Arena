# 2026-08-31 — The raise-fold, and the read that had Dan backwards

Dan watched three PLO6 hands and asked "WTF?!". Both findings below started
there, both reproduce exactly, and both are now fixed.

## 1. Facing a 3-bet, the price was not part of the decision

Reproduced against the live engine — all three folded **40 out of 40**:

| Dan's hand                         | to call | pot | price     | bar demanded | outcome |
| ---------------------------------- | ------- | --- | --------- | ------------ | ------- |
| raised 12 with 35 behind, faced 48 | 36      | 60  | 1.7 : 1   | 0.803        | fold    |
| raised 6, BB **min-clicked** to 12 | 6       | 18  | **3 : 1** | 0.803        | fold    |
| min-raised 4, faced 16             | 12      | 20  | 1.7 : 1   | 0.803        | fold    |

The bar was **0.803 whatever the pot laid** — a fixed top-20% requirement. On
the first hand the engine scored the holding at **strength 0.753, a top-25%
PLO6 hand**, and strength was never even consulted: `toCall <= stack * 0.35`
had already vetoed the call. That cap is deep-stack discipline, and it bites
hardest exactly when hero is MOST committed and the odds are BEST.

In PLO6 essentially any six cards hold more than 25% equity against a
3-betting range, so a 3:1 price is a call with the entire range. The
single-raise branch has known this since V24 — _"PLO equities are COMPRESSED
... a bar tuned in NLH percentile space folds hands that are getting a fine
price"_. The 3-bet branch never learned it.

Three corrections:

- the bar now drops with the price (relief x1.6 in Omaha, x0.9 in hold'em
  where the equity spread is real), floored so it cannot become a station;
- the stack cap no longer vetoes a call the price has already made correct
  when hero is committed;
- the V25 "never raise-fold a committed PLO stack" guard loses its `ploT`
  gate. That argument is about the VARIANT, not the format — gating it on
  tournaments left every PLO **cash** table with no protection, which is
  where Dan was sitting.

Production before the fix: 47 plo4 / 43 plo5 / 33 plo6 raise-then-folds in
six hours, ten of them folding to a re-raise of 2.5x or smaller.

## 2. The aggression factor counted preflop — but Dan was not the victim of it

**A correction I have to make against myself.** The first read of this said
the horses had Dan filed as a passive station, from a profile showing
VPIP 69.7% / AF 0.67. That profile belongs to `danbek4545@gmail.com` — an
account with **zero table_seats, ever**, and stats last touched two days
ago. It is not the account he plays on.

His real one (`daniel@bekavactrading.com`, 600 hands, updated the same
morning) reads:

    VPIP 39.3%   PFR 29.5%   AF 3.51   fold-to-aggression 72.1%

AF 3.51 is comfortably past the 2.5 maniac bar, so the horses already
classify him correctly and already call him lighter (callDownMod 1.2).
Probed with those exact counters injected, the read moves a marginal pair
from a 63% fold against an unknown to a 46% fold against him — sixteen
points in the right direction — while air still folds 100% and made hands
call 100%. **The table awareness works. It was not the leak, and the leak
was preflop, above.**

The mind is also not thin: **590 tracked players, every one past the
10-hand gate, 589 at full confidence, up to 16,306 hands on a single
player, 241,265 targeting pairs.**

### The AF fix stands on its own evidence, not on Dan's hands

While proving the above I did find a real defect, and it is worth fixing on
its own terms: `aggr / passive` counts **every street**. The classic
Aggression Factor is postflop-only because preflop calling is structurally
normal (blinds, position, price), so a loose-preflop / hammer-postflop
player is dragged toward "passive" — and `exploit()` then hands that
player's bets MORE respect.

Measured over 58 live players with real samples: average AF **1.87**
all-streets vs **1.37** postflop-only, and **ten of the 58 misclassified
across a decision threshold** — two genuine maniacs read as normal. Fixed
with two additive counters and a fallback to the old ratio until a player
has ten postflop actions, so nobody is judged on three hands of noise.

Dan's own account is not among the ten; his AF is high either way. This is
a fix for the players it silently mis-reads.

## Verification

- tsc clean both roots; engine **1,499 tests / 132 files**, services
  **550 / 52**.
- 11 new pins across the two fixes.
- **Six mutations run.** Four caught: price relief removed (2 fail), the
  inverted cap restored (1), AF back to all-streets (1), postflop counters
  never incremented (2).

### Two mutations survived, and why — recorded rather than papered over

- **Re-gating V25 to `ploT`** changes nothing the tests can see, because the
  new price relief now _subsumes_ that guard in every spot the suite reaches.
  The un-gating is still correct — the guard should never have been
  tournament-only — but it is now defence in depth, and no honest pin
  isolates it.
- **Removing the Omaha floor** is likewise unobserved: its binding region is
  narrow, and the first attempt to pin it asserted a FOLD at 22:1 that the
  pre-existing V13 priced-in guard correctly turns into a CALL. That attempt
  was wrong, not the engine. The test now pins the priced-in call as
  deliberate, so nobody "fixes" it later.

### One test updated in the same commit

`HorseV18` asserted the squeeze differential inside a hardcoded 0.72-0.74
window — the band under the then-current bar. The price relief moved every
facing-a-3-bet bar down, so the differential relocated to 0.580-0.595 and the
hardcoded window reported the property LOST when it had only moved. Verified
present at the new band _before_ touching the test, then changed to SCAN for
it, pinning the behaviour instead of the coordinates.
