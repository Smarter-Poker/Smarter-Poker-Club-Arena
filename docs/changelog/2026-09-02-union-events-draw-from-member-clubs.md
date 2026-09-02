# A union's events were drawing from 28 horses

**2026-09-02** - `fix/union-events-draw-from-member-clubs`

## What happened

The club-membership rule added on 2026-09-01 was right and stays. Dan asked for
Deep Stack Society to be standalone - "IT CAN NOT WANDER... THEY ARE LIMITED TO
ONLY THE CLUB THEY ARE APART OF" - and `clubMemberIdsForTournament` enforced it
by resolving every tournament to the single `club_id` row it hangs off.

That is correct for a standalone club and wrong for a union event, because a
union event hangs off the union's OWN club row while the horses live in the
union's MEMBER clubs.

|                                                      | horses                            |
| ---------------------------------------------------- | --------------------------------- |
| `Midway Union` club row (what the filter used)       | 323                               |
| Club JAQK + SHARK CLUB (where the fleet actually is) | 584, of which 392 tournament-lane |

Candidates for a live union event, measured today:

| rule                                | candidates |
| ----------------------------------- | ---------- |
| host club only (shipped 2026-09-01) | **28**     |
| union-wide (this change)            | **203**    |

Twenty-eight. That is the pool the union's entire tournament schedule was
drawing from, and `[TournamentRecurring] registerHorses found no candidates`
was the engine's most frequent tournament log line as a result.

## How it hid

The warning counted the exclusion and never printed it:

```
registerHorses found no candidates: fleet 1000, at-capacity/entered 215, lane/window-excluded 108
```

`clubDropped` was 677 and appears nowhere. The line invited the reader to
conclude the other 677 horses did not exist. It prints every bucket now.

## The change

`clubMemberIdsForTournament` reads `union_id` alongside `club_id`. With no
union it behaves exactly as before - one club, its own members, which is the
whole answer for a standalone club. With a union it widens to every club in
that union (`clubs.union_id` and `union_clubs`) plus the host row itself.

A failed read of the union map returns `null` rather than falling back to the
host club, because falling back would re-create this exact bug invisibly. The
caller already fails open on `null`.

## Isolation is unchanged

Deep Stack Society has `union_id = NULL` and no `union_clubs` row, so its
events never take the union branch and still resolve to exactly its own 416
members. Pinned in `HorsesStayInTheirClub.test.ts`.

## Verification

- `npx tsc --noEmit` clean
- `npx vitest run` - 325 files, 3,624 tests, all pass
- The broken pin (`eq('club_id', hostClubId)`) was updated in this commit, not
  left asserting the old rule, and six new pins cover the union branch, the
  standalone branch, the host-club-always-included property and the
  fail-closed-on-union-read-error property.

## Still open

`registerHorses` intermittently logs `page_failed: supabase_timeout` on the
fleet read and then skips the pass entirely (`fleet read incomplete`). Failing
closed there is deliberate and correct - registering from half a pool is how the
same page gets drained - but a transient timeout should be retried rather than
costing a whole cycle. Not changed here; it wants its own PR.
