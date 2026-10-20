# 2026-10-20 - Straight Flush and Four Of A Kind unlock from play, horses alike; the milestone toast cannot crash the app

Phase 3A of the Club Arena website fixes (achievements). Re-verified on main
`5a62abf20d7` and production before changing anything; #7462 (achievement
rewards are diamonds, paid once on a server-proved unlock) had already landed.

## What was wrong

- **Straight Flush and Four Of A Kind could never unlock from table play.**
  TablePage passed the winning hand's display name ("Straight Flush",
  "Four of a Kind", from `PokerEngine.evaluate5Cards`) and
  `AchievementService.checkSpecialHand` only knew the snake keys
  `straight_flush` / `four_of_a_kind`. No player held either badge. The name it
  passed was also `winnersArray[0]`'s - the first winner of the hand, not
  necessarily this player - and a horse has no browser, so a horse could never
  earn either (CLAUDE.md 10.5). (Royal Flush was already moved to the server by
  #7462 and was unaffected.)
- **A latent app-wide crash in the milestone toast.** `MilestoneToast` (mounted
  at the app root, only the root error boundary above it) rendered a bus
  payload's `reward` through `formatPopupText`, and `.replace` throws on
  anything that is not a string. The old chip-paying sender
  (`reward: { chips: N }`) was removed by #7462, but the toast, the bus type
  (`reward?: Record<string, unknown>`) and the text helpers still accepted it.

## What changed

- **Migration 20261020022215** (supersedes 20261020005219, which was merged
  in #7513 but never installed: it dropped the Royal Flush trigger to replace
  it, `DROP TRIGGER` needs ACCESS EXCLUSIVE on `hand_history`, waited behind
  readers and was refused by its 5 s `lock_timeout`, nothing committed). The
  Royal Flush trigger is left exactly as it is; a second trigger,
  `trg_hand_history_straight_flush_quads_achievements`, only CREATEd (SHARE
  ROW EXCLUSIVE, which readers do not block), reads the engine's per-player
  record of the strongest hand that won each player a pot
  (`hand_history.daily_mission_events[*].magnitudes.strong_hands`) and records
  9 -> `straight_flush`, 8 -> `quads` through `fn_achievement_unlock_server`,
  horses included, never failing the hand. `quads` and `straight_flush` get
  server evidence `engine_winning_hand`, so the browser door writes nothing for
  them. Rewards are unchanged: Royal Flush 500 diamonds once, the other two are
  zero-reward badges.
- **Client.** `quads` and `straight_flush` are `serverProved`;
  `checkSpecialHand` and the `handRank` hand-off from TablePage are removed.
  The unlock is announced by the server's notification, as Royal Flush is.
- **The toast.** `milestoneRewardText` turns a reward into text (`{ chips: 100 }`
  -> "+100 Chips", `{ diamonds: N }` -> "+N Diamonds", text passes through,
  anything else shows no reward line); title, description and icon only accept
  strings. `formatPopupText` and `arenaDisplayText` never throw: a number is
  text, any other non-string renders as nothing. Title Case and the em dash
  rule are unchanged and still applied.

## Damage already done

- Login-streak and Royal Flush rewards: Dan ruled on 2026-10-19 "NO, ONLY FROM
  NOW ON" (no back-pay), so the three pre-install streak unlocks (two humans,
  August 2026) stay unpaid by his decision. The three Royal Flushes since the
  install (all horses) were each paid 500 diamonds by the live path.
- Straight Flush / Four Of A Kind: zero-reward badges, no money owed. Past
  hands are not scanned (millions of `hand_history` rows; DDL on that table must
  hold its lock for milliseconds). They unlock on the next qualifying hand.

## Proof

- `scripts/ci/test-achievement-diamonds-postgres.py` now applies 20261020022215
  byte for byte after 20261019155445 on a throwaway PostgreSQL 17 cluster and
  proves quads / straight flush for a human and a horse, Royal Flush still paid
  once and not also a Straight Flush, the browser door refused, the Royal Flush
  trigger untouched beside the new one, malformed events never failing the hand. (Its veteran fixture's "last
  login yesterday" now uses the UTC day, as the streaker's already did; it
  failed on a machine whose local date differs from UTC.)
- `tests/special-hand-achievements-are-the-engines-record-horses-alike.law.test.ts`,
  `tests/unit/milestoneToastRewardNeverCrashes.test.tsx`, and new cases in
  `tests/utils/popupStyle.test.tsx`.

## Still browser-only (found, not changed here)

Hands played, wins, tournaments, friends, clubs, profit and biggest-pot badges
are still reported by the player's browser, so horses cannot earn them. They
are zero-reward. The server-side design is the same as this change: derive
each from a server record (`player_stats` / `hand_history` amounts for hands,
wins, pots; tournament results for the tournament badges) and record through
`fn_achievement_unlock_server` with a new evidence value.
