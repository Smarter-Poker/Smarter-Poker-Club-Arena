# A hand names itself before it banks its rake

2026-09-07. Branch `rootcause`.

The unbanked rake was the largest thing the Bad Beat Jackpot programme found and
did not close. It is closed, and it was not the defect everybody thought it was.

---

## What everybody thought

`docs/BAND-AIDS-REGISTER.md` TIER 1 #5 said the engine takes rake from the pot
and banks it in a separate step, and dies in between — "with an hourly `:55`
restart it reliably will". A repair job (`fn_rake_repair_unbanked`, hourly) and a
re-drive (`fn_redrive_unbanked_rake`, quarter-hourly) existed to catch what fell
through, and the hard fix on the register was to make taking the rake and banking
it one write.

Two hours of measurement says that story is wrong in its first sentence. Bucket
the orphaned rake rows by minute of the hour and the `:55` bucket holds **zero**
of them — because play is parked for the maintenance break, which is the one time
the engine dying costs nothing. They are spread evenly across the other eleven
buckets.

## What was actually happening

`hand_history.id` defaults to `gen_random_uuid()`. So the hand's identity was
decided by the INSERT, and settlement — which writes the hand first precisely so
it can pass that id to `atomic_distribute_rake` — had nothing to pass when the
insert was slow or failed. Measured the same day: **143 of 11,485 hands in two
hours** landed more than 30 seconds after `ended_at`, 66 of them more than two
minutes, worst 252 seconds. Those hands go to the in-process retry queue and
settlement carries on with `null`.

One null, three separate costs.

**1. Nobody earned.** `atomic_distribute_rake` writes the per-player ledger only

```sql
IF v_first_claim AND p_hand_id IS NOT NULL AND p_contributions IS NOT NULL ...
  INSERT INTO public.rake_attributions ...
```

so a hand banked with a null id has **no attribution rows at all**. Measured over
24 hours: 173 cash hands, zero attributions between them. No VIP points, no agent
or super-agent commission, no rakeback basis, for every player at those tables —
horse and human alike, which is CLAUDE.md 10.5 being broken by omission rather
than by an `is_horse` filter.

**2. The unique index was switched off.** `uq_rake_records_hand_id` is
`UNIQUE (hand_id) WHERE hand_id IS NOT NULL`. With a null it matches nothing, so
an in-line retry after a lost response books the club again. 36 hands in seven
days carried two copies of their own rake row, and two carried three.

**3. The club was paid twice.** The wallet's idempotency key is

```sql
v_leg_key := COALESCE(p_hand_id, md5('rake:'||table||':'||hand_number))
```

The live call took the md5 key. `fn_redrive_unbanked_rake`, running at
`7,22,37,52` with the hand id it had since resolved, took the uuid key. Two
different keys for one hand, `rake_distribution_legs` deduped neither, and
`club_wallets` was incremented twice.

The repair job on the register was not the safety net for this defect. It was
one of the two things causing its worst symptom.

## The fix

`ServerTableEngineSettlement` mints the hand's uuid itself, before anything is
written:

```ts
const v_handId = randomUUID();
let v_handHistoryId: string | null = null;
```

and hands the same value to the `hand_history` insert (`handId: v_handId`), to
`atomic_distribute_rake` (`p_hand_id: v_handId`), to the unbanked-fee queue, and
to the BBJ contribution. `v_handHistoryId` keeps its old meaning — _the row is in
the database_ — and still gates the three things that genuinely need the row:
the `hand_history_saved` broadcast, the bomb-pot award units, the integrity feed.

`hand_history.id` has no incoming foreign key from `rake_records`,
`rake_attributions` or `bbj_contributions` (checked, not assumed), so the booking
may name the hand before the row lands. The row then lands under exactly that id
— in line, from the queue five minutes later, or not at all — and all three
consequences above disappear at once: the attribution is written on the first
claim, the unique index dedupes the retry, and the re-drive takes the same leg
key and does nothing.

`insertHandHistoryRow` also stops reading the id back out of the response body.
"The write landed and we could not read the answer" was indistinguishable from
"the write failed", and that is one of the ways the null got in.

This is also the root of **`FeeReconciler.bbj_unlinkable`** (114 fires in seven
days), which has been reporting that a jackpot drop could not be tied to a hand.
It was right every time, and it was never the contribution's fault.

## The money

Ninety-nine hands credited their club wallet twice between 2026-09-06 10:08:54
and 2026-09-07 18:26:38 — the window starts there because `rake_distribution_legs`
does:

| club               | hands |   rake |   bbj |
| ------------------ | ----: | -----: | ----: |
| Midway Union       |    79 | 150.25 | 21.27 |
| Deep Stack Society |    20 |  16.13 |  4.91 |
| **total**          |    99 | 166.38 | 26.18 |

`20260907200330` corrects the two `club_wallets` accumulators down by exactly
that, and resolves a `financial_alerts` row with the same figures.

Three things were deliberately **not** done, each for a reason that was read
rather than assumed:

- **The ghost `rake_records` rows stay.** They are the true record of what the
  platform did. `ca_reporting_rake_change` is a FOR EACH ROW trigger that rebuilds
  a whole day's reporting per row touched, and a rolled-back probe of 99 updates
  timed out at 110 seconds. They carry no attributions, so nothing per-player
  reads them.
- **`ca_club_rake_daily` stays.** A rolled-back probe showed the subtraction
  would take Midway Union's daily rake **negative** (33.91 recorded against 45.05
  of ghosts on 2026-09-06), so that rollup is not a sum of
  `rake_records.club_id` and it is `fn_club_rake_rollup_day`'s to derive.
- **The doubled VIP points stay with the players.** `fn_award_vip_points_from_rake`
  fires on INSERT from `NEW.player_contributions`, which both rows carried.
  CLAUDE.md 10.9 rule 3: overpay our defect caused is absorbed by the house,
  reported, and left alone.

Nothing had been paid out of the corrected accumulators — `period_rake_collected`
equals `lifetime_rake_collected` on both clubs, so no period has ever been closed
against them. This was a number being made true, not money being moved.

## A migration that was written today and undone today

`20260907192843` added `player_contributions`, `returned_uncalled` and
`rake_method` to `hand_history` so the hourly repair could rebuild the
attribution it had been throwing away. That was the symptom being treated, and
`20260907195116` drops all three again: with the id minted the repair cannot
fire, and 1.3 GB a month on a 3.6 GB table taking 221k rows a day, to feed a job
that must never run, is the band-aid CLAUDE.md 10.12 forbids.
`fn_rake_repair_unbanked` is restored byte-for-byte to its `20260829211853` body.

Both files are in `supabase/migrations/` because both ran.

## Pinned

`server/src/engine/aHandNamesItselfBeforeItBanksItsRake.law.test.ts` — 12 tests.
The mint exists and happens before the `hand_history` step; the money path takes
`v_handId` and never `v_handHistoryId`; `v_handHistoryId` keeps its old meaning
for the three readers that need the row; `logHandHistory` writes the id when it
is given one and omits the key entirely when it is not; the insert returns the
minted id rather than null when the response body is empty; and nothing on the
engine side reads `player_contributions` off `hand_history` again.

## Verified in production, 2026-09-09

Read from rows two days after the engine picked the mint up (first successful
`auto-deploy-hetzner` run containing `7087bd2385` was `f8ca3d64`; sixty runs
since, zero failures):

| day        | cash rake bookings | booked with a null hand id |
| ---------- | -----------------: | -------------------------: |
| 2026-09-06 |             59,027 |                         37 |
| 2026-09-07 |             77,517 |                        171 |
| 2026-09-08 |            107,094 |                      **0** |
| 2026-09-09 |             68,861 |                      **0** |

- **Hands booked twice since:** 0.
- **`FeeReconciler.bbj_unlinkable`:** 5 fires in the three days before, 0 since.
  The alert class is dead at the root.
- **`bbj_near_misses`:** first row 2026-09-07 22:15, the first `:55` cutover
  after the merge. 37 rows in 46 hours: `winner_not_quads` 21,
  `both_cards_must_play` 10, `pot_too_small` 4, `not_enough_players` 2. The
  thirty-day question now has an instrument.
- **The jackpot paid.** After seventeen days of silence the main fired **five
  times** from 2026-09-08 10:07 (98,823.81 chips) and the mini **fourteen
  times** (8,150.00). The union pool went from 109,308 to 42,377. No causal
  claim is made here - the mint touched hand ids, not detection - and the
  near-miss log is what will say whether the bar is right.

**What the net caught, and why it is not this defect.** `fn_rake_repair_unbanked`
fired twelve times on 2026-09-08 between 02:32 and 17:47 and banked 209 hands
(464.34 chips) with no attribution. That was a database incident, not the null
id: `Could not query the database for the schema cache` on both the live rake
RPC and the queue write, lock timeouts and deadlocks across every rake path,
and 524 `postHandTasks.hand_history_failed` alerts between 14:00 and 18:00 -
the PGRST002 reload storm CLAUDE.md section 2 describes, on a day some twenty
migrations landed. Every one of the 209 carries a real hand id and none was
booked twice: the mint held through the outage. Their contributions were lost
with the failed queue write, so their attribution cannot be reconstructed
truthfully and is not invented (10.9 rule 1). Zero recurrences in the 26 hours
since. This is the residual the net exists for, and it is named in
`docs/BAND-AIDS-REGISTER.md` TIER 1 #5 as the thing that lets the net be deleted
once its own cause - DDL reload storms - is closed.

A parallel settlement the same night (`atomic_distribute_rake.ghost_twin_phantom_retired`,
2026-09-08 02:00) retired the WIDER historical double-bank - 1,171 union hands
and 239 club hands, 2026-08-20 to 2026-09-07 - from the rake treasuries through
`fn_ca_burn`, matching both credit rows per twin by time and amount. That is the
population this changelog deliberately left unsettled because the leg rows could
not prove it; it targets the treasury supply, not the `club_wallets` accumulators
corrected by `20260907200330`, so the two do not overlap.
