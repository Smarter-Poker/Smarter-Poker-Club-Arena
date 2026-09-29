# 2026-09-28: The owner classifier covers the settlement problem and push-off notices

## What was wrong

`public.fn_is_owner_operational_notification` is the database's answer to "is
this notification to the owner account operational". Every layer of store-only
delivery (`20260927235053`, held, #5512) asks it: the capture that delivers the
row to the Production Alerts task and writes no personal row, the authority
trigger that refuses `anon` and `authenticated` writers, the push mirror's
`WHEN` clause, and the detector that records a row reaching the inbox anyway.
Two operational notices were not in it, so every one of those layers let them
through to the owner's inbox and phone:

1. **smarter-poker-workers' weekly auto-settlement problem notices**: type
   `settlement`, titled `Weekly player P&L needs review`,
   `Weekly player P&L failed` or `Union rule violation detected`
   (`src/routes/auto-settlement.ts`, `notifyUnionSettlementProblem`). The owner
   account holds 3 (2026-08-24, 2026-09-07, 2026-09-14); 2 were pushed to his
   phone (`push_outbox` status `sent`), 1 was skipped.
2. **World Hub push-health's staff notice**: type `system`, titled
   `Push Notifications Are Off` (`pages/api/cron/push-health.js`). The owner
   account holds 1 (2026-08-19, its `data` SQL `NULL`), never pushed.

The workers and World Hub pull requests stop those senders addressing the owner.
Two reviewers asked for the invariant in the database as well, so that no other
writer can do it either.

## The fix (migration 20260928171444, HELD, stacked on #5512)

1. **Classifier.** For the owner account only:
   - type `settlement` whose title, ASCII case and whitespace folded, is one of
     the three problem titles, or whose data carries the route's marker
     (`component` `workers.auto-settlement` and `alertname`
     `UnionPlayerPnlNeedsReview`, `UnionPlayerPnlFailed` or
     `UnionRuleViolation`);
   - type `system` whose title, folded the same way, is
     `push notifications are off`.

   Nothing else moves: the route's business notices (`Commission Received ...`,
   `Settlement Complete ...`) carry neither title nor marker, Club Arena's
   `Cash-Out Request` and every other settlement notice stay personal, the two
   system titles classified before stay exact, and no other recipient is
   classified. The owner, ACL, settings, `IMMUTABLE` and `PARALLEL SAFE` are
   kept.

2. **Existing rows.** Once classified, the owner's rows of these kinds already
   in his inbox are operational originals with no store copy. Each is preserved
   exactly as the capture would have recorded it, by one call of the existing
   bounded history intake `fn_capture_owner_notification_history`
   (`20260916111614`): a destination holding the complete original, rendered in
   UTC like every captured original, and its receipt through
   `fn_try_record_owner_notification`, addressed to the fleet task. Every one is
   then proven preserved the way the held cleanup `20260928000622` proves it,
   and one unproven row aborts the migration. No notification row is modified
   or deleted.
3. **No writer races the install.** Right after its `SET LOCAL` lines it takes
   `LOCK TABLE public.notifications IN SHARE MODE`. That waits for every
   transaction already writing a notification and holds off every new writer
   until `COMMIT`. A notice written by a transaction still open when the install
   starts is committed before the rows are read, and preserved with them; one
   written while the install runs waits for it and meets the new classifier.
   Without the lock, a `service_role` insert whose transaction commits across
   the install keeps a personal row that no destination holds (the probe
   reproduces it). Every notification write waits for the install; a lock it
   cannot take within 3 s refuses the install with nothing changed.
4. **Guards.** It refuses unless store-only delivery is installed completely
   (each of #5512's `@live-proof` expressions, verbatim, naming each missing
   piece); unless the classifier is the `20260916111614` text with its owner,
   ACL and settings; unless the intake, recorder and writer are the ones the
   cleanup's proof was written against; and if an index, constraint, default,
   statistics object or materialized view holds one of the classifier's answers
   (an `IMMUTABLE` function changed under a partial index stops finding the rows
   it now classifies). `SET LOCAL standard_conforming_strings = on` sits beside
   `SET LOCAL TimeZone = 'UTC'`, so every literal in it reads the same whatever
   the installer's session: without it, a session with the setting off could
   not parse the install proof's `U&''` literal (the probe shows both).
5. **Install proof**, rolled back: each new kind written to the owner (the
   three titles, a folded title, the marker under another title, the push-off
   notice as written and folded) writes no personal row and one receipted
   destination; `anon` writing one is refused with row-level security's error
   by `zz_authorize_owner_operational_original`; business titles, a near miss of
   each kind, a foreign marker, a non-ASCII case fold, the same titles under
   another type and another recipient are not classified, and the kinds
   classified before still are.

## One fold, three places

The settlement clause is the definition smarter-poker-workers itself uses
(branch `claude/alerts-owner-settlement-notices-routed`, now at `cc9ca07`:
`SETTLEMENT_PROBLEM_CLASSIFIER` and `normalizeTitle` in
`src/lib/unionSettlementAlerts.ts`, which also stamps the marker on every
problem notice it writes; its documentation of the SQL fold already uses the
`E''` spelling below). The push-off title uses the same fold, so a copy edit of
its case or spacing stays classified too.

- **ASCII-only folding** (`translate`, not `lower()`), so SQL and JavaScript
  fold every string identically whatever the collation (production's is
  `en_US.UTF-8`). A title with a non-ASCII capital (U+0130, a dotted capital I,
  in place of the `I` of `FAILED`) is not folded here or in the mirrors.
- **The whitespace class is `E'[\\t\\n\\v\\f\\r ]+'`, not
  `'[\t\n\v\f\r ]+'`.** A SQL function body is lexed in the calling session. In
  a session with `standard_conforming_strings` off, the plain literal is read as
  an escape string, `\v` becomes the letter `v`, and `review` and `violation`
  fold to `re iew` and ` iolation`, so an unmarked problem notice would not be
  classified. The `E''` spelling gives the same regular expression under either
  setting.

Why folded titles and the marker rather than exact titles: a copy edit to a
title's case or spacing, or any new title that still carries the marker, stays
classified; the three production settlement rows, written before the marker
existed, match by title.

## Install order: documented, and correct the other way too

The cleanup removes whatever this classifier says is operational when it runs,
and refuses any such row that has no destination. This migration gives every
row it newly classifies a destination and receipt. The documented order:

1. `20260927235053` (store-only delivery), complete. Before it, a classified row
   still gets a personal row, so this refuses.
2. **This migration**, outside :50-:03 UTC.
3. The held cleanup `20260928000622`, although its version is lower. It then
   proves and removes these rows with the rest: the probe runs the real cleanup
   after this migration and every `@live-proof` holds.

Installed the other way round, the cleanup removes the operational originals it
knows and never runs again. This migration then still installs and preserves
every row it newly classifies (destination and receipt), but nothing is left
to remove them: they stay in `public.notifications`. It records them for the
fleet task as `OwnerOperationalOriginalsLeftAfterCleanup`
(`owner-inbox-routing-guard`, one event with the row ids and
`payload.target_task_id`), raises a `WARNING`, and its `@live-proof` 3 stays
false until a held migration removes them, each once proven preserved, as the
cleanup does. The probe runs this order with the real cleanup too, and then
shows a new marked notice delivered store-only.

## Detection

- `zz_owner_operational_original_reached_personal_inbox` (#5512) fires on this
  classifier, so it now records either kind reaching the personal inbox for the
  fleet task, and the push mirror's `WHEN` never pushes one. The probe proves
  both with the capture disabled.
- Installed after the cleanup, the install itself records
  `OwnerOperationalOriginalsLeftAfterCleanup` (above).
- Three `@live-proof` lines: the post-image md5; no owner row the classifier
  covers without its destination and task receipt; and false while the
  cleanup's removal record exists and an owner row the classifier covers is
  still in `public.notifications`. `check-migrations-are-live.mjs` evaluates
  them for a migration production recorded under another name; one recorded
  under its own name is matched by name and its proofs are not asked, which is
  why the install records the other order itself.
- `tests/the-owner-classifier-keeps-its-operational-kinds.law.test.ts` (run by
  the unit suite on every pull request that touches `supabase/migrations`)
  reads the newest definition of the classifier wherever it would run - any
  case, quoted or not, at the top level, in a `DO` block or an `EXECUTE`
  string, never in a comment - and fails unless it is still owner-only, keeps
  `engine_break_recovered`, the folded push-off comparison, the settlement
  titles and the marker, spells no backslash in a plain literal, and is not
  dropped or renamed later.

## Production, read-only (2026-09-28 16:57Z and 20:13Z, 2026-09-29 00:04Z)

- Classifier md5 `8c2c62359d92dcbd3b3621a762b981ca` (prosrc
  `e0743616164c810fac5c9a0af137acfe`); PostgreSQL 17.6, UTF8, `en_US.UTF-8`,
  `standard_conforming_strings` on. Store-only delivery and the cleanup are not
  installed; nothing stored depends on the classifier. The post-image is
  `30553a82783e28037aa884c85f203808` (prosrc
  `a98a6f3406a8ae853534dd240d19a374`).
- The post-image predicate, evaluated inline over every notification of the
  owner and every `system` and `settlement` notification: exactly 4 rows newly
  classified, all the owner account's, 0 of any other recipient, and none no
  longer classified: three settlement problem notices (P&L failed 2026-08-24,
  rule violation 2026-09-07, P&L failed 2026-09-14) and one push-off notice
  (2026-08-19, `data` `NULL`).
  None has a destination or a receipt; none is referenced by an accounting key.
- Folded `push notifications are off`: 1 row of the owner's and 8 rows of 2
  other staff accounts, which stay unclassified; no title differs from the
  exact one by case or spacing alone. No other `settlement` notification exists.
- Owner rows classified: 903 at 20:13Z, every one captured; 0 pending
  destinations.
- Readers of the classifier: the push mirror's trigger `WHEN`,
  `fn_capture_owner_notification_destination`,
  `fn_capture_owner_notification_history` and
  `fn_try_record_owner_notification`; after #5512 also its authority and
  detector triggers. No index, constraint, view or policy depends on it.

## Other readers and pins

- **Club Arena**: `scripts/ci/probes/production-alert-core/inputs/owner-notification-component.sql`,
  `owner-notification-qualification.sql`, `notification/inputs/owner-notification-catalog-postimage.sql`
  (prosrc pin `e0743616...`), `tests/fixtures/union-provider-preimages-20260917/`
  and `tests/fixtures/tournament-fee-lifecycle/current-settlement-catalog.json`
  are dated qualification inputs for `20260916111614`, bound by sha256 and built
  from the component, not from migrations. They describe the pre-image and are
  left as they are; none asserts these kinds either way.
  `scripts/ci/supabase-schema-manifest.json` names the function, whose signature
  does not change.
- **World Hub**, after this is installed (reported here, not built):
  - `src/lib/notifications/ownerOperationalClassifier.mjs` gains, for the owner
    only, the settlement clause and the folded push-off comparison with the same
    fold: `A`-`Z` mapped one by one (never `toLowerCase()`), every run of tab,
    newline, vertical tab, form feed, carriage return or space collapsed to one
    space, then spaces (only) trimmed from both ends;
    `src/lib/notificationVisibility.mjs` follows through `isOwnerOperationalRow`;
  - `src/lib/push/operational-push-routing.mjs`'s queued-push PostgREST filter
    gains a superset for both kinds (push rows carry no data, so only the title
    half applies), the JavaScript classifier deciding;
  - the parity tests (`operational-push-routing`,
    `owner-operational-realtime-feed-visibility`,
    `operational-notification-destination`) gain the cases;
  - `supabase/components/owner-operational-notification-destination.sql`, with
    its qualification script and manifest, still carries the `20260916111614`
    classifier and becomes the post-image;
  - push-health (branch `claude/alerts-push-health-owner-alerts-store-episodes`
    at `0e04e2b08`) already windows captured originals by when they were
    written, so this install's capture of the 2026-08-19 notice does not fire
    its detector, and its `PUSH_HEALTH_NOTICE_TITLES` comment already says this
    migration adds the third title.

## Regression proof

`scripts/dev/probe-owner-classifier-settlement-problems.sh`, run by
`.github/workflows/owner-classifier-settlement-problems.yml` on a throwaway
PostgreSQL built from #5512's fixture plus the production push mirror
(`scripts/dev/fixtures/owner-classifier-settlement-problems/`), every function and
trigger pinned to production's md5, then the real store-only migration:

- **Red** without this migration: the owner's settlement problem notice and
  `Push Notifications Are Off` reach his inbox and `push_outbox`, and none of his
  6 rows of these kinds is a cleanup candidate.
- **Necessity**: the classifier alone leaves 6 originals with no store copy; a
  capture rendered from an America/Chicago session is not provable in the
  cleanup's UTC proof; with the plain whitespace literal, a writer session with
  `standard_conforming_strings` off is not classified; without its
  `SET LOCAL standard_conforming_strings = on`, an installer session with the
  setting off cannot install; without the `SHARE` lock, a `service_role` writer
  open across the install commits after it with a personal row and no
  destination (`@live-proof` 2 false).
- **Refusals**, each changing nothing: without store-only delivery, a partial
  install, a changed classifier source or ACL, a changed intake, an index on the
  classifier, a notification writer holding its lock past `lock_timeout`, a
  second run.
- **Green**, installed from an America/Chicago session: every assertion above,
  plus each kind written to the owner (marked as the route now writes it,
  unmarked, folded, the marker under another title, from a session with
  `standard_conforming_strings` off, the push-off notice as written and folded,
  with `data` `NULL`) routed with no personal row and no push, a marked one filed
  under its alertname and severity; no notification or `push_outbox` row
  changed; business titles, near misses (`Push Notifications Are Offline`
  included) and other recipients (a folded push-off included) unchanged; `anon`
  and `authenticated` refused by the authority trigger; the preserved rows
  masked for the owner; the detector recording a capture bypass.
- **Lock**: a writer open when the install starts is waited for and preserved
  with the rest; one that starts while the install waits is delivered
  store-only.
- **Order**: this, then the held cleanup, leaves no owner-operational row and
  every `@live-proof` true; the cleanup first, then this (from a session with
  `standard_conforming_strings` off), installs, preserves, records the rows left
  and leaves `@live-proof` 3 false, and a new marked notice is then delivered
  store-only. With the cleanup's file (in the tree or
  named by `OWNER_INBOX_CLEANUP_MIGRATION`) both orders run it; without it, the
  cleanup's per-row proof is asserted and a stand-in for its removal proves the
  other order.
