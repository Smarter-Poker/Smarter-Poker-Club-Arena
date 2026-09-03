# The law registry could not see the money laws

2026-09-02

`tests/law-registry.law.test.ts` scanned `tests/` and nothing else. 26 of the
28 law tests that live under `server/src/` were therefore invisible to the
registry that exists to make a law impossible to contradict or delete quietly.

The unregistered set was not a random 26. It was the tournament money laws:

- `payoutExactness` — the paid places sum to the prize pool, exactly
- `EveryEarnerIsPaid` — the earner check asks all three of its questions
- `aGuaranteeIsAPromise` — the finish path funds the guarantee
- `aTournamentPayoutIsARecord` — the payout record cannot be rewritten
- `theReconcilerTrustsWhatItCanProve` — the reconciler asks the authoritative
  record rather than the log, which is what stops a double-pay
- plus 21 others across engine, services and tournament

The registry was built after the hamburger revert war so that a law could not
be silently replaced by its opposite. Applied to artwork it worked. Applied to
payouts it was not looking.

## What changed

- `LAW_ROOTS = ['tests', 'server/src']`, and the ghost check's regex now
  matches both prefixes — so a retired law under `server/src/` also has to lose
  its row visibly, in the same commit that deletes it.
- 26 rows added to `docs/LAWS.md`, each description taken from what the law
  actually asserts rather than invented from the filename.

## Verified

- `npx vitest run tests/law-registry.law.test.ts` — **85 passed** (was 57; the
  new count is 82 law files plus the 3 structural cases).
- Negative test, because a guard that cannot fail is not a guard: deleting the
  `payoutExactness` row makes it **fail** with
  `payoutExactness.law.test.ts is a law test but has no row in docs/LAWS.md`,
  and restoring the row returns it to 85 passed.
