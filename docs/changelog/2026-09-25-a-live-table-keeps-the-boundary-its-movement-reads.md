# A live table keeps the boundary its movement reads (2026-09-25)

A dated hazard that had not fired. It was due at about **21:53 UTC today**, and
it would have made one live tournament table permanently unable to move its
players. Closed at 21:07 UTC, before anything was lost.

## The shape of it

F06 player movement is proved from two records per hand. Both obligations are
permanent. Only one of the two records is.

| read                                   | what it needs                                                                                                                                                                        | is it permanent?          |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------- |
| `smarter_private.f06_movement_permits` | for every `accepted` permit the table ever held, the matching `public.hand_atomic_commits` row                                                                                       | **no** - pruned at 8 days |
| `smarter_private.f06_movement_prior`   | the table's LAST commit (`max(hand_number)`) and its `public.hand_history` row, out of which it validates the post-commit payload hash, the request hash and the whole stack receipt | **no** - pruned at 8 days |

`public.sp_prune_hand_history` deletes both tables for horse-only hands at
`hand_history_retention_policy.horse_retention_days` - eight days, Dan's storage
decision of 2026-09-17 and the one sanctioned asymmetry in CLAUDE.md 10.5. That
decision is unchanged here, and the pruner was neither slowed nor gated.

Its single F06 guard, `smarter_private.f06_hand_cards_unresolved(table, hand)`,
retains the hand whose OWN permit is still `reserved`. That is the hand that
never started, and it has no history row to retain. **The hands the table had
already dealt were not covered by it at all**, so retention reached straight past
the guard and deleted the two records above.

## Measured, 2026-09-25 20:34-20:55 UTC

- **Nothing had been lost.** Of **1,148,364** `accepted` permits, **zero** were
  missing their matching `hand_atomic_commits` row (anti-join on
  `(table_id, hand_number)`).
- **649** `hand_history` rows at **8** tables already satisfied _every_ clause of
  the candidate set, including the F06 guard, which does not see them. All 8 are
  in RUNNING tournaments ($100 Freeroll - 12:00 PM, Afternoon Free Buy (NLH)),
  none deleted, each with 1-2 players still seated and **exactly one non-terminal
  `f06_operations` row** - a movement pending since 2026-09-17.
- **One of the 649 was its table's `max(hand_number)` commit**, i.e. the exact
  row `f06_movement_prior` loads:
  table `66b1cb1d-5056-41c1-a951-1bd078f8276f`, hand `12114088`, created
  2026-09-17 17:09:34 UTC.
- The job runs at :03,:13,:23,:33,:43,:53 and was measured deleting **10,000
  rows per run** (queue ahead of that row: 64,048 at 20:52 -> 54,048 at 20:53).
  Six runs. **Due at about 21:53 UTC.**
- A second, wider crossing followed at **2026-09-26 02:03:20 UTC**, when the
  oldest `accepted`-permit-backed hand (2026-09-18 02:03:20, the subsystem's
  first) turned eight days old and began exposing the permit path across
  **27,522** tables' worth of permits.

## The cause

A permanent obligation reading impermanent evidence. Fixed at both places it
reads it (CLAUDE.md 10.11), because neither half alone lands the fix (10.86 rule
4): the permit path bites a **healthy** long-running table whose custody is
fully resolved, and the boundary path bites a **stalled** table whose permits are
all decided.

No detector, no sweep, no repair job, no backfill, no compensating write, and no
change to the retention clock (10.12). Nothing needed settling, because nothing
had been lost.

## Fix 1 - an accepted permit is its own witness

`accepted` is written in exactly two places and both verify the seal as they
write it: `smarter_private.f06_accept_hand()` only fires when
`NEW.post_commit_completed_at IS NOT NULL`, and `public.fn_f06_finish_hand`
raises `F06_HAND_EVIDENCE_REQUIRED` unless the commit row exists with
`hand_id = p_evidence_id AND post_commit_completed_at IS NOT NULL`. Both set
`evidence_id` in the same statement. `smarter_private.f06_immutable_identity()`
then refuses every later UPDATE (`F06_HAND_IDENTITY_IMMUTABLE`, since
`OLD.state <> 'reserved'`) and every DELETE (`F06_HISTORY_IMMUTABLE`), and
`tests/the-permit-ledger-outlives-the-hand.law.test.ts` pins the ledger as never
pruned. So an accepted permit carrying an `evidence_id` **is** a permanent,
unforgeable record that this exact seal was verified.

This is not "pass when the evidence is missing" (10.86 rule 1):

- commit row **present** -> every check applied exactly as before, unchanged;
- commit row absent but a **different** commit occupies `(table_id, hand_number)`
  -> identity conflict, refuse. This is what the old bare `a.hand_id IS NULL`
  test was really catching, and it is kept;
- coordinate **empty** -> retention took it, and the immutable permit stands.

`evidence_id IS NULL` on an accepted permit is a state neither writer can
produce, so it refuses. The boundary check, the `never_started` /
`aborted_unsettled` arm, the `ELSE true` default covering `reserved` and any
unknown state, and the in-flight dispatch refusal are all carried over
unchanged.

## Fix 2 - a live table keeps the boundary its movement reads

The sealed payload `f06_movement_prior` validates cannot be reconstructed from
anywhere, so fix 1 cannot substitute for it. The guard was measuring the wrong
scope - the unresolved _hand_ instead of the table whose movement is still owed -
so `smarter_private.f06_movement_boundary_retained(table, hand)` gives it the
real scope, and the smallest one that is sufficient: the table's **current** last
committed boundary, while the table is still one F06 can be asked to move (it
exists, is not deleted, is not closed, belongs to a tournament, and that
tournament is not COMPLETED/CANCELLED).

Cost, measured: **1,020** live tournament tables, **797** holding a committed
boundary, and only **8** of those old enough to have been prunable today. One
hand per live table, bounded by the live table count and not by time. It releases
itself twice over: the moment the table deals its next hand the old boundary
stops being `max(hand_number)`, and the moment the tournament completes or the
table closes the whole table prunes normally. Retention ends when the reason
ends, which is the shape the existing `reserved` guard already had.

Rejected alternative: retain every hand at every unresolved-custody table
(27,704 rows / 129 MB measured). Correct, but 35x the data and far more than
either function reads.

## Horses

Every one of these hands is horse-only and almost every seated player at the
eight tables is a horse. The eight-day retention asymmetry is a storage decision
(10.5) and it is not licence to break a horse's table: a horse's pending
movement is now protected by exactly the record a human's would be, and the
guard never looks at `is_horse`.

## Applied and pinned

- Migration `20260925210126_a_live_table_keeps_the_boundary_its_movement_reads.sql`,
  one transaction, `lock_timeout` set, asserting both function bodies by md5 as
  preimages and re-reading the protected row as a postimage. Applied 21:07 UTC;
  history recorded byte-exactly (20,901 bytes, md5
  `ead247f4c97d145116f6939a105988c6`).
- Verified live at 21:08 UTC: the guard returns true for table
  `66b1cb1d-...`/hand `12114088`, its `hand_history` and `hand_atomic_commits`
  rows are both still present, and 8 previously prunable boundary rows
  platform-wide are now retained.
- Law `tests/a-live-table-keeps-the-boundary-its-movement-reads.law.test.ts`
  with its entry in `docs/laws.d/`.

## What this does not fix

The 552 `reserved` permits wedging their tables are a different defect with a
different owner and a different fix (the abandoned-generation door, #5163,
waiting on the engine cutover). Draining them reduces the number of tables with
a pending movement, but it does not remove either dependency this closes: the
permit path applies to healthy tables too.
