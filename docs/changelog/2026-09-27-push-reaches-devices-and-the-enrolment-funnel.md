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
