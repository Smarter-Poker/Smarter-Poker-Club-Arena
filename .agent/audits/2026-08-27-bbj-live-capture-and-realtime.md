# BBJ: does it capture and update itself when a jackpot actually hits?

Dan, 2026-08-27:

> when your done with the design work, run a thorough deep dive and audit to make
> sure that this functionality exists to auto update and capture this info when a
> BBJ does hit... that it can recognize the event when it happens, and auto
> update in real time.

Short answer: **detection and payout are real and correct. Capture of the HAND
was being destroyed a week later, and the one surface a player opens after a hit
was the only one not live.** Both are fixed. Three smaller gaps are recorded and
not fixed.

---

## 1. Detection — real, wired, and on the hand-completion path

`detectBBJHit` (`server/src/config/RakeConfig.ts:608`) is called from the
WINNERS / HAND_COMPLETE handler in
`server/src/engine/ServerTableEngineSettlement.ts:709`, gated at `:672` on the
table's `bbj_percent`, at least two showdown results and a winner. It is not
dead code.

The rules it actually enforces (`RakeConfig.ts:346` `BBJ_RULES`, `:226`
`BBJ_QUALIFYING_HANDS`):

| Rule                                                                                                                                             | Where                                                |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------- |
| At least 3 dealt in, pot at least 10 BB                                                                                                          | `RakeConfig.ts:620-622`                              |
| Loser minimum per variant — NLH/FLH aces full of jacks **with an ace in the hole**; PLO/PLO4/PLO8/FLO8 quad kings; PLO5 an 8-high straight flush | `BBJ_QUALIFYING_HANDS`                               |
| **Winner must hold quads or better**                                                                                                             | the 2026-08-18 fix that ended boat-over-boat hits    |
| Both hole cards must play (NLH/FLH/pineapple; Omaha enforces it by rule)                                                                         | fails **closed** when the board is not fully visible |
| PLO6 and short deck are `eligible: false`                                                                                                        | never pay                                            |

The fee drop is separate and lives in `HandController.ts:1691-1698` —
`enabled && sawFlop && playersDealt >= min && potBB >= min`, reduced before rake
if `rake + fee > pot`.

## 2. Payout — writes all three tables, including the table share

`server/src/services/supabase/bbj.ts:334` calls `bbj_atomic_payout_v2`, reached
from `runStep('bbj_payout')` at `ServerTableEngineSettlement.ts:1407`.

It debits the pool **main balance only** (the backup reserve is never a payout
source — Dan 2026-08-18), writes `bbj_payouts`, calls
`bbj_credit_one_recipient` for the bad-beat holder, the hand winner **and every
other player dealt in**, and writes `bbj_winners`. Recipients are credited to
the seat if still seated and to the wallet if departed. Replaying a hit is
idempotent and re-drives any missing credit.

Measured, all 29 payouts in production:

```
payouts with zero recipients ................ 0
payouts whose recipients do not sum to total  0
```

So the live path has been paying the table share correctly all along. The
missing table-share rows fixed earlier today were in the **seeded** payouts
only, not in anything the engine wrote.

## 3. The hand — WAS BEING DELETED, now protected

This is what the audit was for.

```
bbj_payouts rows ............................ 29
  with a matching hand_history row ..........  5   (all seeded)
  with NO matching hand row ................. 24
bbj_payouts.hand_id NOT NULL ................  0
```

All 24 are real engine hits — `metadata` carries `status: completed` and both
hand names, and each has 4 to 7 recipients. The hand was written at the time
(`runStep('hand_history')` at `:1009` runs _before_ the payout at `:1407`, so
the ordering is right). It was **pruned afterwards**.

`sp_prune_hand_history` deletes hands older than
`hand_history_retention_policy.horse_retention_days` (7) when every player dealt
in is a horse. Correct for the ~1.5M hands a week the fleet generates;
catastrophic for the handful that hit the jackpot, because the winners list
keeps the last five hits **forever** while the hand behind each one evaporates
after a week. And there is no repair path: `bbj_atomic_payout_v2` hardcodes
`bbj_payouts.hand_id` to NULL, so `(table_id, hand_number)` is the only link and
a deleted row cannot be rebuilt.

**Fixed** — migration `jackpot_hands_are_never_pruned`: a hand a `bbj_payouts`
row points at is no longer a prune _candidate_, so it is never marked, counted
or locked. Indexed with `idx_bbj_payouts_table_hand`. This protects tens of rows
out of millions; retention is materially unchanged.

The five seeded hands survived only by accident — something had set
`has_human = true` on them, which is the other skip condition, and all five are
already past the window with zero human players. They are protected on purpose
now.

## 4. Real time — the pool was live, the winners list was not

Already live before today:

- `TablePage.tsx:6519` `bbj_hit`, `:6554` `bbj_payout_complete` → `BBJCelebration`,
  deduped by `src/lib/bbjHitOnce.ts` so a refresh does not replay it
- `TablePage.tsx:4420` `bbj_pools` UPDATE → the pool ticker at the table, and a
  `hit_count` increment raises `BBJ_HIT_GLOBAL` so a hit at another table
  announces platform-wide (`BBJHitNotification`)
- `BBJTicker.tsx:102-131` — `bbj_winners` INSERT and `bbj_pools` UPDATE
- `BadBeatJackpotPage.tsx:137-210` — pool flash and a "BAD BEAT JACKPOT HIT!" toast

**Not live:** `BBJRecentHits` — the "Last 5 Bad Beat Jackpot Winners" list, which
is what a player opens after a jackpot lands, and what `BBJInfoModal` shows at
the table. One `useEffect` keyed `[poolId, limit]`, and neither changes when a
hit arrives, so the rows sat stale until the component unmounted. The pool
number above the list would tick up while the list under it still showed the
previous five winners.

**Fixed** — it now subscribes to `bbj_winners` INSERT and refetches.

## 5. The money path was not in version control

`bbj_atomic_payout_v2` and `bbj_credit_one_recipient` existed **only in the
production database**. `grep -rn bbj_atomic_payout_v2 --include=*.sql` returned
one comment. The only payout DDL in `supabase/migrations/` was the superseded v1
(`20260724b_rake_audit_sweep2_db_fixes.sql:42`), which writes no recipients and
credits nobody — so a rebuild from the repository would have produced a jackpot
that debits the pool and pays no one, silently.

**Fixed** — captured verbatim into
`supabase/migrations/20260827c_bbj_payout_path_into_version_control.sql`,
verified by comparing a comment- and whitespace-normalised md5 of the file
against `pg_get_functiondef` on the live database. Both match exactly. It is
`CREATE OR REPLACE` and byte-equivalent, so it is a no-op against production.

---

## Recorded, NOT fixed

1. **`bbj_payouts.hand_id` is always NULL.** `runStep` continues after a failed
   step by design, so if the `hand_history` insert fails the payout still lands
   and is orphaned permanently. The prune fix removes the common cause; the
   failure mode remains.
2. **`excludeDoubleBoard` and `onlyFirstRunout` are UI copy, not server rules.**
   They appear in `BBJBasicPanel.tsx:266-269` and `BBJRulesPanel.tsx:151` and are
   read nowhere in `server/`. Settlement passes board 0 only, which covers
   run-it-twice incidentally, but a double-board bomb pot's second board is not
   explicitly excluded.
3. **Split pots evaluate `currentHandWinnerIds[0]` only.** A qualifying loser
   against a chopped pot is judged against one of the winners.
4. **No test coverage below `detectBBJHit`.** The detector is well covered
   (`RakeConfig.bbj.test.ts`, `RakeConfig.boardquads.test.ts`), and
   `processBBJPayout`, the `runStep` wiring, both payout RPCs and
   `logBBJCollection` have none.

## Cannot be verified end-to-end from live data

The most recent real hit is 2026-08-19. There has been no engine-written jackpot
since, so the full chain — detect, write the hand, pay, keep the hand, show it —
has not been observed on one hit under today's code. Every link is verified
individually above; the join itself is proven safe (zero duplicate
`(table_id, hand_number)` pairs across 1.56M rows), and the five seeded hits
render the full rundown correctly through `fn_bbj_hand_detail`.
