# Horse Brain: The Daily Commitment Audit Classifies Horses By The Accepted Roster (2026-10-08)

**What Was Missing.** Phase 14 closed with one open limit: "The daily audit
still classifies by current profile until it adopts the P14-A roster." The
daily gross >10BB audit (`fn_horse_commitment_audit_step`) decided which seats
were horses by reading today's `profiles.is_horse`. A profile changed after a
hand was accepted therefore changed that hand's diagnostic population, and
every day row and pass receipt said `current_profile_is_horse` because that
was the only basis there was. Since P14-A (`20261007024757`) the settlement
door records, inside the acceptance transaction, who was seated and whether
each seat was a horse (`smarter_private.accepted_hand_rosters`).

**Database** (migration `20261008041707_horse_commitment_audit_accepted_roster_identity.sql`):

- `public.horse_commitment_roster_epoch`: one immutable row naming the first
  accepted roster ever captured. Read back from production on 2026-10-08:
  2026-10-07T12:20:42.398511Z, table `72453d90...`, hand number 27115089. The
  door writes `hand_history.created_at` and the roster's `captured_at` from the
  same transaction clock (equal for every roster sampled), 0 of 4,858 hands in
  the five minutes before the epoch have a roster and 0 of 8,037 hands in the
  ten minutes after it lack one. A hand created before the epoch was accepted
  before the roster existed.
- The audit step, replaced over its live body md5
  `418ef5b18e2470629130e5074790878e` (read back from production first):
  - a hand created before the epoch is classified by the current profile,
    exactly as before (the pre-roster fallback);
  - a hand at or after the epoch is classified only by its own roster, bound
    by table, hand number, hand id and accepted payload hash. Profiles are not
    read for it;
  - a roster marked `unavailable` is named `accepted_roster_unavailable`, a
    malformed one `accepted_roster_invalid`, a missing one
    `accepted_roster_legacy_missing` and one bound to another hand
    `accepted_roster_mismatch`. None of them is replaced by the current
    profile; the hand classifies no horse;
  - a roster whose seated set differs from the dealt list still classifies by
    the roster and adds `accepted_roster_players_disagree`; an unknown roster
    seat adds `horse_identity_unknown` as before.
- Day rows and P14.3 pass receipts carry the basis the pass actually used:
  `current_profile_is_horse`, `accepted_roster` or
  `current_profile_then_accepted_roster`, and four counters
  (`roster_identity_hands`, `profile_identity_hands`,
  `roster_unavailable_hands`, `roster_missing_hands`) that sum to the hands
  scanned. A pass already under way at install began under the profile-only
  body: its counters stay NULL and it can only be named
  `current_profile_is_horse` or, once it reaches rostered hands,
  `current_profile_then_accepted_roster`.
- `fn_horse_commitment_selection_receipt` and `fn_horse_commitment_review_page`:
  the top-level `identityBasis`, previously the constant
  `current_profile_is_horse`, now names the day's basis over its whole UTC
  day. Nothing else in either body changed.
- Every existing guard, cursor, receipt rule, prune, the batch size 256,
  `lock_timeout` 2 s, `statement_timeout` 5 s and the return contract are
  unchanged. Each replaced function is preimage- and postimage-guarded.

**Engine Consumers.** The private daily review command's strict parsers
(`server/src/services/horseDailyCorrectiveReview/{contract,selection,validation}.ts`)
accept exactly the three basis names and refuse any other. No live horse
decision reads any of this.

**Timing (realistic fixture, PostgreSQL 17).** 60,000 hands at six seats
(production averages 3.2), 2,166 profiles, one captured roster per hand, 198
consecutive steps of 256 hands each, every step its own transaction:

| Body and path                                          | Mean        | p95         | Max         |
| ------------------------------------------------------ | ----------- | ----------- | ----------- |
| Previous body, cold first run                          | 364 ms      | 699 ms      | 779 ms      |
| Previous body, warm                                    | 56 to 62 ms | 58 to 64 ms | 79 to 84 ms |
| New body, profile path (pre-epoch day), warm           | 57 ms       | 60 ms       | 149 ms      |
| New body, roster path (post-epoch day), cold first run | 305 ms      | 602 ms      | 638 ms      |
| New body, roster path (post-epoch day), warm           | 28 ms       | 34 ms       | 96 ms       |

Production measured the previous body at mean 251 ms and max 2.4 s over
23,398 calls since 2026-10-04. The new body does no more work per hand on the
profile path and less on the roster path (no per-seat profile lookups), so it
keeps the same margin inside the 5 s statement timeout.

**Regression Protection.** `scripts/ci/test-horse-commitment-audit.py` gains
two PostgreSQL 17 jobs. Job 6 installs the real migration over the P14.3 step
and readers, proves it is refused with no roster captured, on a drifted step
header or body, on a drifted reader body and on a repeat, each leaving the
state unchanged, then runs the retained 85, 24 and 58 controls unchanged on
the new bodies. Job 7 runs `roster-basis.sql`, 40 named checks covering a
pre-roster day, a mixed day, a roster day, a profile changed after acceptance
in both directions, unavailable, invalid, missing and mismatched rosters, a
pass under way at install, a re-pass after profile flips, both readers, the
epoch's immutability and the closed basis names.

**What This Is Not.** Not a repair job, sweep or backfill: no review, gap or
receipt row is rewritten and nothing is re-driven. Reviews already written
keep their first-write content; production had 0 reviews at or after the
epoch when this was written. Not coverage, population, GTO or activation
authority. Horses are players: the roster's classification is read only as
identification.
