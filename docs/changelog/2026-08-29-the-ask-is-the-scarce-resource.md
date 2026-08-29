# 2026-08-29 — The ask is the scarce resource

World Hub #929 fixed the reason the root service worker could never install.
This is the Club Arena half of what that revealed.

## The numbers, measured after the worker was fixed

```sql
select count(distinct user_id) from push_subscriptions where is_active;  --> 1
select count(*) from profiles;                                           --> 1023
select count(*) from push_outbox
  where status = 'skipped' and failure_reason = 'no_subscription'
  and created_at > now() - interval '7 days';                            --> 2437
```

One subscribed user out of a thousand. The server side was fine. The client
side was fine. The problem is that `FirstRunPushPrompt` asks **once per account
per browser, permanently**, and for ten days it had been asking against a
worker that could not install — so a player who tapped Enable, hit "The
notification service worker did not start", and gave up had
`sp_firstrun_notif_<uid>` written anyway.

Shipping the fix without this changelog's changes would have fixed push for an
audience that could never be asked again.

## What changed

**One re-offer.** `KEY_PREFIX` is now `sp_firstrun_notif_v2_`, in step with the
World Hub's copy of the same key (same origin, same device, one subscription
behind both apps — if one app re-offers and the other does not, a player gets
asked twice about the same thing). This is not a lever to pull whenever
enrolment looks low: bumping it again re-asks a thousand people who already said
no, and the honest reading of a second no is that they meant the first one.

**Only an answer spends the ask.** `markDone()` used to run unconditionally
after `enablePush()`, so a _technical_ failure — worker still installing, a
dropped VAPID fetch, a flaky minute of signal — recorded the one prompt as
spent, for somebody who was in the middle of saying yes. Success and a DENIED
permission are real answers and are still recorded; anything else leaves the
door open for the next session.

Pinned by two new assertions in `tests/club-arena-can-subscribe-to-push.test.ts`.

## The footer law, widened

`tests/footer-stays-on-the-footer.law.test.ts` now scans all of `src`, not just
`src/pages` + `src/styles` + `src/components/layouts`.

The narrow scope was drawn around "things that are ancestors of the bottom nav
today", and within hours it had already missed one — `.lobby-table-wrap` in
`src/components/lobby/LobbyTable.css`. That one is harmless. The point is that
the scope was a judgement about a component tree that moves, and this bug is
invisible in Chrome, invisible in jsdom, and only shows up on a phone after it
ships. Cheaper to ban the declaration everywhere.
