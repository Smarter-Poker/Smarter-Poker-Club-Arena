# 2026-08-31 — MTT Phase 3: a payout is a record, not a column

Phase 3 of 7 from `.agent/audits/2026-08-31-mtt-deep-dive-what-is-left.md`.

## What was wrong

Across **44,091 completed tournaments** — 29,056 Spin, 13,481 SNG, 1,556 MTT —
the only evidence that a player finished 3rd and was paid 42.50 was two
**mutable columns** on `tournament_players`: `position` and `prize`. No payment
timestamp. No idempotency key. No snapshot of the structure that priced the
place. No field size to say what that structure was trimmed to. 52,847 prize
payments and not one row of evidence behind any of them.

`tournament_payouts` existed and was empty, but it is **not** a general payout
record: its only writer was `fn_final_table_deal` and its only reader the
stuck-COMPLETING watchdog, which checks it to avoid paying structure prizes
over an agreed chop. It had 0 rows because 0 deals have ever been made — so
that guard had never once been exercised. It worked by the accident of an empty
table.

`tournament_results` is not the finishing record either, despite the name. Its
columns are `series_id`, `tour_code`, `event_name`, `winner_name` — it belongs
to the scraped real-world results subsystem. Building the payout record into it
would have been wrong.

## What changed

**1. The record.** `tournament_payouts` gains `idempotency_key` (uniquely
indexed), `paid_at`, `tournament_type`, `field_size`, `prize_pool`,
`payout_structure` and `recorded_by`.

**2. Append-only, enforced, and proven.** A `BEFORE UPDATE OR DELETE` trigger
refuses both for every role including `postgres`. The one way through is for a
DBA to declare it in the same transaction:

```sql
SET LOCAL app.payout_record_correction = 'i_am_correcting_the_record';
```

The first cut let any `postgres` session through on the strength of the role
alone — which is every pg_cron job, every Supabase maintenance connection and
every console query, and which made the guard **untestable**: a probe running
as postgres could not tell a working trigger from a broken one. That is the
"verify the safeguard can actually fire before trusting it" lesson from this
week's gate findings, arriving one more time. Proven in all three directions,
inside a rolled-back transaction:

```
update = REFUSED: tournament_payouts is an append-only payout record
delete = REFUSED: tournament_payouts is an append-only payout record
bypass = works when, and only when, the setting is present
```

**3. The deal path stopped needing an exemption.** `fn_final_table_deal`
inserted a row per player and then came back with an `UPDATE` to add the
rounding remainder to the chip leader. Every share is now floored in one pass,
the shortfall is worked out before anything is written, and the leader's single
`INSERT` carries share + remainder. Same money, same recipient, same ordering,
one write. Verified on 3334/3333/3333 chips against a 1000 pool:
`334 + 333 + 333 = 1000`, exact to the cent.

**4. The record is written at ONE chokepoint.** Every tournament prize on this
platform passes through `fn_credit_and_log`. Nineteen paths do so — twelve in
the engine and **seven in SQL**:

```
fn_mystery_bounty_pay            fn_mystery_bounty_settle
fn_backpay_spin_unpaid_winners   fn_backpay_hu_winner_shortfalls
fn_tournament_payout_reconcile   fn_unregister_from_tournament
atomic_cancel_tournament
```

Writing the record at each call site would have been nineteen chances for the
twentieth path to forget — and the seven above cannot be passed a parameter
from the engine at all. So it is written where the money is, once.

It **fails open and loud**: if the record cannot be written the credit still
commits, because a player unpaid over bookkeeping is worse than a payment with
a missing row — but it raises a `financial_alerts` row rather than being
swallowed, because a payout record that quietly stopped filling would look
exactly like a platform with no payouts.

Cash is untouched: the record is written only when the category is a prize and
the related entity is a real tournament.

**5. One classifier, shared by both writers.** `fn_tournament_payout_shape`
reads the kind of payment and the finishing place out of the key's grammar. The
live writer and the historical backfill both call it, so a row written today
and a row reconstructed from March cannot drift into describing the same
payment differently. Listing every key prefix in `wallet_credit_idempotency` —
rather than reading the callers, who would have said there were only `tourney:`
keys — turned up three more namespaces carrying tournament money: `mb:`,
`mb-residual:` and `spin:`, 176 payments.

**6. The read policy, narrowed before the first row landed.** The existing
policy was `tpay_read FOR SELECT TO authenticated USING (true)` — harmless on an
empty table, and a privacy breach the instant 71,739 rows arrive, because every
logged-in user could then read every prize every player has ever been paid. It
is now scoped to the player themself, anyone who played the same event, and
club administration. The table also carried `anon=arwdxtm` and
`authenticated=arwdxtm` — INSERT, UPDATE and DELETE. Nothing was exploitable
because RLS is fail-closed, but that is one lock doing all the work, which is
the shape of the 2026-08-31 `fn_club_set_member_role` finding. Both revoked.

**7. The back catalogue.** The evidence was never lost — it was in
`wallet_credit_idempotency`, because every credit this platform has ever made
had to present a key.

| recorded_by | rows | tournaments | money |
| --- | --- | --- | --- |
| `backfill_2026_08_31` (keyed era, from 2026-07-24) | 70,478 | 43,325 | $3,283,772.48 |
| `backfill_ledger_2026_08_31` (pre-key era, from the ledger) | 1,191 | 980 | $9,185.90 |

Completed events with a prize pool and still no record: **6** — and all six are
satellites, which award seats rather than cash.

`payout_structure` is deliberately NULL on every reconstructed row. A snapshot
means "the structure as it stood when this place was priced"; today's structure
is not that, and a plausible wrong value is worse than an empty one.

## What the record found the moment it existed

None of this was queryable before.

**39 completed MTTs paid out more than their prize pool — $20,407.66 over.**

| variant | events | of which a place was paid to two different users | excess |
| --- | --- | --- | --- |
| freezeout | 22 | 5 | 18,880.02 |
| satellite | 7 | 0 | 870.00 |
| progressive_bounty | 5 | 2 | 581.50 |
| bounty | 3 | 0 | 36.00 |
| mystery_bounty | 2 | 1 | 40.00 |

The unambiguous case: **Sunday Freeroll Special, 2026-08-23** paid all nine
places **twice**, six and a half minutes apart, identical amounts — eighteen
payments for nine places, $600 against a $300 pool. The two first-place keys
were `...:prize:00000000-…-045:1` and `...:prize:c1b575fb-…:1`: **user-scoped**,
so two different players stamped 1st produced two different keys and both were
paid. That is the defect the 2026-08-28 place-scoped-key change fixed; this
event predates it.

**A suspicion that was wrong, recorded as wrong.** 25 of the 39 have a
`reconcile` row, and the obvious inference was that
`fn_tournament_payout_reconcile`'s separate key namespace was still
double-paying. It is not. That function is **delta-based** — it credits
`expected − already_paid`, summed from the ledger — so its own namespace is
correct and safe. The reconcile rows are a symptom of troubled events, not the
cause. **Roughly 24 of the 39 remain unexplained** and are Phase 4 work.

**Satellites stamp `prize` with the seat's notional value** — $200 against a
$108 pool — so any reconciliation summing that column reads those events at
926%. The seats themselves have no record row of any kind: a thing of value is
awarded and nothing evidences it. Also Phase 4.

## Tests

`aTournamentPayoutIsARecord.law.test.ts` — 27 pins: the trigger refuses UPDATE
and DELETE; the bypass must be asked for; the deal path contains no `UPDATE` of
the record; the record is written after the credit is known to have moved, so a
dedupe writes nothing; it fails open and raises an alert; the nine-argument
overload is dropped (two would make every RPC ambiguous by name) and the ACL a
`DROP` discards is restored; one classifier serves both writers; entry-side
money is never classified as a payout; the read policy is not `USING (true)`;
re-running the backfill inserts nothing.

One pin failed on its first run and the failure was correct — it matched the
commented-out `USING (true)` in this change's own ROLLBACK block. A pin that
fires on a comment is a pin someone deletes the first time it is inconvenient,
so the test now strips `--` comments and asserts against executable SQL only.

`tsc --noEmit` clean. Server suite: 240 of 275 files, **2,809 tests, 0
failures**, run locally in shards. The remaining 35 files are the slow
engine/equity benchmarks; this machine cannot finish them inside a single
shell call, and CI runs the full suite as a required check.
