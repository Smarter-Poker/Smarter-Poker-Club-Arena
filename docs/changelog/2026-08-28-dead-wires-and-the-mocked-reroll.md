# 2026-08-28 — The mocked reroll, the push filter that filtered nothing, and two silent swallows

## Reroll (10 Diamonds) was theatre — now real

DailyChallengesPage's reroll handler decremented LOCAL React state, toasted
"Challenge swapped! (Mocked)", and the 800ms reload restored the real diamond
count and the SAME challenge. A confirmed purchase dialog that charged
nothing and delivered nothing.

New RPC `reroll_daily_challenge` (migration 20260828, applied to production
and probed under rollback): auth.uid() pays via deduct_diamonds (the
buy_streak_freeze pattern), refusals return in the payload BEFORE any
diamond moves, the replacement is a random same-tier catalog entry excluding
everything already assigned for that period key, completed/claimed rows
refuse to swap, and charge+swap share one transaction. anon cannot execute
it (asserted in the migration). Client: dailyChallengeService.rerollChallenge

- a real handler; the old totalDiamondsEarned pre-check is gone — that figure
  is lifetime earnings, not a balance.

## Push preference filter queried columns that do not exist

PushNotificationService.filterByPreferences filtered on camelCase field
names (tableAlerts, settlementAlerts, ...) against
user_notification_preferences, whose real columns are snake_case AND
different words. PostgREST errored, the code destructured only { data },
and the empty-result branch sent EVERY push to EVERY user — all /settings
notification toggles were inert for push, silently, forever.

Rewired to the verified real columns (live_notifications,
tournament_reminders, daily_challenges, friend_activity, club_updates), with
two semantic fixes: opt-OUT filtering (`.eq(field, false)` + subtract), so
users with no preferences row are no longer dropped the moment anyone else
opts in; and the query error is now reported (fail-open stays deliberate —
preferences must never silently kill delivery). settlement / wallet_credit /
general never filter: money notifications have no opt-out column.

## Silent swallows

- VIPService.consumePurchase: RPC failure was console.warn — the paid
  feature was granted and the use never decremented, invisible ledger drift.
  The grant stands (err in the player's favour) but failures now go through
  reportError.
- ClubAnnouncementsPage.handlePost: a THROWN failure was Sentry-only — the
  composer sat open with no feedback. It now toasts like the in-band error
  branch always did.

## Dead read removed + picker honesty

- HomePage ran a profiles.preferences.card_color_preset query on every
  mount; nothing writes that key (repo-wide and production-verified: one
  legacy row). Removed.
- HamburgerMenu's Card Colors ring now follows SETTINGS_CHANGED{cardBack},
  so a card back picked in /settings or Theme Settings no longer leaves the
  picker highlighting the old design while the felt deals the new one.
