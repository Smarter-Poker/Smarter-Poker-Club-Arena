# Only a critical that needs a person reaches a person

2026-09-06. Dan: _"HAVE THE PUSH NOTIFICATIONS STOP UPDATING ME FOR 0.00 OR
FIXES, ONLY CRITICAL ERRORS THAT NEED MY ATTENTION ONLY SHOULD BE SENT TO MY
PHONE."_

Two defects, one symptom: his phone paged several times an hour for money that
was correct.

## 1. A check that answered before the answer existed

`fn_ca_escrow_on_close` is an AFTER UPDATE trigger on `tournaments`, firing the
instant status becomes COMPLETED. **At that instant the prizes have not been paid
yet** - the reconciler settles seconds later - so `prize_balance` is still the
whole prize pool, and the trigger reported that pool as chips "still in escrow".

Measured, its ten most recent incidents:

- **8 of 10 now read `prize_balance 0.00`.** The amount each reported was the
  prize about to be paid correctly. Three checked against the tournaments:

  | tournament              | prize_out | prize_balance now | payout rows | paid    |
  | ----------------------- | --------- | ----------------- | ----------- | ------- |
  | NLH Heads-Up 100 Turbo  | 2375.00   | 0.00              | 3           | 2375.00 |
  | NLH Heads-Up 50 Turbo   | 1520.00   | 0.00              | 4           | 1520.00 |
  | PLO4 Heads-Up 100 Turbo | 1425.00   | 0.00              | 2           | 1425.00 |

- 2 of 10 were genuinely non-zero.

So it was right about a fifth of the time and paged every time, which is how a
real signal gets trained out of a person. **17 of the 40 incidents raised in
three hours came from this one trigger.**

The fix is not a sweep that cleans up after it. A check that cannot yet know the
answer must not answer. It stamps `closed_at` and `close_note` now - the honest
part, a fact about that instant - and raises nothing.
`fn_ca_escrow_vs_counter_check` already asks the same question later, when the
answer exists, and is the source of the 30 standing `escrow:<tournament>`
incidents that are real.

## 2. The notifier pushed on warnings, on zeros, and on fixes

`fn_ca_incident_notify` was called for anything not `info`, and its `v_kind`
could be `'raised'`, `'escalated'` **or `'resolved'`**. So a warning paged, an
incident carrying 0.00 paged, and closing one paged again.

Three gates now sit on the push only, in this order:

1. a resolution never pages - checked first, or a resolved critical slips through
2. anything below critical never pages
3. a zero never pages

The incident is still filed, `ca_incident_events` still records everything, and a
withheld push is recorded as `kind = 'notify_withheld'` with its reason. The
board can now show "this happened and we deliberately did not wake anybody",
which is different from both "nobody was told" and "the notifier broke".

## The defect I wrote twice in one day

The first version of this migration inserted `kind='notify_withheld'` into
`ca_incident_events`, whose CHECK constraint did not allow it. The insert threw,
`fn_ca_incident_notify`'s outer `EXCEPTION WHEN OTHERS` caught it, and **the gate
silently did nothing at all.**

That is the same shape recorded this morning in
`2026-09-06-the-deep-dive-that-found-two-of-my-own.md` - a swallow-all handler
hiding a real failure - written again, hours after writing it down.

**The migration's own probe caught it in ten seconds.** A test that read the
source would have passed. The constraint now carries `notify_withheld`.

## Proved, not asserted

The migration ends by filing a warning, a 0.00 critical and a resolution and
asserting **none of them page**, then filing a real critical carrying 12,345.67
chips and asserting **that one still does** - because a gate drawn too tight
silences a genuine loss. Then it rolls the whole probe back and aborts the
migration if any of it failed.

Pinned by `tests/only-a-critical-reaches-a-person.law.test.ts`.

## Result

Board **126 to 108** open. Escrow-close incidents: 18 to **0**, with **0 new**
in the following ten minutes. `fn_ca_escrow_on_close` no longer references
`fn_ca_raise_drift_incident` at all.
