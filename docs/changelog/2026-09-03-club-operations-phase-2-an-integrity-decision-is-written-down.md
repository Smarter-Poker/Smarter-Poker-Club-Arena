# Club Operations, Phase 2 of 8: an integrity decision is written down

**Branch** `feat/club-operations-full-upgrade` - **Migrations**
`20260903170000_an_integrity_decision_is_written_down.sql`,
`20260903180000_a_cleared_pair_stays_cleared.sql`

Four pages under Club Control - Anti-Cheat, Reports, Disputes, Blacklist - and
on three of them a control reported success and wrote nothing at all.

## What was wrong

**The flag review has never recorded a decision.** "Submit Review" ran a client
UPDATE against `anti_cheat_flags`, a table that grants `authenticated` exactly
one policy, read the flags raised against yourself, and no UPDATE policy at
all. PostgREST answers a policy-filtered UPDATE with 204, zero rows and no
error, so the page painted "Flag reviewed successfully." every single time. An
operator has been making decisions this console silently discarded.

**Disputes could never leave `open`.** Start Review and Escalate were the same
shape against a table carrying one SELECT policy, so both matched zero rows.
Those two surfaced as failures rather than false successes, which is why the
page's own `under_review` filter tab could never fill.

**Kick removed nobody, and would have destroyed a stack if it had.** It stamped
`left_at` and `status = 'kicked'` onto `table_seats` - the write CLAUDE.md 11.5
forbids, because a seat closed outside a cash-out destroys the chips sitting in
it. It also had no `tableId` at any call site, so the seat branch was skipped
and the compensating `anti_cheat_events` insert was refused by RLS.

**The console read the route param straight into `clubId`.** Club routes are
addressed by slug and every read here passes `clubId` into a uuid argument, so
Postgres answered `22P02` on every query and each catch block turned that into
an empty state. The page has shown six zeros and the words "Club Is Clean" on
every club URL since it shipped, and nothing anywhere went red.

**Anti-Cheat was reachable by any staff member.** `anti-cheat` was missing from
`OPERATION_SUFFIXES`, so the rail's permission check never applied to it.

**The review dialog's evidence block has never rendered.** The interface
declared a `details` column that `anti_cheat_flags` does not have. The evidence
a flag carries is `reason`. No reviewer has ever seen why a flag was raised
while deciding what to do about it.

**Reports subscribed to a table that is not published.** `user_reports` is
absent from `supabase_realtime` and its RLS grants a moderator nothing, so the
subscription could never deliver a row. The queue also capped at 100 without
saying so.

**Blacklist asked an operator to type a player uuid by hand,** and never
mentioned that an exclusion does not empty a seat.

## What shipped

`20260903170000` adds one gate, `fn_ca_can_review_integrity` (owner, co-owner
or admin, and `auth.uid() IS NOT NULL` in the gate itself), and routes seven
functions through it: `fn_club_anti_cheat_flags`, `fn_review_anti_cheat_flag`,
`get_anti_cheat_stats`, `detect_collusion_pairs`, `fn_ca_dismiss_collusion_pair`,
`fn_dispute_start_review`, `fn_dispute_escalate`. Every one is definer,
search-path pinned, revoked from `anon`, granted to `authenticated`. Every write
reads `GET DIAGNOSTICS ROW_COUNT` and returns `{ ok: false, reason }` rather
than a silent 204, and the flag review writes its `anti_cheat_events` row in the
same transaction as the decision.

The client stopped writing to tables that refuse it. Kick asks the engine, over
the tables the player is actually sitting at in this club, and reports partial
success honestly. The console resolves the club uuid before it queries
anything, separates "nothing found" from "the read failed", and names a `42501`
as a role refusal instead of painting zeros. `anti-cheat` moved to `'control'`
access and joined `CONTROL_SUFFIXES`. Reports polls on a 45s visibility-gated
timer and says when it is showing its own ceiling. Blacklist picks a person off
the roster, warns when the excluded player is still seated, offers to remove
them through the engine, and sweeps expired rows.

## The verification pass found two defects in this phase's own work

Probing every new write path as the real user, inside a transaction that is
rolled back:

**`fn_ca_dismiss_collusion_pair` could never have worked.** It wrote
`status = 'dismissed'`. `collusion_tracking_status_check` allows
`open | reviewed | cleared | actioned`, so the Clear button would have thrown a
raw constraint violation at every operator who pressed it. The word came from
`detect_collusion_pairs`, which has always filtered `status <> 'dismissed'` - a
predicate that is true for every row in the table, because no row can hold that
value. That filter has never excluded anything.

**And that matters far less than what the filter was letting through.**
`collusion_tracking` holds 169,530 rows: 7 open, 169,523 cleared. 169,519 of
those carry the note _"Auto-cleared 2026-08-18: both players are house-run AI
horses, which cannot collude with each other. Detector fixed at write time in
smarter-poker-workers edf5691."_ So the phase 2 scoping fix - which correctly
stopped filtering by `club_members` and started asking where the hands were
played - was reading through a filter that let every auto-cleared row back in,
and would have shown this club's operator 5,591 pairs a known detector bug had
already accounted for. Replacing "0 pairs, wrongly" with "5,591 pairs, wrongly"
is not an improvement.

`20260903180000` screens the rows the detector left **open**, returns
`closed_pairs` alongside so an empty queue reads as "the screen ran and closed
itself" rather than "nothing was screened", and clears only currently-open rows,
to `'cleared'`.

This does not exclude horses from anything (CLAUDE.md 10.5). The
horse-versus-horse ruling was made at write time by the team that owns the
detector and is recorded in the row; re-surfacing rows they closed would be
second-guessing that ruling from a page with no standing to make it. The
migration says so where the next reader will find it.

Two smaller corrections in the same pass: the second collusion group was
labelled "win rate" while carrying every pattern that is not `CHIP_DUMP` - three
of the seven rows open on the estate are `TIMING_CORRELATION` - so it is
`screening` now and each row names its own pattern; and the window count moved
to the maintained `club_hand_daily` rollup, which answers in 75ms what
`hand_history` answered in 448ms. The whole call went from ~1,400ms to **397ms**.

## How it was verified

Live, against production, as the real user, inside a rolled-back transaction:

- An ordinary club member is refused `42501` by all four integrity reads.
- The flag review returns `{"ok":true,"updated":1}` and writes exactly one
  `anti_cheat_events` row.
- Both dispute transitions work and refuse re-entry (`not_open`,
  `already_escalated`).
- `detect_collusion_pairs` returns `chip_dump_total 0, screening_total 0,
closed_pairs 5591, analyzed_hands 273794` in 397ms.
- `fn_ca_dismiss_collusion_pair` on a foreign pair returns
  `{"ok": false, "reason": "pair_did_not_play_here"}`.

Gates: `all-gates.sh` (tsc, fourteen house rules, the whole vitest suite, vite
build, bundle size) plus `check-migrations-applied`,
`check-applied-migrations-are-recorded`, `check-definer-authorization`,
`check-phantom-tables`, `check-phantom-columns`, `check-route-targets`,
`check-painted-text-case`, `check-maybe-single`, `check-bus-wiring`,
`check-db-copy`, `check-required-columns`, `check-no-orphaned-work`,
`check-embed-relationships` and `npm run lint`. All green.

New tests: `tests/unit/integrityDecisionsAreWrittenDown.test.ts` (41 cases -
every function definer, pinned and granted; the gate refusing an anonymous
caller; zero rows treated as failure; the corrected status; the open-only
screen; the client reading the corrected shape) and
`tests/components/anti-cheat-console.test.tsx` (11 cases - the console mounted
for the first time, the slug never reaching a uuid argument, a read failure
named rather than called clean, the collusion tiles, each row's own pattern,
and a clear that reports honestly when nothing moved).

Three existing tests were updated deliberately, not to make red go away: the
hover law (a `:hover` I added became `:focus-visible`), the accessibility pin on
`htmlFor="blacklist-user-id"` (that input is a roster picker now), and phase 1's
agent-visibility case (`anti-cheat` moved from staff to control).

## Deploy route

Push the branch, and stop. `agent-open-pr.yml` opens the PR, `agent-autopilot.yml`
holds squash auto-merge until the required checks are green, and
`publish-club-arena.yml` publishes on merge. Nothing here touches Hetzner, rsync,
SSH, a deploy hook, Vercel, the World Hub repo, or the retired
`public/hub/club-arena/` path.
