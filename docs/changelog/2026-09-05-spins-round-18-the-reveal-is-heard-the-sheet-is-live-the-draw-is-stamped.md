# Spins, round 18: the reveal is heard, the sheet is live, and the draw is stamped

2026-09-05. Follows round 17 (PR #3085, live in `176e6b7b`) and continues on the
same branch, `agent/claude-spins/fix/spins-sit-sound-prize-and-felt` (PR #3125).

Dan: "THESE ARE MAJOR BUGS AND ISSUES THAT ALL NEED TO BE FULLY FIXED, ENHANCED,
IMPROVED AND OPTIMIZED", and separately "YOU NEED TO INSURE THAT REAL TIME
CONNECTIONS ARE FULLY ADDED TO THIS AND CHECK WITH THE LAWS OF THE CHIP
ACCOUNTING ROADMAP".

---

## 1. The reveal had cues, was calling them, and could not be heard

Round 17 built the spin's four sound cues, wired them, and Dan still reported no
sound and no countdown. Every cue existed and every one was called. `shouldPlay`
was throwing them away.

`shouldPlay` is a winner-takes-the-frame gate: `rank <= currentFramePriority`
rejects, and the winner holds the frame for 50ms. That is the right rule for a
felt where a fold and an all-in land together and only one of them should be
heard. It is the wrong rule for a reveal, because the four cues are consecutive
movements of ONE animation, and 10.6 owes every one of them, for its full
duration, every time.

Three ways it silenced them, all reachable in production:

1. **A client that arrives mid-reveal.** `at()` in SpinWheel clamps every beat
   already in the past to 0, so start, countdown, ticking and result are all
   scheduled into the same frame. `playSpinStart` (`big_win`, 95) went first and
   took the frame; the countdown and the ticking (`ui`, 10) were rejected, and
   `playSpinMultiplierResult` was rejected too - it is also 95, and the
   comparison is `<=`. A late joiner heard the lever and then nothing at all,
   **including the result**.
2. **Two `ui` cues in one window.** `ui` is rank 10 and the gate is `<=`, so the
   second `ui` cue inside any 50ms window is always rejected.
3. **The wheel silenced the table.** `playSpinStart` parked the frame at 95 for
   50ms, so a deal, a chip or a fold arriving beside the lever was eaten by the
   wheel.

`playPotCollect` hit exactly this in August and the answer recorded in that
method is the answer here: a companion cue leaves the rank window and dedupes on
its own clock. `tests/animations-always-play.law.test.ts` already pins that
`playPotCollect` does not call `shouldPlay`.

The four spin cues now go through `shouldPlaySpinCue(cue, minGapMs)`, which
keeps the master-switch gate (`this.enabled && isSoundAllowed()`) and nothing
else. The countdown's throttle is keyed per step, so three lights are three cues
rather than two duplicates of the first. The wheel no longer suppresses the felt
and the felt no longer suppresses the wheel.

Guarded by four new pins in `tests/unit/spinsSitSoundPrizeAndFelt.test.ts`.

### A trap in the shared source-pin helper, found writing those pins

`sliceMethod(src, signature)` derives the closing indent from the text BETWEEN
the line start and the match. Pass `'  playSpinStart('` - the signature with its
own indent - and the computed indent is `''`, so the closer matches the CLASS's
final `\n}` and the window silently becomes the rest of the file. Every negative
assertion in it then passes for the wrong reason, which is precisely the
blindness `tests/helpers/sourceWindow.ts` was written to prevent. Two of my own
new pins failed loudly first, which is the only reason it was caught. The header
of `sliceMethod` now says: pass the signature without its leading indent.

---

## 2. The quick-join sheet was a snapshot of a board that fills in seconds

Dan's round-17 item 6 gave the "+" button a spin sheet. It read once, when the
button was pressed, and never again.

A spin board is not a cash table with seats to browse: there is one open board
per stake, two of its three seats are usually already taken when the sheet
renders, and the fleet takes the last one within 90-350 seconds of a human
sitting (`TournamentRecurringService`). So the row a player taps can already
have started.

`tables` and `tournaments` are both in the `supabase_realtime` publication, so
the fill was already on the wire with nothing listening. `MultiTablePage` now
subscribes to both for exactly as long as the sheet is on screen, debounced at
700ms because one board filling writes the tournament row, its table row and the
recycler's replacement in the same breath.

It never touches `loading`. Re-running the loader would set
`{ loading: true, rows: [] }` and flash a spinner over a list the player is
reading, which is worse than the staleness; the refresh re-asks the same
question and patches the rows in place. A `null` answer - the read failed, or
the boards vanished - leaves what is on screen alone rather than emptying the
sheet. The spin branch stores its own arguments and the cash fall-through clears
them, so a cash sheet is never overwritten by a spin refresh.

Five pins.

### The first version of that subscription was a firehose, and a law caught it

`tests/no-unfiltered-realtime-firehose.test.ts` failed on the first draft. My
listeners named `tables` and `tournaments` with no `filter:`, and that law exists
because unfiltered listeners on exactly those tables produced roughly 80% of 86
million realtime messages in one billing cycle. This effect mounts for every
player who presses "+", so it would have been a fair reproduction of the
original incident. It is now one listener per scope club id, `club_id=eq.`, the
same shape `ClubHomePage` uses.

The second draft had a quieter bug that came out of the same rewrite: the scope
was held in a **ref**, and the loader is async, so `quickJoin.open` goes true a
round trip BEFORE the spin branch knows its scope. An effect keyed on `open`
alone reads a null ref, returns, and never runs again - live coverage armed only
from the second opening of the sheet onward. The scope is state now and the
effect is keyed on both.

### The rest of the spin surfaces were already live

Checked rather than assumed: `TablePage` carries both the engine's `SPIN_REVEAL`
room broadcast AND a `postgres_changes` UPDATE on `tournaments` filtered to the
table's own tournament (two independent paths to the same reveal);
`ClubHomePage` subscribes to `tables` and `tournaments` by club id and by union
id; `TournamentDetails` and `TournamentLobbyPage` each carry their own
subscriptions. The quick-join sheet was the only spin surface with no live
connection at all.

---

## 3. Four spins completed on 2026-09-01 without stamping their draw

`spin_multiplier IS NULL` on four COMPLETED spins. There is already a repair for
this on a `*/15` cron, `fn_spin_repair_missing_multiplier`, and it had never
seen them - for two separate reasons, each a defect of its own.

**It refused to look at a spin that never started.** The scan carried
`AND t.started_at IS NOT NULL` and bounded its window on `started_at`. All four
have `started_at IS NULL`. The one condition that made them broken was also the
condition that hid them from the repair, for four days. Selection is now on
`COALESCE(started_at, created_at)`.

**It reconstructed the multiplier from the prize pool, and would have been wrong
on half of them.** `prize_pool / buy_in_amount` is the drawn multiplier only
once the draw has been applied to the pool. On a spin that lost its draw the
pool is still the DEFAULT - the sum of the three buy-ins - so the ratio reads
3.0 on every three-handed spin whatever was drawn. Measured on these four: the
ratio says 3, 3, 3, 3. The reserve ledger says 3, 3, 2, 2.

CLAUDE.md 10.9, "prefer the witness that was there". The `jackpot_draw` row in
`spin_reserve_ledger` is written by `fn_spin_settle_game` with the multiplier the
engine actually drew, at the moment it drew it. The pool ratio is an inference
from a number that was never updated. The ledger is now read first; the ratio is
the fallback for a spin with no draw row at all.

Migration `20260905161235`. Backfill asserted at exactly four and applied to
production; `still_unstamped` is now 0 and the four read `2, 2, 3, 3` - the
witness, not the ratio.

### 103 chips that are not being taken back

Two of the four were paid the un-multiplied pool by the recovery settlement on
2026-09-02, which read `prize_pool`: 300.00 where the draw was 2x100, and 9.00
where the draw was 2x3. 100.00 and 3.00 more than the draw. That overpay is ours
and 10.9 rule 3 leaves it with the players. `prize_pool` is not rewritten either,
so the record still shows what each player was actually paid. The gap is named
in a resolved `financial_alerts` row rather than absorbed silently, and the
repair function now reports the same gap on any future occurrence.

The same era left 27 more spins whose reserve draw and tournament multiplier
disagree (`v_spin_draw_booking_gaps` lists 11). Across all 31, from 2026-08-22 to
2026-09-01, the reserve released 1,961.00 against 2,083.00 credited to winners,
so the spin reserve reads 122.00 richer than the chips it holds against those
events. No chips are moved for that: the money reached the right players and the
residue is one internal pool. It is recorded in the same alert. **Zero
recurrences in the 23,855 draws since 2026-09-02.**

---

## 4. A correction: nothing was minted

Earlier in this session I reported that 214 of 620 cancelled spins had refunded
more than they charged, 9,475 chips, and I called it minting. **That was wrong
and I am correcting it before anything is built on it.**

`wallet_transactions` for the worked example carries BOTH debits (2 x 100.00
`tournament_buyin`, 2026-09-02 00:34:38) and both credits (2 x 100.00 `refund`,
01:09:19). The debits exist. The refunds were legitimate. What I had actually
found was that 360 of those 620 spins had no `tournament_escrow` row, so there
was nothing to compare the refund against - a missing measurement, not missing
money.

Re-measured today against the escrow that now exists:

| population      | n     | in                                    | out                | balance left | R1 breaches | R5 breaches |
| --------------- | ----- | ------------------------------------- | ------------------ | ------------ | ----------- | ----------- |
| CANCELLED spins | 274   | 13,280.00                             | 13,280.00 refunded | 0.00         | 0           | 0           |
| COMPLETED spins | 3,659 | 260,352.00 gross + 238,786.00 reserve | 238,786.00 prize   | 0.00         | 0           | 0           |

R8/R9 over the last 24 hours, 7,032 spins with wallet legs: 0 buy-in legs
missing from `chip_ledger`, 0 refund legs missing, 0 prize legs missing, 0
suspense rows.

**The lesson worth keeping: an absent escrow row does not read as absent. It
reads as an imbalance, and it reads exactly like theft.** That cost several
hours and produced a false accusation against the platform.

---

## 5. Chip accounting roadmap: where spins actually stand

Escrow began being written for spins at **2026-09-05 03:00 UTC** - a clean
cutover, verified hour by hour: 0 spins without a row in every hour since, and
100% without one before. That is another agent's Phase 5.2 work (roadmap updated
08:00 UTC today) and none of it is touched here.

Against the standard's hard rules, for spins:

- **R1** (never pay more than escrow holds) - 0 breaches in 3,933 settled spins.
- **R4** (pool <= contributions) - holds; cancelled spins refund exactly gross in.
- **R5** (escrow zero at completion/cancellation) - 0 non-zero balances.
- **R8/R9** (the journal names the account; suspense must be zero) - 0 missing
  legs and 0 suspense rows in 24 hours.
- **R11** (horses and humans identical) - unchanged by anything here.

Still open, and deliberately not done here:

- **`enforced` is false on every spin escrow row.** The roadmap says spins stay
  "tracked, not refused, until a soak". The soak is now 13 hours and 3,933
  settled spins with zero breaches, which is real evidence but is one day of it,
  and the switch being flipped is one that can REFUSE a payout mid-settlement.
  The measurement is recorded here; the flip belongs to the agent who owns Phase
  5.2 and to a longer window than one afternoon.
- **The `SPIN_TIERS` EV rebalance** (2.7638 against a 2.760 target, effective
  rake 7.874%) is Dan's, per the roadmap.

---

## Files

- `src/services/SoundService.ts` - `shouldPlaySpinCue`, and the four cues moved
  off `shouldPlay`
- `src/pages/MultiTablePage.tsx` - the live spin sheet and `spinQuickJoinArgsRef`
- `tests/helpers/sourceWindow.ts` - the indent trap, documented on `sliceMethod`
- `tests/unit/spinsSitSoundPrizeAndFelt.test.ts` - nine new pins
- `supabase/migrations/20260905161235_the_repair_sees_a_spin_that_never_started_and_believes_the_d.sql`
