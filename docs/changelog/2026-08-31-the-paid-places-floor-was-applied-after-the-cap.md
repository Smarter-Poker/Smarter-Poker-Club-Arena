# The Paid-Places Floor Was Applied After The Cap, And Two Payout Rules Said Things That Were Not True

**Date:** 2026-08-31
**Branch:** `cowork-claude-payplaces`
**Lands with or after:** PR #2334 (`cowork-claude-spinpay`)

Two sibling bugs, both the same shape: a comment stating a rule, and code beside
it doing something else.

## A. `paidPlacesForField` raised the answer back over its own cap

`server/src/tournament/payoutStructure.ts`. The sentence above the code says:

> Never pay more places than there are players, and never pay every player: a
> structure that pays 100% of the field is a refund, not a tournament.

The code was:

```ts
const capped = Math.min(byFraction, Math.floor(field / 2), MAX_PAID_PLACES);
return Math.max(1, Math.min(Math.max(MIN_PAID_PLACES, capped), Math.floor(field)));
```

`Math.max(MIN_PAID_PLACES, capped)` lifts the result back ABOVE the half-field
cap that the line before had just applied, so with `MIN_PAID_PLACES = 3` that
cap did nothing for any field of seven or fewer. And the final clamp is to
`field`, not `field - 1`, so "never pay every player" was not enforced at all.

| field               | shipped          | stated cap | now       |
| ------------------- | ---------------- | ---------- | --------- |
| 2                   | 2 (every player) | 1          | 1         |
| 3                   | 3 (every player) | 1          | 1         |
| 4                   | 3                | 2          | 2         |
| 5                   | 3                | 2          | 2         |
| 6                   | 3                | 3          | 3         |
| 20 / 40 / 100 / 500 | 3 / 6 / 15 / 75  | -          | unchanged |

The fix applies the floor BEFORE the caps and clamps to `field - 1`:

```ts
const byFraction = Math.max(MIN_PAID_PLACES, Math.round(field * PAID_FRACTION_OF_FIELD));
const capped = Math.min(byFraction, Math.floor(field / 2), MAX_PAID_PLACES);
return Math.max(1, Math.min(capped, field - 1));
```

Nothing at six players or above moves, which is why every measured-bucket pin in
the law test still holds unchanged.

**A two-player field pays ONE place.** A heads-up final is legitimately
winner-take-all, and paying both seats of a two-handed event is a refund with
extra steps - which is exactly what the comment forbids. A one-player field
still pays one: there is nobody to leave on the bubble, and `Math.max(1, ...)`
keeps the clamp from returning zero.

**Why the clamp matters more here than in a display helper:** the single caller
is `TournamentManagerBase.widenPayoutStructureToField`, which WRITES the result
into `tournaments.payout_structure` at prize-pool finalisation, over what the
operator configured. An off-by-one here does not propose a refund, it stores one.

### The law test permitted the bug it was named for

`blindsAndPayoutsFitTheTournament.law.test.ts` had a case titled "never pays
fewer than the minimum, nor every player in the field" whose assertion was
`places <= field` - which permits paying every player, the thing the title
forbids. Corrected to `<= max(1, field - 1)` in the same commit, with the floor
expressed as the one the caps actually allow (below eight players the half-field
cap is the binding rule and is stricter than the minimum; pinning
`>= MIN_PAID_PLACES` there would pin the bug from the other side). A second case
pins the four concrete before/after values above.

### Live exposure (SELECT only, nothing modified)

- `widenPayoutStructureToField` has written **6** `payout_structure` rows in
  production, all today, all at fields of 49 and 50 (7 and 8 places, geometric
  shape). **None of them change under this fix** - the function is byte-identical
  from six players up.
- **13,269 completed and 19 running heads-up SNGs** (field 2, `tournament_type`
  `SNG`, not Spins so the widen path does not skip them) currently store a
  one-place winner-take-all ladder. Under the shipped code `paidPlacesForField(2)`
  is 2, so `current.length (1) < wanted (2)` - every one of these would have had
  winner-take-all silently rewritten into a two-place refund at finalisation.
  Under the fix, wanted is 1 and they are left alone. This is the bug's real
  blast radius and it had not gone off yet only because widen shipped today.
- **15 completed MTTs at fields of 4 and 5** sit in the band where the half-field
  cap was inert. All 15 already store 3, 5 or 9 places, so widen never fired on
  them; their stored ladders are operator presets (50 / 30 / 20), not widen output.

## B. `PayoutEngine` clamped to `n - 1` and called it the service's rule

`src/services/PayoutEngine.ts:211`. `payoutsForChoice` clamped paid places to
`Math.min(n - 1, ...)` under a comment claiming "the service refuses a structure
that pays as many places as there are seats". Nothing refuses that.
`fn_create_tournament` refused `paid_places >= max_players` - a different rule,
itself an off-by-one against its own error text, corrected by PR #2334.

What the clamp actually did:

- `payoutsForChoice('payout3', 3)` returned **2** places, though `payout3`
  declares `minPlaces: 3`;
- `payoutsForChoice('payout2', 2)` returned **winner-take-all**, though `payout2`
  declares `minPlaces: 2` - so a heads-up SNG could not express 65 / 35 at all.

Now `Math.min(n, ...)`: a ladder may pay every seat (a Spin is three-handed and
pays three), it may not pay a seat that does not exist. `minPlaces` is the only
thing deciding depth on a short field, which is what it was written to be.

**This needs #2334 to be live.** Until the RPC's `>=` becomes `>`, a three-seat
event asking for three places is refused at creation with
`more_paid_places_than_players`.

The pin `expect(payouts.length).toBeLessThan(n)` in `tests/unit/PayoutEngine.test.ts`
pinned the workaround, not a rule; it is now `<= n`, with a new case asserting
that `payout3` at 3 seats pays 3 and `payout2` at 2 seats pays 2.

### Two smaller things in the same file

**`PAYOUT_TEMPLATES.sng3` is byte-identical to `sng6`** ([65, 35]) under a name
that reads as three. Checked every caller: it is reachable from
`autoSelectPayouts(n <= 3)` and from the operator's template picker. The name is
a SEAT count, parallel to `sng6` and `sng9` (6-max, 9-max), so this is the
three-handed preset paying two of its three seats - a legitimate ladder, left
alone deliberately, because changing those numbers changes money on shipped
events and whether a 3-max SNG should pay 65 / 35 or three places is Dan's call.
What was genuinely wrong is that `getTemplateOptions` labelled it "SNG (3-Way)"
and described it as a "65/35 Two-Player SNG" - two contradictory claims about
one preset in the same row. The description now says what it is; the ladder is
untouched and commented.

**`getOverlayStatus` divided by the wrong number.** It guarded on
`entriesPrize > 0` and then divided by `guaranteedPrize`, so an event with no
guarantee and any entries returned `overlayPercentage: NaN` (0 / 0), and with
zero entries it claimed a 100% overlay on a guarantee that does not exist. The
percentage is "what share of the guarantee the house is covering", so the guard
now sits on the guarantee. It has no production callers today - fixed rather
than deleted because it has tests and a clear meaning.

## Verification

- `server`: `npx vitest run src/tournament` - 44 files, 562 tests, all pass.
- client: `npx vitest run tests/` - 10,703 pass, 4 fail. All four are
  PRE-EXISTING on `origin/main` (`54bb9f33`) and untouched by this work:
  three in `tests/unit/bombPotGuards.test.ts` and one in
  `tests/unit/rabbitHuntIsPaidFor.test.ts`, all source-scanning guards whose
  anchor methods were moved by the settlement refactor. Verified red at
  `origin/main` with these changes reverted; green at the older `c8baae64`.
- `npx tsc --noEmit` clean in both the client and `server/`.
- Every database call in this work was a `SELECT` (CLAUDE.md 11.5). No row was
  modified.
