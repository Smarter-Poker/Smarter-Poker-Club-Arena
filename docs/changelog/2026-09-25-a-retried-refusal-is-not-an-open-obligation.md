# A retried refusal is not an open obligation

**2026-09-25.** `public.financial_alerts` held **22,244** rows with
`resolved_at IS NULL`. Under CLAUDE.md 10.11 and 10.12 an alert is explicitly
not a resolution, so that number read as 22,244 money problems claimed to be
handled and not handled. It was not. 21,289 of them were settled, false, or
derivative, and **989 remain open on purpose**.

## What the rows said

95.2% of the backlog was six sources. The table below is per class, with the
five tests of CLAUDE.md 10.9 applied to each.

| Class                                                                 | Rows   | Money implicated              | Decision                                  |
| --------------------------------------------------------------------- | ------ | ----------------------------- | ----------------------------------------- |
| `Tournament.atomic_finish_refused`                                    | 15,426 | 91,009.20 across 1,003 events | **Resolved** — all settled                |
| the two hand-level refusals (4 sources)                               | 4,583  | none moved                    | **Resolved** — atomic pre-commit refusal  |
| `Satellite.stuck_completing_unawarded` (+ `seat_outcome_unconfirmed`) | 538    | 769.50 across 9 events        | **Resolved** — paid 09-09                 |
| satellite / unknown-outcome finish refusals                           | 516    | 4,509.50 across 81 events     | **Resolved** — all settled                |
| `fn_tournament_money_conservation`, satellites                        | 41     | 2,320.00 phantom              | **Resolved** — false; producer fixed      |
| `bounty_head_not_attributed`                                          | 78     | 735.50 residue                | **Resolved** — redistributed via the pool |
| `drift_incident:financial_alerts:*`                                   | 107    | 0 chips by their own text     | **Resolved** — derivative                 |
| `fn_union_*` live failures                                            | 404    | unquantified                  | **OPEN** — live and real                  |
| weekly / union accounting                                             | 358    | week 09-07..09-14             | **OPEN** — uncertifiable week             |
| freezeout conservation deltas                                         | 9      | +4,200 gross                  | **OPEN** — overlay/seat double-funding    |
| bubble-protection deltas                                              | 2      | 360.00                        | **OPEN** — no funding term                |
| `RakeSpec.*`                                                          | 22     | n/a                           | **OPEN** — engine frozen on `8825af51`    |
| `drift_incident` with real drift, long tail                           | ~194   | −2,733.92 and singles         | **OPEN** — each its own question          |

**Total settled and confirmed paid: 97,419.00 across 1,075 tournaments, with no
payout row anywhere still lacking `paid_at`.** Not one chip of that was paid by
this change; every penny had already gone out through `fn_credit_and_log` or
`fn_award_satellite_seat`. What this change did was stop the platform claiming
otherwise.

## The volume was the defect, and the guard was already built

`fn_raise_server_financial_alert` has always taken `p_dedupe_key` and
`p_entity_id`, and implements exactly the rule its own comment states:

> ONE OPEN ALERT PER THING THAT IS WRONG. Not per pass over it.

**The engine's wrapper never passed either parameter.** All 33 call sites that
go through `raiseFinancialAlert()` could not reach the guard, so the only flood
control left was the RPC's 60-per-minute _rate_ limit — which a refusal retried
on a ~30-minute backoff never trips. The five call sites that bypass the wrapper
and call the RPC directly with `p_entity_id` held **one row each** on the same
day, in the same estate. The only difference was whether the subject key reached
the door. This is the armed-but-unreachable guard pattern CLAUDE.md warns about,
in its purest form: the mechanism was correct, tested and live, and nothing
could call it.

There was a second, in-memory dedup on the tournament manager
(`lastFinishRefusalReason`, one slot). It correctly killed the five-second
replay loop that produced 3,076 alerts in an earlier incident, and it cannot do
more than that: a single slot cannot survive a process restart, and two reasons
that alternate are each "new" every time they come round. 220+ alerts on a single
tournament over four days, at an average gap of 32 minutes, is what that looks
like. The fix is not to make the in-memory slot cleverer — it is to let the
durable guard do its job.

Fixed in `server/src/services/financialAlerts.ts` (forward both parameters) and
at the three highest-volume call sites, keyed on the **subject**: tournament plus
refusal reason, or table plus hand number. Pinned by
`server/src/services/aSubjectKeyReachesTheDedupeDoor.law.test.ts`.

**14,388 of the 15,426 also carried no `error` and no `error_name` at all**,
while asserting `proven_refusal: true` — a critical money alert that says
something was definitively refused and records nothing about what. The refusal
reason now goes into the context (10.86 rule 1).

## The conservation false alarm, and one COALESCE standing in for two absences

All 41 satellite rows of `fn_tournament_money_conservation` were explained to the
penny by `wallet_prizes + seat_paid_out - payout_total == -delta`, 2,320.00 in
total. When a satellite ticket cannot be delivered the platform pays it in cash
and says so in the wallet row — _"Satellite ticket paid in cash because target
admission was definitively unavailable"_ — which writes a `prize` credit and
leaves the payout row at `source='satellite_ticket'`. A cash-paid ticket leaves
no `tournament_satellite_awards` row and no `tournament_tickets` row, and the
payout row carries a NULL `position`, so `COALESCE(a.delivery_kind,'seat')` and
`COALESCE(k.status,'issued')` both fall through to the defaults meant for _"the
legacy direct-seat path, which always arrived"_. The same absence meant two
different things and the default picked one.

The function's own comment already stated the right rule — "a cash delivery was
never a seat in the first place" — and already handled the cancelled-ticket
version. The fix is one more condition, not a new term.

**Measured over all 71,785 events in the scan window: 41 touched, 41 fixed,
0 healthy events broken, 60 flagged before and 19 after.** A first attempt keyed
on `recorded_by='credit_and_log'` would have **broken 245 healthy events to fix
the same 41**, because for those the cancelled-ticket gate had already excluded
the row and the new condition would have subtracted it twice. That attempt is
recorded in the migration header so nobody retries it (10.86 rule 4).

## The overpay that was not one

Two "Sunday $200 Deep Stack" events showed a delta of exactly −180.00 and paid
180.00 more than their declared `prize_pool`. That reads as an overpay to absorb
under 10.9. It is not one. Both have a `tournament_payouts` row with
`source='bubble_protection'` — the bubble player's buy-in returned, a deliberate
product payment funded outside the prize pool, for which the delta simply has no
term. Five events and 900.00 in the entire history. **No money was clawed back
and none needed absorbing**, because nothing was overpaid. A term is not invented
for it here without first establishing the funding leg, so those two rows stay
open with that reason recorded.

## Horses

Every recipient in the satellite class, and every payee in the two −180 events,
is a horse. Per 10.5 that changed nothing about what was owed or what was
checked: they were paid identically to humans, through the same idempotent
paths, and they were paid. No filter was written and none was removed.

## What stays open, and why that is the point

989 rows. The largest block is 404 live `fn_union_*` failures on union
`fade0000-…-0001`, still firing at 12:35 today with
`invalid_closed_pnl_evidence_period` and
`union_cash_sources_do_not_match_bank:77564`. Next is 358 weekly/union
accounting rows for the week 2026-09-07..09-14, which the accounting engine
structurally cannot certify because that week precedes the observed-source
cutover. 22 `RakeSpec` rows cannot close until the engine leaves build
`8825af51`. **None of these was closed to make the count look better**, and the
migration carries an assertion that aborts the whole transaction if fewer than
700 of them are still open when it runs.

## Files

- `supabase/migrations/20260925142532_a_retried_refusal_is_not_an_open_obligation.sql`
- `server/src/services/financialAlerts.ts`
- `server/src/tournament/TournamentManagerBase.ts`
- `server/src/engine/ServerTableEngineSettlement.ts`
- `server/src/services/aSubjectKeyReachesTheDedupeDoor.law.test.ts`
- `docs/laws.d/a-subject-key-reaches-the-dedupe-door.md`
