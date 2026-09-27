# A Stopped Engine's Own Reserved Hand Is Not A Hand After Its Custody

2026-09-27. Migration `20260927142925`.

## What Happened

At 15:07Z on 2026-09-26 six tournament managers (579489da, bec2c908, c53d96df, 39cd2945, 14cde86e, 74042784) lost their leases in the instant each table had reserved its next hand's F06 permit but had not dealt it. Each terminal engine then asked `fn_park_stopped_time_bank_custody` to write its frozen time bank, and the function answered `hand_after_custody` because that reserved permit sits above the custody's hand. No hand history, atomic commit or state snapshot exists for any of those hands.

The refusal was permanent. Each manager's stop failed "retained time-bank custody" about 16,000 times, `/health` showed `stopped_bank_custody_stuck=6` at every countdown for 24 hours, the restart certificate never opened, and every engine release since 15:09Z on 2026-09-26 failed waiting for it.

## The Change

A `reserved` permit whose generation is the caller's own generation is no longer evidence of a later hand. A reserved permit of any other generation, every accepted or aborted_unsettled permit, and every durable hand row after the custody still refuse. Nothing else in the function changed; the law test pins that.

## Verification

The migration was run against production inside a rolled-back transaction (pre-image and post-image guards passed). For all six tables the new predicate finds no later hand and the three durable hand tables hold nothing after the custody.
