# The other door a horse walks through

Dan, 2026-09-01: "IT CAN NOT, WANDER... THEY ARE LIMITED TO ONLY THE CLUB THEY
ARE APART OF!"

#2430 answered that for registration and said so in its own commit message.
It was half the answer.

## What was still open

`registerHorses` is one of two ways a horse reaches a tournament seat. The
other is `pickFreeHorses`, which fills every seat-first format — Spins,
Heads-Up, SNGs — and the past-start top-up. It reads the whole fleet:

    supabase.from('profiles').select('id').eq('is_horse', true)

Every horse on the platform, no club anywhere in the query. #2430 shut the
front door and left this one open, which is why the wandering did not stop
when it merged.

Measured on the live floor after #2430 was in main, for the 416-account
population built for a standalone club:

| where                             | open seats |
| --------------------------------- | ---------: |
| cash tables in another club       |          0 |
| tournament tables in another club |        173 |

Zero on cash is the same result #2430 measured, and for the same reason:
`atomic_table_buyin` debits `club_members.chip_balance`, so a non-member
cannot buy in. Every one of the 173 was a tournament table, reached through
`pickFreeHorses`.

## The change

`clubMemberIdsForTournament` is lifted out of `registerHorses` — where #2430
left it inline — into one method both callers use. `pickFreeHorses` takes the
tournament it is filling and narrows the platform fleet to that club's members
before `selectHorseCandidates` sees it. Both call sites pass their tournament:
the opening fill and the top-up are separate paths to the same seats, and
scoping one would have repeated this bug in miniature.

Nothing else about selection moves. The four-game busy cap, the lane filter,
the cash-room reserve and the shuffle are untouched.

## Failing open, on purpose

An unreadable or partial membership page returns `null`, not an empty set, and
both callers skip the filter on `null`. A partial read is not an empty club.
Refusing to seat on a failed read would starve every board on the platform —
the same shape as the bug that emptied the cash floor for forty minutes on
2026-08-31 — which is a worse failure than the one being fixed here.

## Verification

`HorsesStayInTheirClub.test.ts` grows from 6 pins to 11. The pins that covered
#2430's inline block now cover the shared method, plus one that asserts the
inline copy is gone rather than duplicated.

Four mutations applied and each observed failing before the fix was kept:

1. `const inClub = fleetIds` — filter computed, never applied. 2 tests fail.
2. opening call site reverted to `pickFreeHorses(opening)`. 1 test fails.
3. top-up call site reverted to `pickFreeHorses(poolWanted)`. 1 test fails.
4. incomplete read returns `new Set()` instead of `null`. 1 test fails.

`tsc --noEmit` clean. The neighbouring seat-first suites — `seatFirstFillOrder`,
`heldEmptyRotationAndSoleOpen`, `pickFreeHorsesLimits` — stay green at 27 tests.
