# 2026-10-05: four forward migrations that finish the launch list

Four root fixes, each a pinned-preimage patch of the live function, each in
its own transaction. Every number below was read from production on
2026-10-05.

1. **`20261005111107` The overpay ratchet does not count a registration
   refund as a prize.** The critical `fn_ca_ratchet_watch` incident of
   00:29 UTC (8 events "overpaid") was a detector defect: on all nine events
   in the 10-day window the excess equalled that event's `refund` credits to
   the cent, and conservation held on each. `fn_ca_prize_overpay_unexplained`
   now excludes `refund` beside `bounty`. The migration asserts the count is
   0 and closes the incident through `fn_ca_incident_action`.

2. **`20261005111111` Video search answers through the library policy.**
   Closes #6082. `search_video_learning` becomes SECURITY INVOKER. Its only
   table already has an anon/authenticated SELECT policy with the same
   eligibility predicate the function applies, so callers see the same rows
   and RLS now stands behind the search.

3. **`20261005111115` A guarantee overlay locks the bank without blocking
   foreign keys.** The overlay half of `20260929071925`, which was merged and
   never installed. Three `FOR UPDATE` bank locks become `FOR NO KEY UPDATE`,
   matching the start-readiness guard in the same transaction.

4. **`20261005111120` Retention prunes an unattached certification hand.**
   Replaces `20260926151328`, which was merged and never installed (its full
   body would revert `20261002082452`) and which would have kept the leaked
   daily-missions fixtures for ever by classifying their empty player list as
   human. Eight such rows exist; the ordinary retention job removes them as
   each passes `horse_retention_days`.

Both superseded files are marked in `scripts/ci/applied-migration-aliases.json`.
