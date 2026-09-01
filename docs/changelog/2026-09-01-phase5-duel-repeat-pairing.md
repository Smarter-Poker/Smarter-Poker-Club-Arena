# Phase 5 of 7 - integrity: a pair that keeps meeting heads-up is worth looking at

2026-09-01. Branch `phase5/duel-pairing-signal`.

Phase 5 is six items. This ships 5.3's measurable half. It also corrects the
audit on 5.1, 5.2 and 5.4, all three of which describe a platform that has
moved on since the handoff was written - the evidence is below, because a
stale audit is how an agent ends up building a second copy of something that
already works.

---

## What shipped: `fn_ca_duel_pairing_scan`

Applied as migration `ca_duel_repeat_pairing_signal`, scheduled as pg_cron
`ca-duel-pairing-daily` at 04:35 (fifteen minutes after the chip-flow scan, so
the two land in the same review window without contending for the same read).

It flags a pair of accounts that met heads-up **8 or more times in 7 days**
with a **win share of 0.8 or better**, writing to `ca_collusion_signals` beside
the chip-flow signals and raising a graded incident on the same path.

**It blocks nothing.** A re-entry limit, a cooldown or a daily cap is a
decision about how people are allowed to play, and that is Dan's to set. This
measures and reports.

### Why the existing detector does not cover it

`fn_ca_collusion_scan` groups by SHARED HANDS out of `ca_hand_transfers` and
needs 20 of them before it looks at a pair. Two accounts meeting in eight
separate duels, each a handful of hands long, never reach that floor. The
repetition itself is the signal and nothing was measuring it.

### Calibration, from the board rather than from a guess

Duels completed in the seven days to 18:00 UTC, 10,134 of them:

| met | pairs |
| --- | ----- |
| 1x  | 6,454 |
| 2x  | 1,106 |
| 3x  | 222   |
| 4x  | 40    |
| 5x  | 7     |
| 6x+ | 0     |

The floor is eight, sixty percent above the observed maximum. What each
threshold would flag today, both conditions applied:

| threshold | pairs flagged |
| --------- | ------------- |
| 3         | 77            |
| 4         | 9             |
| 5         | 5             |
| 6         | 0             |
| **8**     | **0**         |

Win share alone is worthless down there - 6,454 pairs met once, and every one
of them has a "100% win rate". Both conditions must hold.

That is 5.2's lesson applied at the point of writing rather than after the
fact: the legacy `collusion_tracking` table holds 169,523 flags cleared at an
average suspicion of **96.8** with a minimum of **70**, which is what a
detector calibrated to noise looks like.

### Horses are players

There is no `is_horse` predicate in this scan and there must not be one
(CLAUDE.md 10.5). A horse pair meeting eight times with an eighty percent win
share is a fleet problem worth the same look, and the calibration above was
measured on a board that is horse-heavy already.

### Verification

- Applied through `apply_migration`, one transaction, one schema reload.
- `SELECT fn_ca_duel_pairing_scan(7)` returns
  `{"ok":true,"min_meetings":8,"min_win_share":0.8,"pairs_flagged":0}` - no
  false positives on the live board.
- `cron.job` shows `ca-duel-pairing-daily`, schedule `35 4 * * *`, active.
- `anon` cannot execute it.
- **Probed inside a block that was rolled back** (CLAUDE.md 11.5): with the
  floor lowered to 5 the guard flagged 5 pairs and wrote 5 rows - first one
  5 meetings, win share 0.800, 135.85 chips net - then a `RAISE EXCEPTION`
  aborted the block. `ca_collusion_signals` is back to 0 rows, no probe rows
  and no stray probe functions remain.

---

## Corrections to the audit

### 5.1 chip-dump detection is NOT dead

The handoff says "there is no SQL function that WRITES chip-dump flags... the
detector itself has to be built". `fn_ca_collusion_scan` shipped on 2026-08-31
in `ca_phase4_cert_segregation_diamond_audit_collusion_v1`. It reads
`ca_hand_transfers`, groups pairs, and flags on 20+ shared hands, 5,000+ net
flow and a direction ratio above 0.8. Its cron `ca-collusion-daily` is
**active** and **ran at 04:20 today, succeeded**.

It has produced no signals because there is nothing to find yet: **2 humans
were seated anywhere in the last 7 days** (449 human accounts exist), and of
1,367 hand transfers in that window exactly **1** is human against human.

No second detector was built.

### 5.2 the noise is in the retired table

The 169,523 flags at 96.8 live in `collusion_tracking`, which **nothing writes
any more** - `detect_collusion_pairs` only reads it. The live surface is
`ca_collusion_signals` with graded incidents. The recalibration the audit asks
for is what the new detectors' thresholds already are.

### 5.4 "no notice to either player" is wrong

The disconnect notice is wired end to end. The engine publishes
`is_disconnected` per player in three snapshot paths
(`ServerTableEngine.ts:347, 605, 714`), `mapEngineSnapshot.ts:274` maps it to
the `disconnected` seat status, and the client renders both a hero
`DisconnectToast` with a live countdown and a per-seat overlay.

The time-bank half is closed too: `DisconnectMidTurnTimeBank.test.ts`
(2026-08-26) pins that a mid-turn disconnect must not spend a time bank and
must not move the deadline.

What is genuinely absent is **all-in / disconnect protection at two players**
and a **pause at two players**. Both are product decisions about what a player
is owed when their connection drops, not defects, and they are Dan's to make.
They are recorded here rather than invented.

### 5.5 shipped earlier today

`596eaed4a` - a sat-out seat now acts on the same 350/1250 ms floors a horse
uses instead of folding at zero milliseconds.

---

## Phase 5 status

| item                                      | state                                                                        |
| ----------------------------------------- | ---------------------------------------------------------------------------- |
| 5.1 chip-dump detection                   | already shipped 2026-08-31, cron active, ran today                           |
| 5.2 scoring calibrated to noise           | noise is in the retired table; live thresholds are strict                    |
| 5.3 duel re-entry limits                  | **signal shipped here**; the limits themselves need Dan's ruling             |
| 5.4 heads-up disconnect protection        | notice and time bank already correct; protection and pause need Dan's ruling |
| 5.5 sit-out beat                          | shipped, `596eaed4a`                                                         |
| 5.6 insurance / run-it-twice at 2 players | needs Dan's ruling                                                           |
