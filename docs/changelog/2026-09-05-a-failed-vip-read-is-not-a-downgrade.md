# A failed VIP read is not a downgrade

2026-09-05. Found while auditing the VIP all-in squeeze, and it is the last
way that feature could silently not exist for a member who has paid for it.

## The contradiction

`vipService.checkVIPStatus` goes out of its way NOT to answer "not VIP" when
the query fails. Its header is explicit, and cites the two times this repo has
already ruled against that shape:

> `error` and `!data` were collapsed into one answer: "not VIP, zero
> allowance". One transient network blip or RLS hiccup therefore stripped a
> PAYING member of the rabbit hunts, time-bank seconds, emojis and tags they
> bought - silently, with no retry. ... `error` is the ABSENCE of an answer,
> so it throws, and the caller keeps whatever it already knew rather than
> acting on a fiction.

`useVIPStatus` was that caller, and it did the opposite:

```ts
} catch (e) {
  reportError(e, 'useVIP.check');
  if (mounted) setIsVIP(false);   // <- the fiction
}
```

So the throw that exists to PREVENT a downgrade was caught and converted into
one. One blip and a member lost every VIP-gated perk for the rest of the
session, with nothing on screen to explain it and no retry to recover it.

## Why it surfaced now

The VIP all-in squeeze (`TablePage`'s `heroSqueezeEligible`) reads this hook.
A member whose read blipped would go all-in, hold a valid VIP card, have the
perk switched on - and simply never see the squeeze, with no way to find out
why. That is indistinguishable from the feature being broken.

## The fix

One retry on a 400ms backoff, and if the answer still never arrives, KEEP WHAT
WE ALREADY KNEW instead of inventing a downgrade.

The initial value stays `false`, so a first read that never succeeds still
grants nothing - fail closed on a perk we have never been able to confirm -
but a membership confirmed once is not un-confirmed by a dropped packet.

## Verified

`tests/unit/aFailedVipReadIsNotADowngrade.test.tsx`, three pins, two of which
fail on the pre-fix hook:

- it retries once before believing a failure (FAILED before)
- a member confirmed VIP is not un-confirmed by a later failed read, driven
  down the real `ENTITLEMENTS_CHANGED` re-check path rather than a rerender,
  because the effect's deps are `[user?.id]` and a rerender never calls
  `check()` again (FAILED before)
- it still grants nothing when the very first read never succeeds (passed
  before and must keep passing - this is the fail-closed half)
