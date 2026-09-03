# 2026-08-30 — The big blind ante that charged one big blind per seat

Dan, on the tournaments: _"THERE ISN'T ANY 3 BETTING FOR SIZE, JUST 3 BET ALL
IN'S... ALSO SEEING OPEN RIPS FOR LARGE BB DEPTH WITH WEAK Ax hands."_

Both symptoms were real, both came from one line, and the line was not in the
horse brain.

## What production was doing

Forty minutes of tournament hands, before the fix:

| mode        | 3-bets | all-in    | opens | all-in    |
| ----------- | ------ | --------- | ----- | --------- |
| **tourney** | 254    | **85.4%** | 621   | **55.7%** |
| cash        | 54     | 3.7%      | 353   | 0.0%      |

182 of the open jams were deeper than 25bb, the deepest at 72bb. The deepest
3-bet jam was **184bb**. Cash — which the cause could not reach — was healthy,
which is what ruled out a range bug early.

## The cause

`tables.ante` means one of two things and the schema does not say which:

- **per-player** — everyone owes `ante` each hand, authored as ~0.1 × BB so a
  ten-handed table collects about one big blind. **10,301 tournaments.**
- **total** — `ante` IS the whole big blind ante, posted once by the BB,
  authored as exactly 1 × BB, which is the modern standard. **2 tournaments.**

`HandController` multiplied by the seat count unconditionally:

```ts
const totalBBA = this.config.ante * activePlayers.length;
```

So a structure written the second way charged the big blind one big blind
**per seat**. Measured live in "Sunday $200 Deep Stack": exactly one ante
posting per hand, averaging **7.00 big blinds**, over 40 sampled hands.

The horse brain then read an orbit as costing 9.5bb instead of 2.5bb — because
it derives Harrington M from the same ante figure, carrying the same
per-player assumption _independently_ — and computed a perfectly correct M of
3.1 for a 39bb stack. At M 3 every game is jam-or-fold. **The horses were not
misplaying. They were playing an impossible table correctly.**

This only became reachable three days ago: `TournamentAnte.test.ts` records
that before 2026-08-27, `ante_enabled` was false on all 93,416 tables and _no
ante had ever been posted anywhere_. The multiply had been wrong the whole
time with nothing flowing through it.

## The fix, in two independent parts

**One resolver, both callers** (`AnteMath.ts`). Fixing the engine alone fixes
nothing: it would collect the right ante while the brain still believed an
orbit cost 11.5bb, and the horses would go on shoving into a table that no
longer justified it. `ante >= bigBlind` is only ever written by a structure
that means the total, so that is how it is read; a `BBA_CEILING_BB = 2`
backstop catches anything that is neither convention. The per-player
convention is byte-identical — 0.100 × BB still collects 1.00 BB at ten seats,
0.125 × BB still collects 1.25 BB, and the existing `HandController`
big-blind-ante test (ante 2, 2 seats, BB 10 → 4) is unchanged.

**The depth cap the gate never had.** `pushFoldNlh` reads
`stackBB <= 12 || (mzOn && effM < 6)`, and the second disjunct had no depth
cap — while _both_ later jam branches carry `stackBB <= 22` with comments
naming this exact failure ("so a big-ante deep stack does not jam 30 blinds").
The gate deciding whether the whole strategy is jam-or-fold was the one
without the guard. It now caps at the same 22bb, because inventing a second
convention would be worse than reusing the siblings'.

The two are deliberately independent: **either one alone** stops a 39bb stack
shoving, so one mis-authored blind structure can never resurrect this.

### The subtlety that nearly broke a real feature

A flat cap silently repealed V23's blind clock, whose own test says it jams a
30bb stack _"past the 22bb orange-zone cap"_ when the blinds are about to
double. That is a documented, deliberate feature. So the cap is read in the
**same currency as the M it guards**: if we play next level's M, we play next
level's depth too. A 30bb stack two minutes from doubled blinds is a 15bb
stack, and still jams. A 60bb stack does not.

## The A/B, through the full decide path

400 randomly dealt hands per cell, 8-handed, BB 1,000, big blind ante on:

| open-jam rate        | 39bb                   | 50bb                   | 72bb | 9bb   |
| -------------------- | ---------------------- | ---------------------- | ---- | ----- |
| **the shipped code** | **19.3%, zero raises** | **19.8%, zero raises** | 0%   | 19.3% |
| **fixed**            | 0%, 66 raises          | 0%, 77 raises          | 0%   | 19.0% |

At 39-50bb every voluntary open was a shove and there was not a single sized
raise — which is precisely what Dan reported. The 9bb column is the control:
push/fold is untouched.

The 72bb column is the accidental proof. Pre-fix, effM at 72bb is
`(72 / 9.5) x 0.8 = 6.06`, a hair ABOVE the `effM < 6` gate, so 72bb is the
deepest stack the bug could reach — and 72bb is exactly the deepest open jam
production recorded. The arithmetic and the hand histories agree to the blind.

**One honest note on method.** The first attempt at this A/B restored both
defects and reported no change, because `BBA_CEILING_BB` still clamped 8,000
to 2,000 and the run never reproduced the original at all. A mutation that
does not reproduce the bug proves nothing. The table above uses the faithful
pre-fix formula: `(ante x seats) / bb`, no total-detection and no ceiling.

## Verification

- `npx tsc --noEmit` clean.
- engine **125 files / 1,438 tests**, services **50 / 538** — all pass.
- 24 new tests across `AnteMath.test.ts` and `TournamentJamDepth.test.ts`.
- **Three mutations, each caught by its own pins, green restored after each:**
  removing the depth cap (3 fail), restoring the unconditional seat multiply
  (5 fail), and shrinking M without shrinking depth (2 fail).

## Not changed, deliberately

The two mis-authored blind structures are left as they are. The engine now
reads them correctly, which fixes every running table without editing live
tournament data — and the ceiling means the next one cannot do damage either.
