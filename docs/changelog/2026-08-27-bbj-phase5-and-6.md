# 2026-08-27 — Bad Beat Jackpot, phases 5 and 6

PR #1500 (`agent/cowork-bbj/feat/bbj-phase5`). Follows #1444, #1469, #1477,
#1481, #1488.

## Phase 5 — three things that were merely missing

**One formatter per figure** (`src/utils/handFormat.ts`). Four hand surfaces
carried three copies of `stamp`, three of `gameTypeLabel` and four of `money`.
Two of the `gameTypeLabel` copies were mine, written this week. The divergences
were user-visible in every case:

| copy                  | how it differed      | what a player saw                                               |
| --------------------- | -------------------- | --------------------------------------------------------------- |
| `HandDetailModal.fmt` | not NaN-safe         | the string `NaN` in a chip figure, beside a tab printing `0.00` |
| two of three `stamp`  | no null guard        | `NaN-NaN-NaN NaN:NaN:NaN` where the third printed blank         |
| one `gameTypeLabel`   | no `short_deck` case | `short_deck` on screen where the popup said `Short Deck`        |

`tests/unit/handFormat.test.ts` (13) pins each of those cases specifically.

**An orphaned payout is loud** (`20260827g`). `runStep` continues after a failed
step by design, so a failed `hand_history` write leaves a jackpot payout with no
hand and nothing reporting it. Two triggers now record it —
`trg_log_jackpot_hand_deleted` (BEFORE DELETE on `hand_history`) and
`trg_log_jackpot_payout_without_hand` (AFTER INSERT on `bbj_payouts`) — into
`bbj_hand_evidence_log`, and `fn_bbj_orphaned_payouts()` answers on demand.

A foreign key was considered and rejected. `ON DELETE RESTRICT` would make the
pruner's batched delete fail if one jackpot hand entered a batch, stalling
retention on a 3.6 GB table growing ~0.5 GB/day; `ON DELETE SET NULL` erases the
evidence. Neither trigger blocks — the house already settled this shape with
`ca_seat_stack_exits` (CLAUDE.md 11.5): make it LOUD, not impossible.

24 orphans exist today, all from the pruner before `20260827d`, and all with no
hand row at all — `fn_bbj_relink_payouts()` finds nothing to reattach, which is
the expected answer, not a failure.

**The history is pageable** (`20260827h`). `fn_bbj_recent_hits` capped at
`LEAST(p_limit, 25)` with no cursor, so a club's 26th jackpot was unreachable
from the product. Now a keyset cursor on the pair `(created_at, id)` — a
timestamp alone silently SKIPS a tie, and skipping a jackpot on a money surface
is worth a second parameter to rule out — plus `total_hits` so the UI knows
whether another page exists. Keyset rather than OFFSET because the list is
realtime and new hits land at the top, where an OFFSET page 2 repeats the row
that shifted across the boundary.

Verified live: three pages over the busiest pool return 5 + 5 + 14 = 24 distinct
rows, no gap, no repeat.

## Phase 6 — the audit, and what it found

**A crash.** `BBJHitNotification` called `amount.toLocaleString()` on a value
typed `number` but sourced from a realtime payload. A null there threw inside
render and took the whole table page down, at the moment a player had just been
paid.

**The avatar was never doubled.** Dan asked for double the 48px avatar. I
shipped 60 in #1469 — 1.25x — with the comment beside it still claiming 76, and
the narrow-phone breakpoint shrinking it back to 48, undoing the instruction
entirely on the phones this is mostly read on. Now 96 / 72, with
`tests/unit/bbjAvatarSize.test.ts` reading the `.tsx` constant and the `.css`
box together, because this number has now drifted twice and neither TypeScript
nor any renderer test can see across those two files.

**Four stuck states.** A permanent loading skeleton when the route had no
`clubId`; a per-club reset that left `jackpot`, `poolFacts`, `myHands` and
`loadFailed` behind, so one club's balances showed under another club's name; a
realtime handler closed over the first render's loader (when `user` was still
null), so "your contribution" never appeared however many jackpots landed; and a
`failed` flag that nothing ever cleared, sticking the winners panel on its error
message for good after one transient RPC error.

**A subscription that was not filtered.** `BBJRecentHits` scoped the channel
NAME to the pool and not the subscription, so every jackpot on the platform
forced a refetch. Both sibling surfaces already filtered on `pool_id`.

**Things drawn without style.** `.hdv__bbjp-name.is-you` was never defined, so
the "you were paid" highlight — the one row a player looks for in that box —
rendered identically to everyone else's, despite `currentUserId` being threaded
four components deep to compute it. `hdv__act--muck` and `hdv__act--discard` had
no rules. `.loading-state` was borrowed from whichever other page's chunk
happened to be in the bundle.

**Dead configuration.** `BBJRulesPanel` declared four props no caller could ever
pass. The modal that HAS table context renders `BBJBasicPanel` /
`BBJQualifyingHands`, which are already wired to the highlights. Every branch
those props gated was unreachable, including both YOUR GAME / YOUR STAKES
markers — so the next person wanting that feature would have wired it here and
watched nothing happen.

Also: two pots sharing a label collided on a duplicate React key and one was
dropped from the pot line; `BBJTicker` printed the raw `loser_hand` enum;
`BBJAdminAnalytics` kept a private `money`; Space on the ticker activated it and
scrolled the page.

## Notes for whoever is next

- CI's new-migration check fired on this branch and was RIGHT: the schema
  manifest is a checked-in snapshot, and a newly applied migration has to be
  snapshotted in the same PR (`scripts/ci/gen-schema-manifest.mjs`).
- `scripts/ci/check-bbj-functions-match-production.mjs` compares the repo's
  definition against production by md5. Write the function signature exactly as
  `pg_get_functiondef` prints it back (`timestamp with time zone`, `NULL::uuid`)
  or it reports a drift that is not there.
- Still open, deliberately: `bbj_payouts.hand_id` is not a foreign key (see
  above), and `BBJTicker` still has zero importers while two other components'
  comments claim it owns the jackpot strip.
