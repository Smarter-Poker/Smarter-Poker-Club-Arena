# 2026-09-06 - Previous Hand build plan, Phase 6 of 7: disputes and the operator's lookup

Plan: `docs/PREVIOUS-HAND-REPLAYER-BUILD-PLAN.md`. Builds on Phase 5
(`66fa232a4` and the deep dive `7cf3f6910`, live).

A player who thinks something went wrong with a hand had one route: the player
report, which has a hand-id field and folds it into free text -
`Hand: 6421788` inside a paragraph. No operator could open the hand it named,
nothing could count how many flags one hand carried, and the player was never
told what happened. An operator who wanted to look had no route at all: RLS
scopes `hand_history` to the players dealt into a hand, so a club owner cannot
read a hand they were not in, and there was no other door.

Phase 6 builds the two halves, and the second one is what makes the first safe
to have.

## Flag a hand

One button under the expanded hand, beside the private note - the two things a
player wants to do with a hand they are staring at. One is theirs forever;
this one goes to the club.

`ca_hand_flags`: one row per player per hand, a note, a status, and the
operator's reply.

**Every write is a definer function, and that is the design rather than a
preference.** The table has no INSERT, UPDATE or DELETE policy at all.

- `fn_ca_flag_hand` derives the club **from the hand**, so a caller cannot
  file a flag at a club they chose, and it refuses a hand the caller was not
  dealt into - the same `players @> [{userId}]` predicate `hand_history`'s own
  policy uses, restated inside the function because RLS does not apply to a
  definer and the check is explicit or it is not made at all.
- `fn_ca_resolve_hand_flag` **will not close a flag without a note the player
  can read.** "Resolved" with nothing attached is not an answer, and the
  status is the whole feature: a flag that vanishes into a queue is what
  players already had.

**The status comes back to the hand.** Once filed, the card shows where it got
to and, when it is closed, the operator's own words.

## The operator's lookup

`/clubs/:clubId/hand-review`, beside Reports, Disputes and Blacklist. Any hand
dealt at the club, by number, with every seat's holding - the ones that folded
and the ones that mucked, cards the table never saw.

**Two access levels on one page, because they are two different questions.**
Triage is **staff** (owner, co_owner, admin, manager, super_agent, agent):
seeing that a hand was flagged is moderation intake. The cards are
**control** (owner, co_owner, admin, and the club's own `owner_id`). Both sets
are written out inline rather than reusing `is_club_admin()`, whose set is
neither of them and would have handed an agent every hole card at the club.

**The log cannot be skipped**, and that is the point rather than a discipline:

1. `fn_ca_operator_read_hand` writes the `audit_trail` row in the **same
   transaction** that returns the cards. A failed insert fails the read.
2. `audit_trail` REVOKEs INSERT from `authenticated`, so a definer function is
   the only writer.
3. There is no second path to the cards - `hand_history`, `ca_hand_facts` and
   `table_hole_cards` all scope SELECT to the reader's own rows.
4. A reason under eight characters is refused, and it travels into the row
   verbatim. "x" and "." are not reasons.

The UI hides the panel from non-control operators; that is a courtesy.
Postgres is the enforcement, and the page says so.

**The operator watches the same replayer everybody else does.** The read
returns the `hand_history` row in the shape `replayInputFromRow` already
takes, and the cards go in through its `privateHoleCards` seam - the one that
exists for exactly this, "read through RLS-scoped tables by the caller and
keyed by user id". The only difference from a player's view of their own hand
is that no seat is face down.

## The defect that would have shipped a lookup that always looked empty

The first version read the unshown holdings from `table_hole_cards`, on the
reasonable-sounding assumption that a table's hole cards are where a table's
hole cards live.

They are, **for about a day.** Measured on production: 31,836 rows spanning
~29 hours, pruned every six hours by the `cleanup-hole-cards` cron, and 982
rows written in a ten-minute window that dealt 3,821 hands. A dispute is
raised hours or days after the hand. **The lookup would have returned an empty
card map for essentially every hand anyone would ever dispute** - and an empty
map reads exactly like "nobody was holding anything", which is worse than
having no lookup at all, because an operator would have settled on it.

It was caught by a probe line that only printed a count. The assertion above
it passed.

The durable store is `ca_hand_facts`: one row per player per hand, 1.09M rows
back to 2026-08-21, `club_id` already denormalised. Over 800 recent hands -
2,696 seats dealt, 2,696 fact rows, 1,910 with cards, against only 238 seats
that reached a showdown. **1,672 unshown holdings recoverable**, which is the
entire point of an operator's read.

Both are read now, facts first. And the result carries `seats_dealt`,
`seats_with_cards` and `cards_complete`, because `hand_history` reaches back
further than the facts do - so the page says "3 of 9 holdings are on record"
rather than letting an absent card be read as an empty hand. Same
refusal-to-invent as the tracker export, applied to the one read where
inventing would decide a dispute.

## And one that would have thrown on every call

`audit_trail.target_id` is a **uuid** on this database. Both writers cast the
id to text, following the column list in `20260428000001_audit_trail.sql`,
which declares it TEXT - the file and the live column disagree and the live
column is the authority. Every godmode read and every flag resolution would
have raised `42804` at runtime.

The first probe did not catch it, and the reason is worth keeping: every case
in it was **refused at the permission gate before reaching the insert**. A
test that only exercises the refusals never reaches the write. The second
probe impersonated a real operator and ran the whole path.

## Verified against production

One self-aborting `DO` block (CLAUDE.md 11.5), which rolled everything back -
`ca_hand_flags` holds no rows and `audit_trail` is at the count it started
with:

|                                        |                                                                          |
| -------------------------------------- | ------------------------------------------------------------------------ |
| a reason under 8 characters            | refused                                                                  |
| the real read                          | 3 of 3 holdings, `cards_complete`                                        |
| the audit row                          | names the reader, the role, the action, the hand and the reason verbatim |
| a hand dealt at another club           | refused                                                                  |
| an operator of another club            | refused                                                                  |
| a player flagging their own hand       | filed, club derived server-side                                          |
| a player resolving their own flag      | refused                                                                  |
| closing a flag with no note            | refused                                                                  |
| the player reading their own flag      | one row, with the operator's answer                                      |
| an operator of another club reading it | zero rows                                                                |
| audit rows written                     | exactly two: the read and the resolve                                    |

## Pins

`tests/a-godmode-read-is-always-logged.law.test.ts` (a law, registered in
`docs/laws.d/`) holds the four things that make the log unskippable, and
guards the RLS policies the client's self-scoped reads rest on. Deleting the
audit insert turns three of its eight red.

`tests/unit/handFlagReachesTheOperators.test.ts`, 13 more: the table has no
write policy, the club comes from the hand, closing needs a note, staff and
control are different sets, both card stores are read, the service names no
user, and the page is registered in all four places a club page has to be.

## Recorded, so nobody re-runs it

`hand_history.hole_cards` holds exactly what the table SAW. Across 8,193
showdown rows in 4,000 hands: zero mucked seats have cards stored, zero shown
seats are missing them, and no hand carries more card entries than it had
showers. A player reading their own hand learns nothing they were not shown -
which is why the unshown holdings need this lookup, and why it is logged.
