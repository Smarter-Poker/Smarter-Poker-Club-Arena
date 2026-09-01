# 2026-08-31 — Phase 8 of 8: the small closables

Three items. **Two were already closed by other people**, and the honest work was
verifying that rather than re-doing it. The third was still live.

## 1. #997 — the vestigial Vercel project: ALREADY GONE

`club-arena` (`prj_tmZtfoqDmUFwusuOiPivr2nM52QM`) returns **404**, and it is
absent from the team's 15 projects. Production is served by `hub-vanguard`
(`prj_op66GkZyZcygXQKm76iyycfVFAQx`), which is what the World Hub's
`.vercel/project.json` points at. Nothing to do; issue closed with that evidence.

## 2. Migration reconciliation: ALREADY BUILT, AND BUILT BETTER

Another agent shipped the **reverse direction** today —
`fn_ca_applied_migrations`, `scripts/ci/check-applied-migrations-are-recorded.mjs`
and its own workflow — and found the sharper problem: **41 of 90 migrations
applied since 14:00 UTC had no file on `origin/main`.** A database with features
the repo does not record is the one that cannot be rebuilt.

Verified rather than assumed:

- The gate is **wired** (`.github/workflows/applied-migrations-recorded.yml`), so
  it is not a guard with nowhere to run.
- It can **actually fail**: it uses `set -o pipefail` and reads `PIPESTATUS[0]`,
  closing the `$?`-after-a-pipeline trap that has bitten this estate before.
  `check-migrations-applied` in `ci.yml` sets `pipefail` too.
- The case flagged in the previous phase, `one_buy_in_band_and_the_rest_are_derived`,
  **has now been applied**: `min_buy_in_bb`, `max_buy_in_bb`, `min_buyin` and
  `max_buyin` are `GENERATED ALWAYS` in production.

**And the forward direction is healthier than a naive count suggests.** Comparing
repo filenames against `schema_migrations.version` shows 48 migrations from the
last two days as missing. Comparing by NAME, 34 of those were applied under a
different version, because the MCP apply path assigns its own timestamp and the
filename version never matches. Of the 14 that remain, every declared object
exists in production except one: `fn_sync_club_join_request`, which a later
migration (`20260831163500_remove_dead_club_join_requests_dependency`)
**deliberately drops**, because the trigger behind it was rolling back every club
creation with 42P01.

Net forward drift: **zero**. `schema_migrations.version` is not a usable
reconciliation key in this estate, which is exactly why the gate compares against
the schema manifest instead.

## 3. #1498 — the unauthorised push relay: CLOSED

The eight client call sites were already gone. What the issue says must not be
left in place was **still ACTIVE in production**.

`send-push-notification` read `userIds`, `title`, `message` and `url` straight
from the request body and pushed them, with **no authorisation of any kind**,
deployed with `verify_jwt: true`. Any signed-in player could aim arbitrary text
and an arbitrary link at arbitrary people. It was harmless only because OneSignal
was removed on 2026-08-19, and "the vendor left" is not a security control. The
dangerous repair is the obvious one: somebody fixing "push is broken" repoints it
at a working transport and turns a dead relay into a live one.

**Deployed a 410 refusal** (version 21) that names the path which works:
`notifications` -> `trg_mirror_notification_to_push_outbox` -> `push_outbox` ->
`/api/cron/push-dispatch`, with the consent gate applied to every row.

Verified against production, not asserted:

| Probe                                              | Result                                |
| -------------------------------------------------- | ------------------------------------- |
| Invocations in the preceding 24 hours              | **zero**, confirmed before the change |
| POST with the exact payload the old relay accepted | **HTTP 410** with the explanation     |
| CORS preflight                                     | HTTP 200, unchanged                   |

`tests/unit/theRetiredRelayStaysRetired.test.ts` pins it, proven red by putting
the relay back: four of its five tests fail the moment a `fetch` to
`onesignal.com`, a `userIds` read, or a 200 response reappears. It asserts on the
**endpoint**, not the vendor's name, because the 410 body says who it was and why
and that is worth keeping.

**Deliberately not done:** `src/services/PushNotificationService.ts` stays. It is
369 lines, every method already returns false, and its only live reference is a
barrel re-export. Six test files mock it, several on money paths
(`CashoutService`, `cashout-escrow-flow`, `roleScopedCashier`), mostly to assert
those flows do **not** push. Deleting it means rewriting money-path tests to
remove guards that still say something true, for no behavioural gain now that the
relay refuses. Dan's call, 2026-08-31.

**Left for a human:** deleting the function object itself is a one-click Supabase
dashboard action. The MCP surface can deploy a function but cannot delete one, so
the capability is gone while the shell remains.

## Verified

765 files / 10,686 tests pass. `tsc --noEmit` exit 0. House gates OK.
