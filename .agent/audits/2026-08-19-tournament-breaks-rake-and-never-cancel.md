# Tournament audit — breaks, rake, and never-cancel (2026-08-19)

Everything below was found by measuring production, not by reading code and
guessing. Each item lists the evidence that proved it broken and the evidence
that proved it fixed.

---

## 1. Tournaments were being cancelled wholesale

**Reported:** a full 9/9 SNG was CANCELLED 15 seconds after it started.

```
id 1a0028e1  started_at 03:14:13  ended_at 03:14:28   (alive 15s)
9/9 entrants, table created 03:14:11, still open at cancel time
```

Platform-wide: 563 CANCELLED vs 243 COMPLETED over two days. By reason,
**557 of 562 were short by exactly ONE player**:

| shortfall                   | count |
| --------------------------- | ----- |
| 2/3                         | 363   |
| 5/6                         | 138   |
| 8/9                         | 56    |
| was RUNNING (restart sweep) | 5     |

**Root causes — six independent cancel paths:**

1. `GameServer` discovery — cancelled anything short of `min_players` 30 min
   past start.
2. `GameServer` §4 (boot) — refunded + cancelled REGISTERING past start by 1h.
3. `GameServer` §5 (boot) — cancelled EVERY running SNG/Spin, on the false
   premise that they "can't survive a server restart". `discoverTournaments()`
   has always resumed RUNNING tournaments ~30s later, so this destroyed exactly
   what the next pass would have recovered — and the engine redeploys on every
   push touching `server/**`, so it fired constantly.
4. `GameServer` §6 (boot) — cancelled RUNNING tournaments stalled >12h.
5. `TournamentManagerBase.start()` — cancelled when fewer than 3 registered.
6. `HorseLifecycleManager` — cancelled SNGs sitting in REGISTERING for hours.

**Fixes:** all six removed. Under-filled tournaments are topped up with horses
and started; boot leaves past-due tournaments for the fill path; a >12h stall
is flipped RUNNING → COMPLETING and paid out through
`recoverStuckCompletingTournaments` rather than voided; `start()` stands down
instead of cancelling; the lifecycle sweep is observability only.
`TournamentManager.resume()` rebuilds tables when none survived, so the one
genuinely unrecoverable state no longer exists.

`grep "status: 'CANCELLED'" server/src` → **no matches.**
`tests/unit/tournamentsNeverCancel.test.ts` walks every server source file and
fails if any of them reintroduces a cancel write.

**Verified:** 0 cancellations since 03:42; 55 tournaments completed since.

---

## 2. The held seat was the cancellation engine

`horsesForSeatHeldGame()` reserved one seat for a human on 9 of every 10
SNG/Spins (`FULL_HORSE_SIM_EVERY_N = 10`). With zero real users that seat was
never taken — precisely the 2/3, 5/6, 8/9 shape above.

**Fix:** `HOLD_SEAT_FOR_HUMAN = false`; every SNG/Spin seeds a full field, MTTs
seed `max(horsesToRegister, maxPlayers)`, and the runtime top-up targets
`max_players` for every format. One flag restores the reserved seat when real
players arrive.

**Safety fix this depended on:** `registerHorses` excluded horses busy in
another tournament but NOT horses sitting at a CASH table — `horse_status` is
never flipped on a cash seat. Measured: 574 horses, **329 seated at open
tables, all 574 still reading `available`**. Filling every seat would have
pulled horses out of live hands. Open-table occupants are now merged into the
same busy set.

---

## 3. Tournament rake was never collected

`fn_register_for_tournament` is `SECURITY DEFINER` on `auth.uid()`, which the
engine cannot satisfy, so horses were INSERTed straight into
`tournament_players` — skipping the buy-in debit, the `rake_records` row and
the prize-pool contribution.

**Evidence (90 minutes):**

```
cash games   5,657 rake records   12,506.44
tournaments      1 rake record         1.00   (a human's, immediately reversed)
tournament_buyin transactions: 1
```

Prize pools were still paid in full, so completed tournaments **minted
~27,000–30,000 chips per day**:

| day    | completed | prizes paid | buy-ins never collected |
| ------ | --------- | ----------- | ----------------------- |
| Aug 18 | 123       | 29,667      | 19,886                  |
| Aug 17 | 126       | 30,266      | 20,572                  |
| Aug 16 | 122       | 27,849      | 18,776                  |

**Fix:** new `fn_register_horse_for_tournament(p_tournament_id, p_user_id)` —
`fn_register_for_tournament` with the caller passed in rather than read from
`auth.uid()`. Identical entry split, wallet debit, rake row and pool updates.
Hard-gated: returns `not_a_horse` for any human; EXECUTE granted to
`service_role` only (revoked from public/anon/authenticated).

**Verified** in a rolled-back production transaction: horse charged exactly 11
(10 buy-in + 1 fee), 1 rake record, prize pool funded 10; a human caller
rejected with `not_a_horse`. Live since 04:17 — 178 rake records, 87.40
collected, treasury credited. A 6-max SNG now reads
`6 × 5 = 30 = prize_pool 30`. The mint is closed.

All 574 horses hold funded PLAYER wallets (avg 1.25M; buy-ins are 1–11), so
this cannot starve the fill path; horses that cannot pay are skipped and the
reason logged.

---

## 4. Synchronized breaks — five defects

Spec: **the last hand is dealt at :55; once every table finishes it, the
5-minute break starts** (so ~5–6 minutes end to end).

**Evidence they were broken** — 04:00, two MTTs, stable engine (platform hand
volume flat 152–195/min, so no restart masked it):

```
03:59 = 17 hands   04:00 = 12   04:01 = 1   04:02 = 10
```

Dealing straight through, and the same at 01:00, 02:00, 03:00.

| #   | Defect                                                                                     | Fix                                                                                                       |
| --- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| 1   | Fired at the TOP of the hour, not :55                                                      | `BREAK_START_MINUTE = 55`, rolls to next hour when past                                                   |
| 2   | 5-min timer armed AT :55, shortening every break by the length of the last hand            | Two phases: announce last hand → `waitForAllTablesParked()` → then start the clock                        |
| 3   | The engine's park self-resumed after a hard-coded **120s** — fatal for a 5-min break       | `pauseAfterHand(maxWaitMs?)`; break asks for `BREAK_DURATION_MS + LAST_HAND_GRACE_MS`; released on resume |
| 4   | `TournamentManagerBase` reaper rebuilt any engine idle >180s with a FRESH, unpaused engine | `if (this.onBreak) return;` plus `!engine.isPausedByDesign()`                                             |
| 5   | `GameServer.discoverCashTables` had a SECOND 180s reaper, never guarded                    | now also checks `!engine.isPausedByDesign()`                                                              |

`isPausedByDesign()` already existed and was already trusted by the turn
watchdog and `/health` — neither reaper consulted it.

**Plus the restart hole:** the pause lives on engine instances, so a redeploy
mid-break built unpaused engines while `on_break` stayed true. `resume()` now
re-pauses for the remaining time and re-arms the resume, and clears a break
that expired while the engine was down. Break state is persisted
(`on_break`, `break_started_at`, `break_ends_at`) — previously in-memory only,
which is why it was unverifiable and lost on restart.

**Verified on a clean 05:55 window (no deploy inside it):**

```
05:53  21 hands     normal play
05:54  33 hands     normal play
05:55  18 hands     LAST HAND announced 05:55:00, hands finishing
05:56   0           break
05:57   0           break
05:58   0           break
05:59   0           break
06:00   0           break
06:01  31 hands     play resumed
06:02  42 hands     normal

break_started_at 05:55:00   break_ends_at 06:00:51   on_break true → false
```

Last hands took 51s, then a full 5 minutes of silence: **5m51s** total.

**Re-verified on the next hour (06:55), with the two reaper commits deployed
(`a13049234` second-reaper guard, `45989915a` `MAX_HEALTHY_PAUSE_MS` ceiling):**

```
06:52  40 hands     normal play
06:53  32 hands     normal play
06:54  30 hands     normal play
06:55   9 hands     LAST HAND announced 06:55:00, hands finishing
06:56   0           break
06:57   0           break
06:58   0           break
06:59   0           break
07:00  12 hands     play resumed 07:00:19
07:01  24 hands     normal
07:02  39 hands     normal

break_started_at 06:55:00   break_ends_at 07:00:19   on_break true → false
```

Last hands took **19s** this window versus 51s the previous one, giving 5m19s
versus 5m51s. That variance is the spec working as intended — the clock does
not start until the slowest table finishes, so the total is 5 minutes plus
however long the last hand runs. Hand rate returned to normal immediately
after the resume, confirming the reaper ceiling did not wedge any table.

---

## 5. Other verified guarantees

| Check                     | Result                                                        |
| ------------------------- | ------------------------------------------------------------- |
| Launch, all three formats | Spins created 3/3 full at 66s old; SNGs 6/6; MTTs on schedule |
| Cancellations since fix   | 0                                                             |
| Completed since fix       | 55                                                            |
| Payout mismatches         | 0 (every tournament paid exactly its prize pool)              |
| Level progression         | Spin 3.2 avg final level / SNG 6.2 / MTT 9.7                  |
| Registration → table      | auto-opens the player's table when a `table_id` appears       |

**Final snapshot at 07:03 UTC** (3.5h after the last cancel-path removal):

| Metric                             | Value                                    |
| ---------------------------------- | ---------------------------------------- |
| Cancellations, last 6h             | 34 — all ≤ 03:39:32, i.e. before the fix |
| Cancellations since 03:39:32       | **0**                                    |
| Completed, last 6h                 | 134                                      |
| Tournament rake rows, last 3h      | 706                                      |
| Tournament rake collected, last 3h | 357.80                                   |
| Open tables                        | 152                                      |
| Hands, last 2 min                  | 407                                      |
| Synchronized breaks confirmed      | 2 consecutive windows (05:55, 06:55)     |

The hourly cancel rate before the fix was steady at 9–15 per hour for at least
twelve hours (19:00 through 03:00). It is zero for every hour since.

Note: Spin & Go prize pools are a MULTIPLIER of the buy-in, not the sum of
buy-ins (a 2x collects 15 and pays 10; a 10x pays 50). Expected value across
the multiplier table is near break-even — the correct structure, not a funding
gap.

---

## Data repairs applied

- `close_seats_stranded_by_cancelled_tournaments` — 12 seats with
  `left_at IS NULL` on CLOSED tables of CANCELLED tournaments, plus 5
  `tournament_players` stuck in registered/playing. Released; asserted zero
  remaining.
- `vary_horse_club_balances` — all 1,465 horses held exactly 50,000 chips,
  which identified them on sight. Spread deterministically (~1.2k–420k).
- `add_tournament_break_state` — `on_break`, `break_started_at`,
  `break_ends_at`.

## Tests added

`tournamentsNeverCancel`, `horsesFillAllSeats`, `tournamentRakeAndBreaks`,
`tournamentRestartSurvival`, `tournamentFilters`, `clubMembersOnlineQuery`.

Several are deliberately source-level assertions: the defects were schema
mismatches and policy violations that a mocked Supabase client would happily
accept (it takes any column name), so mocking would have asserted the mock
rather than the behaviour.

Suite: **1,926 tests across 159 files**, tsc clean on client and server.
