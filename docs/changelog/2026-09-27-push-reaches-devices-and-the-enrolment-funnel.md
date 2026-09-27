# Push Reaches Devices, And The Enrolment Funnel Is Measured (2026-09-27)

Status: built on `feat/push-reach-horse-gate-and-prompts`, draft PR, NOT applied
to production. The coordinator applies both migrations after review.

## What was measured (production, read-only, last 7 days)

- `accounting_invoice` push rows: 88 sent to 1 human with a device; 71 skipped
  `no_subscription` to 37 recipients with no device (all horses). The reported
  "97% failure" is 37 of 38 recipients: rows addressed to nobody.
- Other skipped `no_subscription` rows: 93 `bonus` (83 recipients), 7 `system`,
  2 `page_completion_nudge`.
- 4 active `push_subscriptions` against 234 human profiles; no funnel telemetry.

## What changed

1. `20260927221309_push_delivery_is_for_reachable_recipients.sql` replaces
   `fn_mirror_notification_to_push_outbox` (preimage md5
   `37d724277900f53d00db14fb3c5cd04d`, postimage
   `4c36223326ba037a1e61f813f509a491`). The predicate is REACHABILITY, never
   species (CLAUDE.md 10.5, the same ruling as 20260912050723): the accounting
   branch still writes its durable receipt but born `skipped/no_subscription`
   when the recipient has no active device; the ordinary branch writes nothing.
   The owner gate from 20260927143752 runs first and is untouched.
   The request asked for an `is_horse` gate; that was not built, because 10.5
   forbids it and reachability gives horses the identical outcome.
2. `20260927221335_push_prompt_events_record_the_enrolment_funnel.sql`:
   `push_prompt_events` (insert-own via RLS, user_id and created_at stamped
   server-side, 200 rows per user per day, no client SELECT) and
   `fn_push_prompt_funnel(days)` for admins / the engine.
3. Client: `pushPromptPolicy.ts` (pure offer + cooldown logic),
   `pushPromptTelemetry.ts`, `enablePush({ surface })` records outcomes,
   FirstRunPushPrompt and PushEnableBanner record shown / declined, and the
   banner is placed in context (cashier 7 day cooldown, cashier receipt and
   cash-out request 3 days, tournament registration 3 days). iOS outside the
   Home Screen app gets Add To Home Screen guidance instead of an ask.

## Proof

- `scripts/dev/test-accounting-push-bridge.sh`: the full chain plus a red
  control that runs the new regression on the previous body and requires it to
  fail on the horse-with-no-device assertion.
- `scripts/dev/test-push-prompt-events.sh`: RLS, grants, cap, funnel reader.
- `tests/a-mirrored-push-needs-a-device.law.test.ts`,
  `tests/unit/pushPromptPolicy.test.ts`, `tests/components/PushEnableBanner.test.tsx`.

## Round 2 (owner UI review): the offer is a painted console

The first contextual banner was flat ink with bare lit words and was rejected.
In context the offer is now its own `SpadeConsole` with plates (the chassis
for "a message and two actions"): title and eyebrow in the painted head, a
painted Off / Install pill, copy on the glass, Not Now on the steel plate and
Turn On on the lit blue plate. It is placed BESIDE the console it relates to,
never nested in another console's glass: above the Trade cashier console, under
the Transaction Receipt console inside the same scrolling dialog, above the
classic cashier console after a cash-out request. Diamond crest on money
surfaces. On Game Details it is the first item of the scrolling Details panel
with the flat head (the panel shell already carries a centred crown notch), so
it scrolls away instead of shrinking the panel. The Notifications page door
keeps its 2026-09-14 inked form, byte for byte as on main.

Pre-existing, not from this branch: on the Trade cashier the "0 Available · 0
Selected" line under Claim Back / Send Ticket / Send Out is clipped by the
sticky action bar. Rendered with the offer suppressed (identical to main,
whose CashierTradePage differs from this branch only by the offer lines) it
clips the same way.

## Round 3: the head's glass is solid

Two defects on the Game Details offer (a white sliver right of the pill, hard
cut ends on the header rule) had one root: every spade-console head
(top, top-flat, top-diamond, top-vip, top-club) is transparent inside its
rails at rows 160-271 beside the pill slot and rows 318-347 under the rule,
and the kit only laid the 2026-09-23 glass layer under the body and the foot.
Over black nobody saw it; over the Details panel's painted shell, the shell
showed through. `.sc__head` now carries the same #0a0b0d glass under its art
(x 74-923, from row 98 down), restated on every crest override, pinned in
`tests/unit/theConsoleGlassIsSolid.test.ts` against the art's own alpha.
Remaining, not changed: the right rail of the master has a painted 10px
groove (x 946-956) that is transparent in head and body alike.
