# 2026-08-29 — OneSignal was still loading on every session, ten days after it was removed

## What was happening

OneSignal was retired on 2026-08-19 and replaced with self-hosted VAPID web
push. The loader was left behind. Confirmed on production, on a live Club Arena
page, 2026-08-29:

```js
typeof window.OneSignal; // "function"
document.querySelectorAll('script[src*=onesignal]');
// https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.page.js
// https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.page.es6.js?v=160609
```

`index.html` injected the v16 SDK three seconds after every page load. So every
Club Arena session was:

- fetching and executing a third-party SDK for a vendor the platform does not
  use,
- making a request to `api.onesignal.com/sync/<app-id>/web` — announcing the
  visit to that vendor,
- and holding three allowances open in the hub's CSP (`cdn.onesignal.com` in
  `script-src`, `api.onesignal.com` and `onesignal.com` in `connect-src`) that
  would otherwise have been carried into any enforced policy.

Nothing observed it. The only consumers were four methods on
`PushNotificationService` — `init`, `setExternalUserId`, `requestPermission`,
`isEnabled` — and between them they had exactly one caller anywhere in the app,
a line in `IdentityDNA` that handed the SDK a user id.

## What was underneath

`PushNotificationService.sendToUsers()` is a retired no-op and has been since
2026-08-19. It:

- ran a `filterByPreferences` query first — a database round trip to decide who
  to send nothing to,
- warned once per session at `console.warn`,
- returned `false`,
- and then had **eighteen lines of unreachable code** after the `return`,
  calling the `send-push-notification` edge function. It reads exactly like a
  working transport.

Eight call sites use it — cashout, credit requests, disputes, settlements,
tournament auto-seat — and none of them check the return value.

It cannot simply be repointed. Verified against production the same day:
`notifications` has RLS on with a single INSERT policy, `service_role` only,
and `push_outbox` grants the browser nothing. A push is raised by inserting a
`notifications` row, which `trg_mirror_notification_to_push_outbox` mirrors into
`push_outbox` for `/api/cron/push-dispatch` to drain with the consent gate
applied. All server-side, by design — and the old edge function did no
authorisation at all, so wiring it to a live transport would turn a dead relay
into a spam and phishing vector.

## What changed

- The SDK injector and its `dns-prefetch` are gone from `index.html`, with a
  tombstone comment saying why they must not come back.
- The four OneSignal-only methods are gone, along with `ONESIGNAL_APP_ID` and
  the `IdentityDNA` call.
- `sendToUsers()` is now a single explicit failure that calls `reportError` on
  **every** dropped notification, with its category and title, so the flows that
  are silently not notifying anybody show up in monitoring instead of depending
  on somebody reading a console on the right screen. The unreachable code and
  the pointless preference query are gone.
- The class is kept rather than deleted: the recipient, the category and the
  exact copy each flow wants are recorded in it, and that is most of the
  specification for the replacement. Deleting it would leave nothing to port.

Pinned by two new assertions in `tests/club-arena-can-subscribe-to-push.test.ts`,
matched against code with comments stripped — the tombstones name what was
removed, and a test that cannot tell a warning from the thing it warns about
would fail on its own explanation.

## Still open — #1498

Measured by grouping `notifications` by type over 30 days, these flows have a
server-side origin and work: `waitlist_seat_open`, `friend_request`, `system`,
`page_completion_nudge`, `union_invoice`, and `settlement` (1 row in 30 days).

These do not, and are what the eight dead call sites were for: **tournament
start / result, achievement unlocks, club announcements, wallet credit and
cashout, disputes**. Each needs its notification raised from the trusted context
that already performs the action. That is a per-flow decision about recipients,
copy and consent category, and it touches money paths — it is Dan's call, not an
agent's, so it is written down rather than guessed at.
