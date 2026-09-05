# The numbers on the page are the numbers in the database

2026-09-05

Four defects on the account surfaces, all the same shape: a value the page
states with confidence that nothing behind it supports.

## 1. Hands played summed to SIX across the whole platform

```
profiles                                 1,312 rows
profiles with total_hands_played > 0         1 row, holding 6
player_stats                             2,795 rows, 1,006 players
SUM(player_stats.hands_played)           6,764,566
busiest single player                       75,356
```

Nothing had ever written that column. It was not stale, it had never been true.

Two readers depended on it:

- `ProfileService.mapProfile` returns `handsPlayed` from it, so every surface
  fed by `getProfile` / `getPublicProfile` showed **0**.
- `ProfileService.getLeaderboard('hands')` does `ORDER BY total_hands_played`.
  A leaderboard ordered by a column that is zero for 1,311 of 1,312 rows is
  ordering by nothing - it returns whatever Postgres feels like, presented as a
  ranking.

**Fixed at the column, not the readers.** `player_stats` is the truth and it is
keyed `(user_id, club_id)` - one row per club - so summing it per player is
correct but cannot be `ORDER BY`'d through PostgREST from another table, and the
leaderboard would still have had nothing to sort on.

So the column becomes a maintained rollup (migration `20260905164455`):
backfilled once, then kept current by `trg_sync_profile_total_hands` on
`player_stats`. The trigger **recomputes** rather than increments - an increment
has to be right on insert, update, delete _and_ the upsert the achievement
engine uses, and being wrong once is permanent. The migration verifies itself in
the same transaction and aborts if any profile still disagrees. It now reads
6,764,566 across 1,006 players; the busiest is RiverDoctor on 75,356.

`mapProfile` also still handed on `profiles.tier` as a `vipTier`. That column is
the literal string 'Newcomer' on every row and may not gate anything
(`tests/vip-is-not-a-ladder.law.test.ts`); it is out of the mapped profile now.

## 2. A save that persisted nothing said "Settings saved!"

Every write in `SettingsPage.handleSave` sat inside `if (user)`, and
`setHasChanges(false)` plus the success toast sat **outside** it. A session whose
auth had lapsed - the exact case where a save fails - skipped every write,
cleared the unsaved-changes flag, and reported success. The player then navigated
away believing their controls were stored.

It now says what happened: "Your Session Expired. Sign In Again To Save These
Settings." Not a bare throw, because the local theme and table-settings writes
above it are real and do survive.

## 3. "Reset Settings" put a paying player back on the free deck

`resetSettings` did `setSettings(DEFAULT_SETTINGS)`, and
`DEFAULT_SETTINGS.cardBack` is `'classic_blue'`. Card backs are a real purchase -
`feature_pricing` sells them at 75 to 300 diamonds. Ownership was never lost, but
the _selection_ was, silently, with nothing in the dialog that said so.

Reset now preserves `cardBack`, and the confirm says why: "Your card back is left
alone, because you may have paid for it."

## 4. The account-closure dialog had no focus trap

`ConfirmModal` carried `role="dialog"` and `aria-modal="true"`, and neither does
anything on its own - `aria-modal` tells a screen reader the rest of the page is
inert, it does not make it inert. Tab walked straight out of the dialog into the
page behind it, and closing dropped focus on `<body>`, so the next Tab restarted
at the top of the document.

On the account-closure confirm that is the worst version: a keyboard player
tabbing past "Confirm" lands on the page they were about to delete, with a live
modal they can no longer see focus inside.

Now: focus is trapped in both directions, **Cancel** takes focus on open (never
the destructive button - it must not be one Enter away from someone who has not
read the message), and focus returns to whatever opened the dialog.

## And three dead components

`VIPUpgradeModal`, `VIPProgressRing` and (earlier today) `VIPStatusCard` were
exported from `src/components/vip/index.ts` and rendered **nowhere**, and each
still carried a piece of the tier ladder Dan struck. A barrel export is not a
use - it is one import away from putting the ladder back on a page, and the
bundler ships whatever the barrel re-exports.

Deleting them also took the CSS leak ratchet from 162 to **161**: half of two
collisions was a stylesheet no page ever loaded. The ratchet had 2 of slack
against reality as well, which is closed, so the next regression is caught by one
instead of three.
