# Spin deep dive + platform sweep

Dan, 2026-08-28: "THERE IS NO CHANCE THAT SPINS ARE WORKING AS DESIGNED."

He was right to push. My earlier "working as designed" rested on 321 events over
21 hours of conservation delta — nowhere near enough to judge a lottery whose
top tier lands once in ~9,900 games. The proper checks are below. The wheel
itself came out clean; almost everything around it did not.

## 1. The wheel: honest NOW, provably rigged BEFORE 2026-08-21

Observed multiplier distribution over 23,781 completed Spins vs `SPIN_TIERS`.

**Post-spec (from 08-21), 21,598 games — clean.** Chi-square 15.87 on 7 df
(p ~= 0.03), no tier meaningfully off, largest cell 10x at 4.46.
E[multiplier] = **2.7572** against a spec of **2.763773** — a miss of 0.59
standard errors (SD 1.6229, SE 0.0111). The draw is `fn_spin_draw_multiplier`:
crypto random over `freq` weights. It is correct.

**Pre-spec (to 08-20), 2,186 games — badly wrong.**

| period       | games  | E[mult]    | 2x share   | spec 2x share |
| ------------ | ------ | ---------- | ---------- | ------------- |
| to 08-20     | 2,186  | **2.6034** | **76.26%** | 47.72%        |
| 08-21..08-27 | 21,242 | 2.7572     | 48.18%     | 47.72%        |

Players were short **842.62 chips on 4,692 wagered — 18% of turnover** — during
that window. This is the era `spinSpec.ts` was written to end: three tables
disagreeing at EV 2.999994 / 2.75 / 2.2415. **Already fixed**; recorded here so
the historical shortfall is a known number rather than a surprise.

**Two hypotheses I formed and then killed with data, so nobody re-chases them:**

- _"Reserve-pool tier locking is skewing the draw."_ No. The starved period has
  **zero** spins with `spin_locked_tiers` populated; the healthy period has
  1,379. The lock gate is not the cause.
- _"It's still distorted right now."_ No. The last 356 games read E = 2.6629,
  which is 1.17 SE below spec. That is noise, not a signal.

## 2. Spin has NO conservation monitoring at all

`fn_tournament_money_conservation` scan predicate:

    AND COALESCE(t.variant, '') NOT IN ('spin', 'satellite')
    AND COALESCE(t.buy_in_amount, 0) + COALESCE(t.buy_in_fee, 0) > 0

The **highest-volume format on the platform is excluded from the money
sentinel**, and so is every freeroll. 23,785 completed Spins have never been
checked by the thing whose job is checking. That — not the wheel — is why
nobody could answer Dan's question, and it is the single most important fix in
this document.

(I also need to correct myself from earlier in the session: I said the sentinel
was one-directional. It is not — it raises "Tournament retained money it never
paid out" for positive deltas too. The exclusions above are the real gap.)

## 3. The Spin reserve accounting is the _healthiest_ money path here

Fully ledgered in `spin_reserve_ledger`, and it reconciles to the cent:

    contribution   +1,434,418.72   (23,793 rows, one per spin)
    seed              +20,000.00   (4 rows, 2026-08-20 activation)
    jackpot_draw   -1,396,980.00   (23,793 rows)
    ------------------------------
    balance            57,438.72   = spin_bonus_pools.balance exactly

Two blemishes, neither a loss:

- **Duplicate seed row.** Two `operator seed` rows share a timestamp to the
  microsecond (19:37:20.539804) and both record `balance_after 5000.00`. Two
  concurrent seeds read the same snapshot; one increment was lost while both
  ledger rows were written. The seeding path needs the idempotency key every
  other money path here already has.
- **`seed_source_wallet` is NULL** on all 20,000. Dan's 2026-08-27 rule is that
  chips leaving a bank must leave a transaction history. These have none, so it
  cannot be shown which bank funded the seed.
- Ledger house_rake 86,337.28 vs `rake_records` for spins 85,922.02 — a
  **415.26** gap worth reconciling.

## 4. The wider sweep — what is actually broken

### CRITICAL: `recalculatePrizePool` excludes horses from the prize pool

`src/services/TournamentService.ts:2097-2117`

    // Horses register free (buy_in 0) and must not inflate the prize pool
    .eq('id', entryUserIds).eq('is_horse', true)
    entryCount = entryRows.filter((r) => !horseIds.has(r.user_id)).length;

**The premise is false.** Last 7 days:

|            | buy-ins     | chips paid in    |
| ---------- | ----------- | ---------------- |
| humans     | 18          | 702.00           |
| **horses** | **104,317** | **2,313,221.00** |

Horses pay 99.97% of all tournament buy-in money, and `fn_register_horse_for_
tournament` correctly charges them and adds `v_split.prize` to `prize_pool`.
This client function then **recomputes the pool from scratch with every horse
removed and overwrites the correct value** — it runs after every rebuy, add-on
and re-entry (`:1843`, `:1958`, `:2065`). A 50-horse event that one human
re-enters has its pool rewritten to one entry's worth.

This is a direct breach of the HORSES ARE PLAYERS law, in a money path, and it
is the most likely mechanical source of guarantee overlays binding far more
often than they should. Not yet fixed — it needs the horse filter deleted, and
the four unchecked reads around it given error handling, in one change.

### CRITICAL: four money reads that cannot see an error

Same function, `:2103`, `:2109`, `:2136`, `:2167` destructure `{ data }` without
`{ error }`. supabase-js does not throw on PostgREST errors, so a failed read
yields `null`, the enclosing try/catch never fires, and `prize_pool` is
overwritten with a confidently wrong number. No `.range()` either, so a large
MTT is silently truncated by the default row cap.

### HIGH: per-hand recount can flip a live table to 'waiting'

`server/src/engine/ServerTableEngineSettlement.ts:1682-1688` — `const finalCount
= dbPlayerCount ?? 0` on an unchecked count, at the end of **every hand**. A
failed read sets `current_players = 0` and broadcasts `seated_count: 0`.
`TableService.ts:465` does the identical recount and checks `countErr` first;
the engine path is the one missing it.

### HIGH: union governance fails OPEN

`src/services/TournamentService.ts:448-458` — a JSON parse failure sets
`allowCrossClub = true`, re-enabling cross-club tournaments for a union that
explicitly disabled them. Permission checks must fail closed.

### MEDIUM

- `TournamentTimerService.ts:477-489` — malformed `blind_structure` degrades to
  an empty ladder; breaks never fire, no log.
- `server/src/services/supabase/rake.ts:107-121` — union rake audit rows written
  with `balance_after: null` from an unchecked read.
- `useTableChat.ts:278,302,337,361` — four bus listeners for events nothing
  emits client-side. `PRE_ACTION_EXECUTED` **is** sent by the server
  (`PreActionEngine.ts:314`) and dropped by the client bridge, so auto-fold,
  straddle, winner and showdown narration are all silently missing from chat.

### Clean (checked, so nobody re-spends the time)

Zero skipped tests. No `@ts-ignore`. No real TODO/FIXME markers. 288 of 289
client `.rpc()` names exist server-side; the one gap is a manifest artefact with
a real migration behind it. `payoutStructure.ts` correctly closes the 120%
overpay hole.

## 5. Platform-wide conservation, both directions

|                                       | events | chips           |
| ------------------------------------- | ------ | --------------- |
| minted (paid out more than collected) | 14,288 | **-456,499.68** |
| stranded (collected, never paid out)  | 11,193 | **+206,116.27** |
| balanced                              | 18,395 | -0.05           |

Net **-250,383**. The stranded 206k is players' own money that went nowhere and
has had no attention at all.

## Ranked next actions

1. **Delete the horse filter in `recalculatePrizePool`** and make the function
   refuse to write when any input read failed. Highest value, clearly in scope,
   and it is a standing breach of a binding law.
2. **Bring Spin and freerolls into the conservation sentinel.** Remove the
   variant exclusion; give Spin a reserve-aware delta so it is measured against
   `spin_reserve_ledger` rather than a naive pool comparison.
3. **Fix the engine's per-hand `?? 0` recount** (`ServerTableEngineSettlement.ts:1687`).
4. **Fail closed** on the union cross-club parse.
5. Idempotency key + `seed_source_wallet` on Spin pool seeding; reconcile the
   415.26 rake gap.
6. Still Dan's, from earlier today: the 453,571.88 pre-funding amnesty tie, and
   the 31,412.80 owed to players behind it.

---

# Addendum: the open queues, and what is left

Written 2026-08-28 04:00 UTC after opening every `financial_alerts` queue.
**3,753 alerts are open.** Almost none of them have ever been read.

## The live money leaks, ranked

### 1. FeeReconciler.queue_failed — 1,459 critical, 4,331.43 chips out of pots

    "[A5] Could not queue unbanked rake for hand 3101845 (rake 0.8, bbj 0):
     Could not query the database for the schema cache. Retrying..
     These chips left the pot and are now recoverable only by hand."

Rake taken out of a real pot that never reached a bank. By day: 97.58 (08-22),
1,371.77 (08-23), **2,622.98 (08-24)**, then 73.31 / 103.87 / 56.12 / 5.80 — the
spike is over but it is still bleeding a few chips a day.

**"Recoverable only by hand" is no longer true, and that is the opportunity.**
`FeeReconciler.ts:183` was upgraded on 2026-08-22 to write the WHOLE payload
into the alert context — `pot`, `numPlayers` and `contributions`, the per-player
split — precisely because a summary "names chips nobody can safely re-drive".
Every field `atomic_distribute_rake` needs is sitting in
`financial_alerts.context` for all 1,459 rows. The code also already calls
`feeIsAccountedFor()` before alarming, so these are the genuinely-unbanked ones,
not the 93% that were noise.

So a re-drive sweep is buildable today: read the context, re-check
`feeIsAccountedFor`, call `atomic_distribute_rake` with the stored
contributions, resolve the alert. **This is the single highest-value piece of
work left on the platform.** It is deliberately not started here — re-driving
rake needs its own careful probe cycle, not the tail end of a long session.

### 2. fn_close_settlement_period — 240 warnings, "Player rakeback deferred: club treasury cannot fund payout"

Players earned rakeback and did not get it because the treasury was empty. Same
root cause as the guarantee overlays: `clubs.chip_treasury` cannot fund what the
club promised. Needs the same answer.

### 3. WalletService.logTransaction — 197 critical, "Transaction log failed after successful financial operation - audit trail gap"

Money moved and the audit row did not. The operation succeeded, so no chips are
missing — what is missing is the ability to prove it. 197 holes in the ledger.

### 4. UNION LAW self-test — failing NOW (00:20 today)

    breaches: [
      { check: "record_tournament_buyin_rake_law_missing" },
      { check: "money_path_not_club_scoped",
        functions: ["atomic_cancel_tournament", "credit_player_wallet"] }
    ]

The law's own self-test says two money paths are no longer club-scoped and one
rake law is missing outright. This is a guard reporting that it has been
breached, every night, to nobody.

### 5. fn_union_treasury_selftest — "Union treasury conservation breach: lapsed_week_unclosed"

A settlement week lapsed without being closed. That is the same weekly close the
guarantee overlays and the deferred rakeback are both waiting on.

### 6. FeeReconciler.bbj_unlinkable / bbj_drift — 173 + 79

BBJ contributions on `rake_records` rows with no `hand_id`, so neither the audit
nor `fn_bbj_repair_unbanked` can reconcile them. The alert text names the cause:
"logHandHistory is failing and returning a null id."

## Performance

Supabase advisor, 1,461 lint entries. Acted on today (safe regardless of the
stats window): **12 unindexed foreign keys indexed** — including
`tournament_rake_settlements.club_id` and `tournament_guarantee_overlays.club_id`,
both on tables that grow with every tournament — and **2 verified duplicate
indexes dropped**.

**NOT acted on, deliberately:** the 1,391 `unused_index` findings totalling
**1,708 MB**. Postgres restarted 1h46m before the advisor ran, so every "unused"
verdict rests on under two hours of traffic and would condemn every nightly-cron
and weekly-settlement index. Re-run after 7+ days of uptime and drop only what
is unused in both passes. The prize when earned is led by
`idx_hand_history_players_gin` (180 MB) and `idx_rake_records_contribs_gin`
(34 MB) — two GIN indexes maintained on the platform's two hottest insert paths,
~220,000 and ~54,000 rows a day.

Also worth scheduled work, not a one-liner: **52 `multiple_permissive_policies`**.
`union_overseer_read` was added alongside an existing read policy on ~15 tables,
so every row read evaluates both. The ones that matter at scale are `table_seats`
(read constantly by every connected client), `rake_records`, and `club_members`
(four permissive policies).

## Still Dan's to decide

1. **453,571.88** of pre-funding historical minting — fund it, or restore the
   amnesty as explicit acknowledged data. Two agents have ruled opposite ways.
2. **31,412.80** owed to real players across 114 events, unblocked the moment
   (1) is answered.
3. **206,116.27 stranded** across 11,193 events — money players paid that was
   never paid out to anyone. Nobody has looked at this at all.
4. **Two events with two winners each** (~389 chips).
