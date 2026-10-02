# Push enrollment: one registration per device, asks at meaningful moments

Measured 2026-09-27 on production: 62 `push_subscriptions` ever, 4 active across
2 accounts, 218 human profiles. Since 2026-09-01, 99.8% of `push_outbox` rows
skipped as `no_subscription` were addressed to horses, which have no device; the
human gap is enrollment.

- Club Arena enrolled on the root `/sw.js` registration while the World Hub
  enrolled on `/push/sw.js` (scope `/push/`) with the same shared deviceId, so
  each enrollment or hourly sync retired the other app's row as
  `superseded_same_device`. Club Arena now uses `/push/sw.js` and hands over a
  legacy root subscription (replaced on the server, then unsubscribed).
- The silent sync sends `repairOnly`; the hub refuses (409) to enroll an
  account that has no live row on this device, so no account is enrolled
  without its own tap.
- `src/lib/pushNudgePolicy.ts` (same behaviour and localStorage ledger as the
  hub's `enrollment-nudge.mjs`): asks after joining a club and at a rakeback
  receipt, Not Now cools down 7 then 30 days, three end the contextual asks,
  one ask a day, never when on, off or blocked, never the owner for receipts.
- Tests: `tests/push-enrollment-flow.test.ts`,
  `tests/components/FirstRunPushPrompt.test.tsx`, and the browser gate
  `npm run test:e2e:push-enrollment` (Chromium, notifications granted).
