# Audit — 988 critical money alarms, 93% of them noise, and a safety net that was a single attempt

**Date:** 2026-08-22 · **Repo:** Smarter-Poker-Club-Arena · **Author:** Claude (Cowork session)
**Part of:** the money-path sweep — see `2026-08-22-money-path-sweep.md`,
`2026-08-22-null-multiplier-spins-and-the-double-ledger.md`

---

## 1. WHAT WAS FOUND

Clearing the false `overpaid` alerts left one source dominating
`financial_alerts` by an order of magnitude:

```
source                          severity   count   resolved
FeeReconciler.queue_failed      critical     988          0
fn_tournament_payout_reconcile  critical     112          0   <- the phantom rows, now fixed
```

Every one of them says a version of:

> `[A5] Could not queue unbanked rake for hand 1678468 (rake 3.5, bbj 0.25):
Error: supabase_timeout. These chips left the pot and are now recoverable
only by hand.`

**938 of the 988 are `supabase_timeout`.** First 2026-08-20 16:11Z, still
firing at 2026-08-22 19:16Z.

---

## 2. THE FIRST DEFECT — the last line of defence was a single attempt

`queueUnbankedFee` is the end of the A5 chain. Rake and the BBJ slice have
already left the pot; the banking call failed; this insert into
`pending_fee_distributions` is what stops the chips ceasing to exist. Its own
comment says so:

> _Deliberately loud on failure: if even this insert fails, the chips really
> are unrecoverable from data._

It was one attempt, no retry. So the net was being dropped by exactly the
transient condition it exists to survive — and the insert is **idempotent by
construction**: a partial unique index on `(hand_id, kind) where resolved_at is
null` makes a repeat a no-op. Retrying it costs nothing and was never done.

Now four attempts with backoff, retried only on a recognisably transient error
(timeout, reset, 502/503/504, `57014`, connection exhaustion). A non-transient
error still escalates immediately — retrying a rejection would only delay the
alarm. A duplicate returns success, because a duplicate means the row is
already queued, possibly by an attempt that committed and then timed out on us.

---

## 3. THE SECOND DEFECT — a timeout is not a failure, and 81% of the alarm was noise

A timeout is the absence of an answer, not evidence of a rejection. The write
underneath it usually committed.

The first pass at this checked only whether the fee was **banked**, and against
the 127 alerts carrying a hand id that already looked damning: 118 had a
`rake_records` row, so the banking call had succeeded and only its response was
lost. Widening it to all 1,020 open alerts showed the bigger half, and it is a
better answer:

```
open alerts                                     1,020
  already in pending_fee_distributions, or banked   830   <- nothing at risk
  neither                                           190   <- 446.93 chips
```

**The queue insert usually committed.** Sampling the most recent alerts, every
one had `queued_rows = 1` — the row the alert says could not be written was
sitting in `pending_fee_distributions`, owned by `reconcilePendingFees`, being
drained. The duplicate-key path catches that only when Postgres gets to answer;
a timeout is precisely when it does not.

So **81% of a critical money alarm was noise**, and noise on that channel is
not harmless. A thousand unresolved criticals is exactly how the 190 real ones
stay invisible — the same failure mode as the flaky deploy gate, on the channel
that matters most.

`feeIsAccountedFor()` now checks, in order:

1. **the queue** — `pending_fee_distributions` by `(table_id, hand_number,
kind)`. Cheapest, and true most often.
2. **the destination** — `rake_records` by `hand_id`, falling back to
   `(table_id, global_hand_id)` because `hand_id` is null in exactly the outage
   this fires in; `bbj_contributions` by `(table_id, hand_number)`.

**It fails CLOSED.** A thrown query, an unusable hand number, anything unknown
returns false and the alarm is raised. Suppressing a money alert on a guess
would be worse than the noise it removes.

### 3.1 Neither fallback had an index

`feeIsAccountedFor` runs on the failure path — during an outage, the worst
moment for a slow query — and `rake_records (table_id, global_hand_id)` could
only narrow by table, while `bbj_contributions (table_id, hand_number)` was a
**sequential scan over 219 MB**. The rake fallback is the COMMON path: 861 of
the 1,020 alerts carry no hand id. Both are indexed now
(`20260822201000_index_fee_banked_lookups.sql`); the retro-audit above went
from a statement timeout to instant.

---

## 4. WHAT IS STILL OWED — 190 hands, 446.93 chips

Neither banked nor queued. The fee left the pot and nothing is holding it.

**Not repaired here**: re-driving `atomic_distribute_rake` for a hand from two
days ago moves real money into a club wallet, which is Dan's call rather than a
sweep's. The tools exist — the RPC is hand-gated and idempotent, so a re-drive
is safe by construction and a no-op on anything that actually landed.

```sql
-- everything still genuinely at risk, with what a re-drive needs
WITH a AS (
  SELECT fa.id, fa.created_at, fa.context->>'kind' AS kind,
         nullif(fa.context->>'handId','')::uuid    AS hand_id,
         (fa.context->>'tableId')::uuid            AS table_id,
         (fa.context->>'clubId')::uuid             AS club_id,
         nullif(fa.context->>'handNumber','')::bigint AS hand_number,
         (fa.context->>'rake')::numeric AS rake, (fa.context->>'bbj')::numeric AS bbj
    FROM financial_alerts fa
   WHERE fa.source = 'FeeReconciler.queue_failed' AND fa.resolved IS NOT TRUE
)
SELECT * FROM a
 WHERE NOT EXISTS (SELECT 1 FROM pending_fee_distributions p
                    WHERE p.hand_number = a.hand_number AND p.kind = a.kind
                      AND p.table_id = a.table_id)
   AND NOT EXISTS (SELECT 1 FROM rake_records r
                    WHERE r.hand_id = a.hand_id
                       OR (r.table_id = a.table_id AND r.global_hand_id = a.hand_number))
   AND NOT EXISTS (SELECT 1 FROM bbj_contributions b
                    WHERE b.table_id = a.table_id AND b.hand_number = a.hand_number)
 ORDER BY a.created_at;
```

### 4.1 The channel is readable again

The 830 provably-safe alerts were marked resolved with exactly the check the
code now performs, and the 96 false `overpaid` alerts from the phantom prize
rows were resolved after confirming each tournament reconciles clean. Unresolved
criticals across the platform:

```
                                    before    after
FeeReconciler.queue_failed           1,020      190   all genuinely at risk
fn_tournament_payout_reconcile         112       18   no_finisher_recorded x17, duplicate_finishers x1
```

Every remaining one is real.

---

## 5. PINNED

`tests/config/feeReconcilerAlarm.test.ts`, 11 assertions: the retry exists and
is bounded, a timeout is classified transient, a duplicate is success, a
non-transient error is not retried, the verification runs **before** the alarm
and not after, it looks in the right table for each kind, it fails closed on
both the thrown-query and missing-hand-number paths, it uses `.maybeSingle()`,
and the critical alert plus its operator-facing wording still fire when chips
really are at risk.

**10 of the 11 fail against the unfixed file.**

---

## 6. A THIRD FAULT REPORT NOBODY COULD ACT ON

This PR's first CI run went red on something unrelated:

```
FAIL src/engine/ChipConservation.property.test.ts
  > explores 1000 previously untested hands
AssertionError: expected [ Array(1) ] to deeply equal []
+   "[HandController] No winners found — awarding pot to last active player u1"
```

That is a **real engine fault**, not a flake. `determineWinners` returned empty
at showdown and `HandController`'s Bible V8 §1.9 guard awarded the **entire
pot** to `activePlayers[0]`. Chip-conserving, and quite possibly the wrong
player paid — which is exactly why the property test lists it as a panic
alongside "completeHand threw".

The explore pass seeds itself from `Math.random()` so every CI run walks new
ground, and its comment said:

> _Deliberately NOT fixed: every CI run walks new ground. The failure message
> prints the seed, so any find is reproducible on the spot._

**It did not print the seed.** The seed appears in the NAME of the _fixed_
corpus test; this one generates its own and the assertion carried nothing. So
the corpus that found a genuine pot-misallocation died with the job. Ten local
reruns of the file — 10,000 further explore hands — could not find it again.

The same lesson as the rest of this session: a fault report you cannot act on
is barely better than no report. Both assertions now carry the exact replay:

```
cd server && CHIP_CONSERVATION_SEED=<seed> CHIP_CONSERVATION_HANDS=<n> \
  CHIP_CONSERVATION_EXPLORE=0 npx vitest run src/engine/ChipConservation.property.test.ts
```

`CHIP_CONSERVATION_EXPLORE=0` turns the explore pass off so the replay walks the
same ground instead of new ground. Verified by forcing a panic and reading the
rendered message — it prints the actual generated seed, not a placeholder.

**The underlying engine fault is NOT fixed and should not be guessed at.**
`determineWinners` returning empty at a real showdown is a hand-evaluation or
pot-eligibility question, and the next occurrence will now arrive with a
one-command reproduction attached. That is the prerequisite for fixing it
properly rather than by inspection.
