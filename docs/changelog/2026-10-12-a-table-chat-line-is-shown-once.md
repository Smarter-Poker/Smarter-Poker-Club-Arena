# A table chat line is shown once (2026-10-12)

Dan sent "Good Luck" once at table `979f84b0-...`. `table_chat` holds exactly
one row for it (`613ead3c-...`, 05:51:17 UTC). The Table Chat panel drew it
three times. Nothing was sent three times; the browser drew one row three times.

## Cause

`useTableChat` appended every `TABLE_CHAT_INSERT` it was handed without asking
whether that row was already on screen. Several things hand it the same row
more than once:

- **Stacked channel listeners.** `TableWebSocket` assumed supabase-js does not
  dedupe topics (its 2026-08-22 comment says so). The installed realtime-js
  2.90.x does: `client.channel('table:<id>')` returns the channel already
  registered under that topic. A previous instance's channel stays registered
  until its leave round-trip finishes, and the hook's props churn 2-3 times per
  table mount, so the next instance was handed the old object and added its
  listeners to it.
- **Cross-tab echoes.** MasterBus forwards every event to every other open
  smarter.poker tab and only drops identical events inside 500ms. A second tab
  holding the same table, or a throttled background tab, echoes the row back
  later than that.
- **Channel rejoins** can redeliver.

## Fix

1. `useTableChat` keys live chat by the row's primary key. A row already shown
   (from history or an earlier delivery) is ignored entirely: no second line,
   no second unread tick, no second chime. The state updater checks too.
2. `TableWebSocket.connectOnce` never reuses a table channel. Anything still
   registered under `realtime:table:<id>` is removed before the channel is
   created; if it will not go, the connect retries later instead of stacking
   listeners onto it.

Pinned by `tests/unit/aTableChatLineIsShownOnce.test.ts` (fails on the old code,
passes now).
